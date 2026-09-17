/**
 * Plain-text rendering of a {@link V1ImportReport}, for the CLI.
 *
 * The admin page renders the same object as HTML; this is the terminal view,
 * so it has to survive a pipe into a file and still be readable — fixed-width
 * columns, no colour, no cursor tricks.
 */
import type { V1ImportReport, V1ImportTable } from "@/lib/contracts/import-v1";

const TABLE_LABELS: Record<V1ImportTable, string> = {
  users: "Users",
  series: "Series",
  libraryEntries: "Library entries",
  sources: "Sources",
  chapters: "Chapters",
  pages: "Pages",
  positions: "Reading positions",
  notifications: "Notifications",
  credentials: "Credentials",
  settings: "Settings",
  jobs: "Job history",
};

const COLUMNS = ["read", "created", "reused", "updated", "skipped"] as const;

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${Math.round(seconds - minutes * 60)} s`;
}

export function formatReportText(report: V1ImportReport): string {
  const lines: string[] = [];
  const heading = report.dryRun
    ? "Kiri 1.x import — DRY RUN (nothing was written)"
    : "Kiri 1.x import";
  lines.push(heading);
  lines.push("=".repeat(heading.length));
  lines.push(`run ${report.runId}`);
  lines.push(`mode ${report.mode}   duration ${formatDuration(report.durationMs)}`);
  lines.push("");

  const labelWidth = Math.max(...Object.values(TABLE_LABELS).map((label) => label.length));
  const columnWidth = 9;
  lines.push(pad("", labelWidth) + COLUMNS.map((column) => padStart(column, columnWidth)).join(""));
  for (const [table, label] of Object.entries(TABLE_LABELS) as [V1ImportTable, string][]) {
    const row = report.counts[table];
    lines.push(
      pad(label, labelWidth) +
        COLUMNS.map((column) => padStart(String(row[column]), columnWidth)).join(""),
    );
  }

  lines.push("");
  lines.push(
    `Content: ${report.content.sources} rip directories, ` +
      `${report.content.copied} copied, ${report.content.linked} linked, ` +
      `${report.content.failed} failed, ${formatBytes(report.content.bytes)} transferred, ` +
      `${report.content.manifestsMissing} manifest(s) missing`,
  );

  if (report.needsPlugin.length > 0) {
    lines.push("");
    lines.push("Sites waiting for a plugin (their sources are NEEDS_PLUGIN):");
    for (const entry of report.needsPlugin) {
      lines.push(`  ${pad(entry.site, 24)} ${entry.seriesCount} series`);
    }
  }

  if (report.invites.length > 0) {
    lines.push("");
    lines.push("Invite links (shown once — copy them now):");
    for (const invite of report.invites) {
      lines.push(`  ${invite.displayName} <${invite.email}>`);
      lines.push(`    ${invite.url}`);
      lines.push(`    expires ${invite.expiresAt}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push(`Warnings (${report.warnings.length}):`);
    for (const warning of report.warnings) {
      const where = warning.v1Table
        ? ` [${warning.v1Table}${warning.v1Id ? ` ${warning.v1Id}` : ""}]`
        : "";
      lines.push(`  ${warning.code}${where}: ${warning.message}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
