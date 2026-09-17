/**
 * Per-job scratch directories under DATA_ROOT/tmp/jobs. Built on the content
 * store's layout helpers so the on-disk layout is described in one place.
 */
import { readdir, stat } from "node:fs/promises";
import { removeDirSafe, resolveInside, tmpDir } from "@/lib/content/store";
import { sanitizePathSegment } from "@/lib/text";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `DATA_ROOT/tmp/jobs` — parent of every job scratch directory. */
export function jobTmpRoot(): string {
  return tmpDir("jobs");
}

/** `DATA_ROOT/tmp/jobs/<jobId>` — one job's scratch directory. */
export function jobTmpDir(jobId: string): string {
  return resolveInside(jobTmpRoot(), sanitizePathSegment(jobId));
}

/**
 * Delete job scratch directories last touched more than `maxAgeMs` ago. The
 * runner removes its own directory when a job ends; this catches the ones a
 * hard crash left behind. Never throws.
 */
export async function purgeOldJobTmpDirs(maxAgeMs: number = DAY_MS): Promise<number> {
  const root = jobTmpRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of entries) {
    const dir = resolveInside(root, name);
    try {
      const info = await stat(dir);
      if (info.mtimeMs > cutoff) continue;
      await removeDirSafe(dir);
      removed += 1;
    } catch {
      // A directory that vanished under us, or one we may not touch: skip it.
    }
  }
  return removed;
}
