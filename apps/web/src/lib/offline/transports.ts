/**
 * The two seams that make the rest of the app offline-capable without knowing
 * it exists.
 *
 * `src/lib/reader/progress.ts` and `src/lib/notes/transport.ts` each expose a
 * transport interface plus a setter. Swapping them here — once, from
 * `OfflineBootstrap` — routes every reading position, chapter-read flag and
 * note through the sync queue. The reader's debounce, its `pagehide` flush and
 * every call site stay exactly as they were.
 *
 * Policy in both transports: try the real request first whenever the browser
 * thinks it is online (so an online write still lands immediately, with the
 * server's response), and queue on any failure — offline, a flaky radio, a
 * captive portal, or the service worker's own 503. Neither transport rejects
 * once the op is queued: a queued write *is* a successful write from the
 * reader's point of view, and surfacing it as an error would produce a toast
 * on every page turn in airplane mode.
 */
import type { NoteTransport } from "@/lib/notes/transport";
import type { UpsertNoteInput } from "@/lib/contracts/notes";
import type { NoteView } from "@/lib/contracts/notes";
import type { SyncOp } from "@/lib/contracts/offline";
import {
  httpProgressTransport,
  setProgressTransport,
  type ProgressTransport,
} from "@/lib/reader/progress";
import { setNoteTransport } from "@/lib/notes/transport";
import { enqueueSyncOp, newOpId } from "@/lib/offline/sync-queue";

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Progress writes: position and chapter-read.
 *
 * `savePosition` keeps the `keepalive` flag the unload flush relies on. When
 * that flush happens while offline the IndexedDB write races the page being
 * torn down; browsers normally let it finish, and the cost of losing it is one
 * page of reading position.
 */
export const queueTransport: ProgressTransport = {
  async savePosition(position, options) {
    if (isOnline()) {
      try {
        await httpProgressTransport.savePosition(position, options);
        return;
      } catch {
        // fall through to the queue
      }
    }
    const op: SyncOp = {
      type: "position",
      id: newOpId(),
      seriesId: position.seriesId,
      chapterId: position.chapterId,
      pageIndex: position.pageIndex,
      at: nowIso(),
    };
    await enqueueSyncOp(op);
  },

  async setChapterRead(chapterId, read) {
    if (isOnline()) {
      try {
        await httpProgressTransport.setChapterRead(chapterId, read);
        return;
      } catch {
        // fall through to the queue
      }
    }
    const op: SyncOp = {
      type: "chapterRead",
      id: newOpId(),
      chapterId,
      read,
      at: nowIso(),
    };
    await enqueueSyncOp(op);
  },
};

/**
 * Note writes. `upsert` returns `null` when the note was queued: the contract
 * already allows that, and the notes UI renders its own optimistic copy.
 *
 * `remove` is deliberately *not* queued. `syncOpSchema` has no delete op, and
 * inventing one inside the note payload would be a private protocol between
 * this file and a module another agent owns. Deleting a note offline therefore
 * fails loudly, which is the honest answer.
 */
export const noteQueueTransport: NoteTransport = {
  async upsert(noteId: string, input: UpsertNoteInput): Promise<NoteView | null> {
    if (isOnline()) {
      try {
        return await directNoteUpsert(noteId, input);
      } catch {
        // fall through to the queue
      }
    }
    await enqueueSyncOp({
      type: "note",
      id: newOpId(),
      noteId,
      at: nowIso(),
      note: input as unknown as Record<string, unknown>,
    });
    return null;
  },

  async remove(noteId: string): Promise<void> {
    const response = await fetch(`/api/notes/${noteId}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Deleting note ${noteId} failed with ${response.status}`);
    }
  },
};

/**
 * Plain `fetch` rather than `@/lib/api-client`, so this file has no opinion
 * about the notes module's client wrapper (which it does not own).
 */
async function directNoteUpsert(noteId: string, input: UpsertNoteInput): Promise<NoteView | null> {
  const response = await fetch(`/api/notes/${noteId}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Saving note ${noteId} failed with ${response.status}`);
  }
  if (response.status === 204) return null;
  return (await response.json()) as NoteView;
}

/** Called once, from `OfflineBootstrap`. Idempotent. */
export function installOfflineTransports(): void {
  setProgressTransport(queueTransport);
  setNoteTransport(noteQueueTransport);
}
