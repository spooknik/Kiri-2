/**
 * Job output log buffering.
 *
 * A job's log is a single `Job.outputLog` column, so it has to be bounded:
 * V1 tail-capped it at 240 000 characters (`rip-queue.ts` MAX_OUTPUT_LOG_LENGTH)
 * and the same number applies here — the tail is what a user debugging a
 * failure actually reads. The runner appends lines in memory and flushes the
 * whole buffer to the database every couple of seconds instead of writing a
 * row per line.
 */

/** Characters kept in `Job.outputLog`; older output is dropped from the head. */
export const MAX_OUTPUT_LOG_LENGTH = 240_000;

/** A single line is clipped to this before it ever reaches the buffer. */
export const MAX_LOG_LINE_LENGTH = 4_000;

/** Keep the last {@link MAX_OUTPUT_LOG_LENGTH} characters of `value`. */
export function trimOutputLog(value: string): string {
  if (value.length <= MAX_OUTPUT_LOG_LENGTH) return value;
  return value.slice(value.length - MAX_OUTPUT_LOG_LENGTH);
}

/** Normalise one line: no NUL bytes, no CR, single line, length-capped. */
export function normalizeLogLine(line: string): string {
  const flat = line.replace(/\0/g, "").replace(/\r\n?/g, "\n").replace(/\n/g, " ⏎ ");
  return flat.length > MAX_LOG_LINE_LENGTH
    ? `${flat.slice(0, MAX_LOG_LINE_LENGTH)}… (line truncated)`
    : flat;
}

/**
 * In-memory tail of one job's output. `append` is synchronous and cheap so
 * handlers can log freely; `take` hands the runner the current text exactly
 * once per change, and returns null when there is nothing new to persist.
 */
export class JobLogBuffer {
  private text: string;
  private dirty = false;

  constructor(initial = "") {
    this.text = trimOutputLog(initial);
  }

  /** Append one timestamped line. */
  append(line: string, at: Date = new Date()): void {
    const entry = `[${at.toISOString()}] ${normalizeLogLine(line)}`;
    this.text = trimOutputLog(this.text === "" ? entry : `${this.text}\n${entry}`);
    this.dirty = true;
  }

  /** Current tail, whether or not it changed since the last flush. */
  get value(): string {
    return this.text;
  }

  get hasPendingWrite(): boolean {
    return this.dirty;
  }

  /** The tail to persist, or null when nothing changed since the last call. */
  take(): string | null {
    if (!this.dirty) return null;
    this.dirty = false;
    return this.text;
  }
}
