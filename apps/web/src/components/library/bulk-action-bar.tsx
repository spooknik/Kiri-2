"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, Trash2, X } from "lucide-react";
import { Button, Dialog, Select, useToast } from "@/components/ui";
import { api, type ApiClientError } from "@/lib/api-client";
import {
  READING_STATUSES,
  READING_STATUS_LABELS,
  type BulkSeriesInput,
  type BulkSeriesResult,
  type ReadingStatus,
  type SeriesSummary,
} from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

export type BulkActionBarProps = {
  selectedIds: string[];
  /** The selected `SeriesSummary` rows, used to gate "Delete" to series the user can edit. */
  items: SeriesSummary[];
  /** Called when the user cancels the selection (× button). */
  onClear: () => void;
  /** Called after a bulk action completes (success or error) so the caller can clear selection. */
  onApplied: () => void;
};

/** Fixed action bar shown above the bottom nav while one or more cards are selected. */
export function BulkActionBar({ selectedIds, items, onClear, onApplied }: BulkActionBarProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mutation = useMutation<BulkSeriesResult, ApiClientError, BulkSeriesInput>({
    mutationFn: (input) => api.patch<BulkSeriesResult>("/api/series/bulk", input),
    onSuccess: (result) => {
      toast({
        title: `${result.affected} series updated`,
        description: result.skipped.length > 0 ? `${result.skipped.length} skipped` : undefined,
        tone: result.skipped.length > 0 ? "warning" : "success",
      });
      onApplied();
    },
    onError: (error) => {
      toast({
        title: error.isOffline ? "Couldn't save — you're offline" : "Bulk update failed",
        description: error.isOffline ? undefined : error.message,
        tone: "danger",
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryAll });
    },
  });

  const editableIds = items.filter((item) => item.canEdit).map((item) => item.id);

  function handleSetStatus(status: ReadingStatus) {
    mutation.mutate({ ids: selectedIds, action: { type: "setStatus", status } });
  }

  function handleUntrack() {
    mutation.mutate({ ids: selectedIds, action: { type: "untrack" } });
  }

  function handleDelete() {
    setConfirmDelete(false);
    mutation.mutate({ ids: editableIds, action: { type: "delete" } });
  }

  return (
    <div className="fixed inset-x-0 bottom-[var(--shell-bottom-nav-height)] z-40 border-t border-card-border bg-card/95 px-4 py-3 backdrop-blur-lg">
      <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <CheckSquare className="h-4 w-4 text-primary" aria-hidden="true" />
          <span>{selectedIds.length} selected</span>
        </div>

        <Select
          aria-label="Set status"
          disabled={mutation.isPending}
          defaultValue=""
          onChange={(event) => {
            const value = event.target.value;
            if (value) handleSetStatus(value as ReadingStatus);
            event.target.value = "";
          }}
          className="h-9 w-auto min-w-0"
        >
          <option value="" disabled>
            Set status…
          </option>
          {READING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {READING_STATUS_LABELS[status]}
            </option>
          ))}
        </Select>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={mutation.isPending}
          onClick={handleUntrack}
        >
          Untrack
        </Button>

        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={mutation.isPending || editableIds.length === 0}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Delete
        </Button>

        <button
          type="button"
          onClick={onClear}
          aria-label="Cancel selection"
          className="focus-ring ml-auto flex h-9 w-9 items-center justify-center rounded-md text-muted hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete selected series?"
        description={`This permanently deletes ${editableIds.length} series you can edit${
          editableIds.length !== selectedIds.length
            ? ` (${selectedIds.length - editableIds.length} selected series you can't edit will be skipped)`
            : ""
        }. This can't be undone.`}
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            loading={mutation.isPending}
            onClick={handleDelete}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
