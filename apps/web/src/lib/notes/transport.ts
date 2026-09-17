/**
 * Browser-side transport for note writes. Defaults to the API; the offline
 * sync queue (Phase 5) swaps it with `setNoteTransport` so notes authored
 * offline are queued and replayed. Owned by the notes module; the seam shape
 * must stay stable.
 */
import { api } from "@/lib/api-client";
import type { NoteView, UpsertNoteInput } from "@/lib/contracts/notes";

export interface NoteTransport {
  /** Idempotent upsert keyed by the client-minted note id. */
  upsert(noteId: string, input: UpsertNoteInput): Promise<NoteView | null>;
  remove(noteId: string): Promise<void>;
}

const directTransport: NoteTransport = {
  upsert: (noteId, input) => api.put<NoteView>(`/api/notes/${noteId}`, input),
  remove: (noteId) => api.delete<void>(`/api/notes/${noteId}`),
};

let current: NoteTransport = directTransport;

export function getNoteTransport(): NoteTransport {
  return current;
}

export function setNoteTransport(transport: NoteTransport | null): void {
  current = transport ?? directTransport;
}

export function newNoteId(): string {
  return crypto.randomUUID();
}
