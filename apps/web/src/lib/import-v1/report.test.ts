import { describe, expect, it } from "vitest";
import { V1_IMPORT_TABLES, type V1ImportReport } from "@/lib/contracts/import-v1";
import { formatBytes, formatReportText } from "./report";

function report(overrides: Partial<V1ImportReport> = {}): V1ImportReport {
  const counts = Object.fromEntries(
    V1_IMPORT_TABLES.map((table) => [
      table,
      { read: 0, created: 0, reused: 0, updated: 0, skipped: 0 },
    ]),
  ) as V1ImportReport["counts"];
  counts.series = { read: 5, created: 4, reused: 1, updated: 0, skipped: 0 };
  return {
    runId: "run-1",
    dryRun: false,
    mode: "copy",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:12.000Z",
    durationMs: 12_000,
    counts,
    content: { sources: 3, copied: 3, linked: 0, failed: 0, bytes: 2048, manifestsMissing: 1 },
    needsPlugin: [{ site: "mangadex", seriesCount: 2 }],
    invites: [
      {
        email: "a@example.com",
        displayName: "Alice",
        url: "https://kiri.test/register?invite=tok",
        expiresAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    warnings: [
      { code: "MANIFEST_MISSING", message: "no manifest", v1Table: "series_rips", v1Id: "rip-1" },
    ],
    ...overrides,
  };
}

describe("formatBytes", () => {
  it("scales through the units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
  });
});

describe("formatReportText", () => {
  it("renders the counts table, content line, plugins, invites and warnings", () => {
    const text = formatReportText(report());
    expect(text).toContain("Kiri 1.x import");
    expect(text).toContain("run run-1");
    for (const label of ["Users", "Series", "Chapters", "Pages", "Job history"]) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/Series\s+5\s+4\s+1\s+0\s+0/);
    expect(text).toContain("3 rip directories, 3 copied, 0 linked, 0 failed, 2.0 KB transferred");
    expect(text).toContain("mangadex");
    expect(text).toContain("https://kiri.test/register?invite=tok");
    expect(text).toContain("MANIFEST_MISSING [series_rips rip-1]: no manifest");
  });

  it("says loudly when nothing was written", () => {
    expect(formatReportText(report({ dryRun: true }))).toContain("DRY RUN (nothing was written)");
  });
});
