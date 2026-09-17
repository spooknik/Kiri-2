/**
 * Double-page pairing.
 *
 * A "spread" is what the screen shows at once: one page (the cover, or the odd
 * page left over at the end) or two side by side. `coverFirst` shows page 1
 * alone so every later spread is the even/odd pair the book was printed as;
 * turning it off pairs from the very first page. In `rtl` the two pages of a
 * spread swap visual position, so the page you read first sits on the right.
 *
 * Positions here are 0-based indexes into the page array — the same units the
 * reader's `pageIndex`, the URL's `page` (minus one) and `ReadingPosition` use.
 * `PageView.index` is 1-based and is only ever shown to the reader.
 */
export interface Spread<T> {
  /** Items in visual left-to-right order (already direction-adjusted). */
  items: T[];
  /** 0-based positions in reading order. */
  pageIndexes: number[];
  /** Lowest position in the spread. */
  firstPageIndex: number;
}

export interface PairingOptions {
  coverFirst: boolean;
  direction: "ltr" | "rtl";
}

/**
 * Groups pages into spreads. Pure and total: an empty list yields no spreads,
 * and every page appears in exactly one spread.
 */
export function buildSpreads<T>(
  pages: readonly T[],
  { coverFirst, direction }: PairingOptions,
): Spread<T>[] {
  const spreads: Spread<T>[] = [];
  if (pages.length === 0) return spreads;

  const groups: number[][] = [];
  let cursor = 0;
  if (coverFirst) {
    groups.push([0]);
    cursor = 1;
  }
  for (; cursor < pages.length; cursor += 2) {
    groups.push(cursor + 1 < pages.length ? [cursor, cursor + 1] : [cursor]);
  }

  for (const pageIndexes of groups) {
    const ordered = direction === "rtl" ? [...pageIndexes].reverse() : pageIndexes;
    const items: T[] = [];
    for (const position of ordered) {
      const page = pages[position];
      if (page !== undefined) items.push(page);
    }
    spreads.push({
      items,
      pageIndexes,
      firstPageIndex: pageIndexes[0] ?? 0,
    });
  }

  return spreads;
}

/** One spread per page, for single-page mode. */
export function singleSpreads<T>(pages: readonly T[]): Spread<T>[] {
  return pages.map((page, index) => ({
    items: [page],
    pageIndexes: [index],
    firstPageIndex: index,
  }));
}

/** Index of the spread containing `pageIndex` (0-based position), else 0. */
export function spreadIndexForPage<T>(spreads: readonly Spread<T>[], pageIndex: number): number {
  for (let index = 0; index < spreads.length; index += 1) {
    const spread = spreads[index];
    if (spread && spread.pageIndexes.includes(pageIndex)) return index;
  }
  return 0;
}
