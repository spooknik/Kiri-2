/**
 * Chunked uploads through the real route handlers: create, chunk (out of
 * order), complete, read back, delete — plus the ownership and size rules.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { PUT as putChunk } from "@/app/api/uploads/[id]/chunks/[index]/route";
import { POST as completeRoute } from "@/app/api/uploads/[id]/complete/route";
import { DELETE as deleteRoute, GET as getRoute } from "@/app/api/uploads/[id]/route";
import { POST as createRoute } from "@/app/api/uploads/route";
import type { SessionUser } from "@/lib/auth/types";
import { UPLOAD_CHUNK_SIZE, type UploadSessionView } from "@/lib/contracts/content";
import { resetEnvCache } from "@/lib/env";
import { purgeExpiredUploads, takeCompletedUpload } from "@/lib/uploads/sessions";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

let dataRoot: string;

beforeAll(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-uploads-"));
  process.env.DATA_ROOT = dataRoot;
  resetEnvCache();
});

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
});

async function createSession(
  user: SessionUser,
  body: { filename: string; size: number; mime?: string },
): Promise<UploadSessionView> {
  mockCurrentUser(user);
  const response = await createRoute(
    new NextRequest(`${ORIGIN}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext({}),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as UploadSessionView;
}

/** `BodyInit` in this lib configuration does not name Uint8Array; undici takes it. */
function asBody(data: Uint8Array): BodyInit {
  return data as unknown as BodyInit;
}

function chunkRequest(id: string, data: Uint8Array): NextRequest {
  return new NextRequest(`${ORIGIN}/api/uploads/${id}/chunks/0`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: asBody(data),
  });
}

async function sendChunk(
  user: SessionUser,
  id: string,
  index: number,
  data: Uint8Array,
): Promise<Response> {
  mockCurrentUser(user);
  return putChunk(chunkRequest(id, data), routeContext({ id, index: String(index) }));
}

describe("upload lifecycle", () => {
  it("accepts chunks out of order and assembles the file", async () => {
    const user = await createTestUser();
    const tailSize = 1024;
    const size = UPLOAD_CHUNK_SIZE + tailSize;
    const session = await createSession(user, {
      filename: "chapter.cbz",
      size,
      mime: "application/zip",
    });

    expect(session.chunkCount).toBe(2);
    expect(session.chunkSize).toBe(UPLOAD_CHUNK_SIZE);
    expect(session.receivedChunks).toEqual([]);

    // Last chunk first.
    const tail = Buffer.alloc(tailSize, 0x42);
    const head = Buffer.alloc(UPLOAD_CHUNK_SIZE, 0x41);
    expect((await sendChunk(user, session.id, 1, tail)).status).toBe(200);
    const afterFirst = (await (
      await sendChunk(user, session.id, 0, head)
    ).json()) as UploadSessionView;
    expect(afterFirst.receivedChunks).toEqual([0, 1]);

    mockCurrentUser(user);
    const completed = (await (
      await completeRoute(
        new NextRequest(`${ORIGIN}/api/uploads/${session.id}/complete`, { method: "POST" }),
        routeContext({ id: session.id }),
      )
    ).json()) as UploadSessionView;

    expect(completed.complete).toBe(true);
    const taken = await takeCompletedUpload(user.id, session.id);
    expect(taken.size).toBe(size);
    expect(taken.filename).toBe("chapter.cbz");
    expect(taken.mime).toBe("application/zip");
    expect(statSync(taken.path).size).toBe(size);
  });

  it("reports progress through GET and is idempotent on complete", async () => {
    const user = await createTestUser();
    const session = await createSession(user, { filename: "one.png", size: 16 });
    await sendChunk(user, session.id, 0, Buffer.alloc(16, 1));

    mockCurrentUser(user);
    const view = (await (
      await getRoute(
        new NextRequest(`${ORIGIN}/api/uploads/${session.id}`),
        routeContext({ id: session.id }),
      )
    ).json()) as UploadSessionView;
    expect(view.receivedChunks).toEqual([0]);
    expect(view.complete).toBe(false);

    const complete = async (): Promise<UploadSessionView> => {
      mockCurrentUser(user);
      const response = await completeRoute(
        new NextRequest(`${ORIGIN}/api/uploads/${session.id}/complete`, { method: "POST" }),
        routeContext({ id: session.id }),
      );
      return (await response.json()) as UploadSessionView;
    };
    expect((await complete()).complete).toBe(true);
    expect((await complete()).complete).toBe(true);
  });

  it("deletes a session and forgets it", async () => {
    const user = await createTestUser();
    const session = await createSession(user, { filename: "gone.png", size: 8 });

    mockCurrentUser(user);
    const deleted = await deleteRoute(
      new NextRequest(`${ORIGIN}/api/uploads/${session.id}`, { method: "DELETE" }),
      routeContext({ id: session.id }),
    );
    expect(deleted.status).toBe(204);

    mockCurrentUser(user);
    const after = await getRoute(
      new NextRequest(`${ORIGIN}/api/uploads/${session.id}`),
      routeContext({ id: session.id }),
    );
    expect(after.status).toBe(404);
  });
});

describe("upload guards", () => {
  it("is a 404 for someone else's session", async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const session = await createSession(owner, { filename: "mine.png", size: 8 });

    mockCurrentUser(stranger);
    const read = await getRoute(
      new NextRequest(`${ORIGIN}/api/uploads/${session.id}`),
      routeContext({ id: session.id }),
    );
    expect(read.status).toBe(404);

    const write = await sendChunk(stranger, session.id, 0, Buffer.alloc(8));
    expect(write.status).toBe(404);
  });

  it("rejects a chunk larger than the plan with 413", async () => {
    const user = await createTestUser();
    const session = await createSession(user, { filename: "small.png", size: 100 });

    const response = await sendChunk(user, session.id, 0, Buffer.alloc(200));

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a short chunk with 400 and stores nothing", async () => {
    const user = await createTestUser();
    const session = await createSession(user, { filename: "short.png", size: 100 });

    expect((await sendChunk(user, session.id, 0, Buffer.alloc(40))).status).toBe(400);

    mockCurrentUser(user);
    const view = (await (
      await getRoute(
        new NextRequest(`${ORIGIN}/api/uploads/${session.id}`),
        routeContext({ id: session.id }),
      )
    ).json()) as UploadSessionView;
    expect(view.receivedChunks).toEqual([]);
  });

  it("rejects an out-of-range chunk index", async () => {
    const user = await createTestUser();
    const session = await createSession(user, { filename: "one.png", size: 10 });

    expect((await sendChunk(user, session.id, 5, Buffer.alloc(10))).status).toBe(400);
  });

  it("refuses to complete while a chunk is missing", async () => {
    const user = await createTestUser();
    const size = UPLOAD_CHUNK_SIZE + 10;
    const session = await createSession(user, { filename: "half.cbz", size });
    await sendChunk(user, session.id, 1, Buffer.alloc(10));

    mockCurrentUser(user);
    const response = await completeRoute(
      new NextRequest(`${ORIGIN}/api/uploads/${session.id}/complete`, { method: "POST" }),
      routeContext({ id: session.id }),
    );
    expect(response.status).toBe(409);
  });

  it("rejects a body that is not octet-stream", async () => {
    const user = await createTestUser();
    const session = await createSession(user, { filename: "one.png", size: 4 });

    mockCurrentUser(user);
    const response = await putChunk(
      new NextRequest(`${ORIGIN}/api/uploads/${session.id}/chunks/0`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: asBody(Buffer.alloc(4)),
      }),
      routeContext({ id: session.id, index: "0" }),
    );
    expect(response.status).toBe(415);
  });

  it("requires a signed-in user", async () => {
    mockCurrentUser(null);
    const response = await createRoute(
      new NextRequest(`${ORIGIN}/api/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "x.png", size: 1 }),
      }),
      routeContext({}),
    );
    expect(response.status).toBe(401);
  });
});

describe("purgeExpiredUploads", () => {
  it("keeps live sessions and removes expired ones", async () => {
    const user = await createTestUser();
    const live = await createSession(user, { filename: "live.png", size: 8 });
    const stale = await createSession(user, { filename: "stale.png", size: 8 });

    // Age the second session by rewriting its sidecar.
    const { readFile, writeFile } = await import("node:fs/promises");
    const sidecar = path.join(dataRoot, "tmp", "uploads", stale.id, "session.json");
    const record = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>;
    record.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(sidecar, JSON.stringify(record));

    expect(await purgeExpiredUploads()).toBe(1);

    mockCurrentUser(user);
    const stillThere = await getRoute(
      new NextRequest(`${ORIGIN}/api/uploads/${live.id}`),
      routeContext({ id: live.id }),
    );
    expect(stillThere.status).toBe(200);
  });
});
