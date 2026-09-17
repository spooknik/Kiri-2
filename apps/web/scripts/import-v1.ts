/**
 * CLI for the Kiri 1.x importer.
 *
 *   npm run -w apps/web import:v1 -- --v1-db <url> --v1-data <dir> \
 *     [--copy|--link] [--dry-run] [--admin-email you@example.com] \
 *     [--import-jobs=history]
 *
 * Same module as the admin job, different sinks: progress goes to stderr so it
 * can be watched live, the report goes to stdout so it can be piped into a
 * file. The job runner is not involved — this runs `runV1Import` in-process,
 * which is what makes it usable before the app is even started.
 *
 * Exit codes: 0 success, 1 failure (including a failed preflight), 2 usage.
 */
import "dotenv/config";
import { formatReportText } from "@/lib/import-v1/report";
import { runV1Import, type RunV1ImportOptions } from "@/lib/import-v1/importer";
import type { V1ImportMode } from "@/lib/contracts/import-v1";

const USAGE = `Usage: npm run import:v1 -- --v1-db <url> --v1-data <dir> [options]

  --v1-db <url>            Kiri 1.x PostgreSQL connection string (read-only)
  --v1-data <dir>          Kiri 1.x data directory (contains rips/ and covers/)
  --copy                   Copy the rip files into DATA_ROOT (default)
  --link                   Symlink them instead (V1 must be decommissioned)
  --dry-run                Report what would happen; write nothing
  --admin-email <email>    Which 1.x user becomes the admin
  --import-jobs=history    Also import finished 1.x jobs as history
  -h, --help               Show this message
`;

interface ParsedArgs {
  databaseUrl: string;
  dataDir: string;
  mode: V1ImportMode;
  dryRun: boolean;
  adminEmail: string | undefined;
  importJobs: "skip" | "history";
}

class UsageError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  let databaseUrl: string | undefined;
  let dataDir: string | undefined;
  let mode: V1ImportMode = "copy";
  let dryRun = false;
  let adminEmail: string | undefined;
  let importJobs: "skip" | "history" = "skip";

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === "--v1-db") {
      databaseUrl = next(i, arg);
      i += 1;
    } else if (arg.startsWith("--v1-db=")) {
      databaseUrl = arg.slice("--v1-db=".length);
    } else if (arg === "--v1-data") {
      dataDir = next(i, arg);
      i += 1;
    } else if (arg.startsWith("--v1-data=")) {
      dataDir = arg.slice("--v1-data=".length);
    } else if (arg === "--copy") {
      mode = "copy";
    } else if (arg === "--link") {
      mode = "link";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--admin-email") {
      adminEmail = next(i, arg);
      i += 1;
    } else if (arg.startsWith("--admin-email=")) {
      adminEmail = arg.slice("--admin-email=".length);
    } else if (arg === "--import-jobs") {
      importJobs = next(i, arg) === "history" ? "history" : "skip";
      i += 1;
    } else if (arg.startsWith("--import-jobs=")) {
      importJobs = arg.slice("--import-jobs=".length) === "history" ? "history" : "skip";
    } else {
      throw new UsageError(`Unknown option ${arg}`);
    }
  }

  if (!databaseUrl) throw new UsageError("--v1-db is required");
  if (!dataDir) throw new UsageError("--v1-data is required");
  return { databaseUrl, dataDir, mode, dryRun, adminEmail, importJobs };
}

function progressLine(phase: string, current?: number, total?: number, message?: string): string {
  const counter = total !== undefined ? ` ${current ?? 0}/${total}` : "";
  return `[${phase}]${counter}${message ? ` ${message}` : ""}`;
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  const options: RunV1ImportOptions = {
    databaseUrl: args.databaseUrl,
    dataDir: args.dataDir,
    mode: args.mode,
    dryRun: args.dryRun,
    adminEmail: args.adminEmail,
    importJobs: args.importJobs,
    requestedById: null,
  };

  let lastPhase = "";
  try {
    const report = await runV1Import(options, {
      log: (line) => process.stderr.write(`${line}\n`),
      onProgress: (update) => {
        const phase = update.phase ?? "";
        // One line per phase change, then one per update inside it.
        if (phase !== lastPhase) {
          lastPhase = phase;
          process.stderr.write(`\n`);
        }
        process.stderr.write(
          `${progressLine(phase, update.current, update.total, update.message)}\n`,
        );
      },
    });
    process.stdout.write(formatReportText(report));
    return 0;
  } catch (error) {
    process.stderr.write(
      `\nImport failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `Import crashed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
