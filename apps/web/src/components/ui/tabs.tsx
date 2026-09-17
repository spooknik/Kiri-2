"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type TabItem = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type TabsProps = {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  /** Usually one or more `<TabPanel>`s. */
  children?: ReactNode;
};

/** Accessible tab list with roving tabindex and arrow-key navigation. */
export function Tabs({ items, value, onValueChange, className, children }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  function focusTabAt(index: number) {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']");
    buttons?.[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.disabled);
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex(({ item }) => item.value === value);

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1 + enabled.length) % enabled.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = enabled.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      const next = enabled[nextIndex];
      if (next) {
        onValueChange(next.item.value);
        focusTabAt(next.index);
      }
    }
  }

  return (
    <div className={className}>
      <div
        ref={listRef}
        role="tablist"
        onKeyDown={handleKeyDown}
        className="scrollbar-hide flex items-center gap-1 overflow-x-auto border-b border-card-border"
      >
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={`tab-${item.value}`}
              aria-selected={selected}
              aria-controls={`tabpanel-${item.value}`}
              disabled={item.disabled}
              tabIndex={selected ? 0 : -1}
              onClick={() => onValueChange(item.value)}
              className={cn(
                "focus-ring min-h-11 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                selected
                  ? "border-primary text-primary"
                  : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}

export type TabPanelProps = {
  value: string;
  activeValue: string;
  className?: string;
  children?: ReactNode;
};

export function TabPanel({ value, activeValue, className, children }: TabPanelProps) {
  const hidden = value !== activeValue;
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${value}`}
      aria-labelledby={`tab-${value}`}
      hidden={hidden}
      tabIndex={0}
      className={cn("pt-3", className)}
    >
      {children}
    </div>
  );
}
