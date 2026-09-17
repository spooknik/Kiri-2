"use client";

import { CheckSquare, Search } from "lucide-react";
import { Button, Input } from "@/components/ui";

export type LibraryToolbarProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  selectMode: boolean;
  onToggleSelectMode: () => void;
};

/** Sticky search + "Select" toggle, pinned under the app header. */
export function LibraryToolbar({
  searchValue,
  onSearchChange,
  selectMode,
  onToggleSelectMode,
}: LibraryToolbarProps) {
  return (
    <div className="sticky top-[var(--shell-header-height)] z-30 -mx-4 flex items-center gap-2 border-b border-card-border bg-background/95 px-4 py-2 backdrop-blur-lg">
      <div className="relative flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search library…"
          aria-label="Search library"
          className="pl-9"
        />
      </div>
      <Button
        type="button"
        variant={selectMode ? "primary" : "secondary"}
        size="md"
        aria-pressed={selectMode}
        aria-label={selectMode ? "Exit selection mode" : "Select multiple series"}
        onClick={onToggleSelectMode}
      >
        <CheckSquare className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
