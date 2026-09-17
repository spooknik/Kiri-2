"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CheckCheck, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { AppLink } from "@/components/shell/app-link";
import { ConfirmDialog } from "@/components/series/confirm-dialog";
import { Badge, type BadgeTone } from "@/components/ui";
import { useDeleteChapter, useSetChapterRead } from "@/hooks/use-chapters";
import { cn } from "@/lib/cn";
import type { ChapterListItem, ChapterOrigin, ChapterStatus } from "@/lib/contracts/content";
import { formatBytes } from "@/lib/format";
import { buildReadHref } from "@/lib/reader-url";
import { EditChapterDialog } from "./edit-chapter-dialog";

const STATUS_LABELS: Record<ChapterStatus, string> = {
  PENDING: "Pending",
  DOWNLOADING: "Downloading",
  COMPLETED: "Completed",
  FAILED: "Failed",
  MISSING_FROM_SOURCE: "Missing",
};

const STATUS_TONES: Record<ChapterStatus, BadgeTone> = {
  PENDING: "neutral",
  DOWNLOADING: "primary",
  COMPLETED: "success",
  FAILED: "danger",
  MISSING_FROM_SOURCE: "warning",
};

const ORIGIN_LABELS: Partial<Record<ChapterOrigin, string>> = {
  PDF: "PDF",
  MANUAL: "Manual",
};

export interface ChapterRowProps {
  seriesId: string;
  chapter: ChapterListItem;
  canEdit: boolean;
  onMarkAllReadUpTo: () => void;
  markingAllRead: boolean;
}

export function ChapterRow({
  seriesId,
  chapter,
  canEdit,
  onMarkAllReadUpTo,
  markingAllRead,
}: ChapterRowProps) {
  const setChapterRead = useSetChapterRead(seriesId);
  const deleteChapter = useDeleteChapter(seriesId);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const originLabel = ORIGIN_LABELS[chapter.origin];
  const readable = chapter.status === "COMPLETED" && chapter.pageCount > 0;

  return (
    <li className="flex items-center gap-1.5 py-2.5">
      <button
        type="button"
        onClick={() => setChapterRead.mutate({ chapterId: chapter.id, read: !chapter.read })}
        aria-pressed={chapter.read}
        aria-label={chapter.read ? "Mark as unread" : "Mark as read"}
        className={cn(
          "focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-full border",
          chapter.read
            ? "border-primary bg-primary text-white"
            : "border-card-border text-transparent hover:text-muted",
        )}
      >
        <Check className="h-4 w-4" aria-hidden="true" />
      </button>

      {!chapter.read ? (
        <button
          type="button"
          onClick={onMarkAllReadUpTo}
          disabled={markingAllRead}
          aria-label="Mark all read up to here"
          title="Mark all read up to here"
          className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CheckCheck className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-medium text-foreground">
            {chapter.number !== null ? `Ch. ${chapter.number} ` : ""}
            {chapter.title}
          </p>
          {chapter.volume ? (
            <span className="shrink-0 text-xs text-muted">Vol. {chapter.volume}</span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {chapter.status !== "COMPLETED" ? (
            <Badge tone={STATUS_TONES[chapter.status]}>{STATUS_LABELS[chapter.status]}</Badge>
          ) : null}
          {originLabel ? <Badge tone="neutral">{originLabel}</Badge> : null}
          <span className="text-xs text-muted">
            {chapter.pageCount} page{chapter.pageCount === 1 ? "" : "s"} ·{" "}
            {formatBytes(chapter.bytes)}
          </span>
        </div>
      </div>

      {readable ? (
        <AppLink
          href={buildReadHref(seriesId, chapter.id)}
          className="focus-ring shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
        >
          Read
        </AppLink>
      ) : null}

      {canEdit ? (
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Chapter actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="focus-ring flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground"
          >
            <MoreVertical className="h-4 w-4" aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 z-10 mt-1 w-40 rounded-md border border-card-border bg-card py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setEditOpen(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-surface-2"
              >
                <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setDeleteOpen(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger hover:bg-danger-light"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete
              </button>
            </div>
          ) : null}

          <EditChapterDialog
            open={editOpen}
            onClose={() => setEditOpen(false)}
            seriesId={seriesId}
            chapter={chapter}
          />
          <ConfirmDialog
            open={deleteOpen}
            onClose={() => setDeleteOpen(false)}
            onConfirm={() =>
              deleteChapter.mutate(chapter.id, { onSuccess: () => setDeleteOpen(false) })
            }
            title={`Delete "${chapter.title}"?`}
            description="This permanently removes the chapter and its pages. This can't be undone."
            confirmLabel="Delete chapter"
            loading={deleteChapter.isPending}
          />
        </div>
      ) : null}
    </li>
  );
}
