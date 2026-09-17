"use client";

import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { normalizeTags, parseTagsInput } from "./series-form-utils";

export interface TagInputProps {
  id?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/**
 * Generic comma-delimited tag/chip input: type free text, press comma or
 * Enter (or blur, or paste multiple) to commit chips; backspace on an empty
 * draft removes the last chip. Not series-specific — reusable anywhere a
 * `string[]` of tags is edited. New generic component (ui/ is read-only).
 */
export function TagInput({
  id,
  value,
  onChange,
  placeholder = "Add tags…",
  disabled,
  className,
  ...aria
}: TagInputProps) {
  const [draft, setDraft] = useState("");

  function commit(extra: string) {
    const next = normalizeTags([...value, ...parseTagsInput(extra)]);
    const changed = next.length !== value.length || next.some((tag, i) => tag !== value[i]);
    if (changed) onChange(next);
    setDraft("");
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "," || event.key === "Enter") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      removeAt(value.length - 1);
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-11 w-full flex-wrap items-center gap-1.5 rounded-md border border-card-border bg-card px-2 py-1.5 focus-within:border-primary",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      {value.map((tag, index) => (
        <span
          key={`${tag}-${index}`}
          className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-secondary"
        >
          {tag}
          {disabled ? null : (
            <button
              type="button"
              onClick={() => removeAt(index)}
              aria-label={`Remove tag ${tag}`}
              className="rounded-full text-muted hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
      <input
        id={id}
        type="text"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? placeholder : undefined}
        className="min-w-24 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed"
        {...aria}
      />
    </div>
  );
}
