/**
 * Per-user upload ceilings. Creating a session reserves disk before a byte is
 * sent, so these two limits are what stop a loop of `POST /api/uploads` from
 * filling the volume with promises. No database is involved: a session is a
 * directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { UPLOAD_MAX_BYTES } from "@/lib/contracts/content";
import { resetEnvCache } from "@/lib/env";
import { uploadsDir } from "@/lib/content/store";
import {
  createUploadSession,
  deleteUploadSession,
  MAX_LIVE_UPLOAD_SESSIONS,
  MAX_UPLOAD_BYTES_PER_USER,
} from "./sessions";

let dataRoot: string;

beforeAll(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-upload-quota-"));
  process.env.DATA_ROOT = dataRoot;
  resetEnvCache();
});

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

beforeEach(() => {
  rmSync(uploadsDir(), { recursive: true, force: true });
});

async function start(userId: string, size = 64): Promise<string> {
  const view = await createUploadSession(userId, { filename: "chapter.cbz", size });
  return view.id;
}

describe("createUploadSession quotas", () => {
  it("caps how many sessions one user may hold at once", async () => {
    const ids: string[] = [];
    for (let index = 0; index < MAX_LIVE_UPLOAD_SESSIONS; index += 1) {
      ids.push(await start("user-a"));
    }

    const refused = await start("user-a").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 409, code: "UPLOAD_QUOTA" });
    expect((refused as ApiError).message).toMatch(/finish or cancel one/i);

    // Someone else is unaffected…
    await expect(start("user-b")).resolves.toBeTruthy();
    // …and cancelling one frees a slot.
    await deleteUploadSession("user-a", ids[0] as string);
    await expect(start("user-a")).resolves.toBeTruthy();
  });

  it("caps the bytes one user may have reserved", async () => {
    const perSession = UPLOAD_MAX_BYTES;
    const sessions = Math.floor(MAX_UPLOAD_BYTES_PER_USER / perSession);
    for (let index = 0; index < sessions; index += 1) {
      await start("user-c", perSession);
    }

    const refused = await start("user-c", 1).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 409, code: "UPLOAD_QUOTA" });
    expect((refused as ApiError).message).toMatch(/8 GB/);
  });

  it("still rejects a single upload larger than the per-file limit", async () => {
    const refused = await start("user-d", UPLOAD_MAX_BYTES + 1).catch((error: unknown) => error);
    expect(refused).toMatchObject({ status: 400 });
  });
});
