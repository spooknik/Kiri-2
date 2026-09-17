/** Job serialisation: the wire shape and the opaque list cursor. */
import { describe, expect, it } from "vitest";
import {
  decodeJobCursor,
  encodeJobCursor,
  toJobConfig,
  toJobProgress,
  toJobView,
  type JobRow,
} from "@/lib/jobs/serialize";

function row(overrides: Partial<JobRow> = {}): JobRow {
  const at = new Date("2026-03-04T05:06:07.000Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "MANUAL_UPLOAD",
    status: "RUNNING",
    sourceId: null,
    seriesId: "22222222-2222-4222-8222-222222222222",
    pluginId: null,
    requestedById: null,
    configJson: { seriesId: "x" },
    progressJson: { phase: "store", current: 3, total: 9 },
    resultJson: null,
    attempt: 1,
    pid: 4242,
    startedAt: at,
    finishedAt: null,
    heartbeatAt: at,
    outputLog: "hello",
    error: null,
    errorCode: null,
    createdAt: at,
    updatedAt: at,
    requestedBy: null,
    ...overrides,
  } as JobRow;
}

describe("toJobProgress", () => {
  it("keeps only the fields the contract declares, with the right types", () => {
    expect(
      toJobProgress({
        phase: "extract",
        current: 2,
        total: 10,
        message: "001.jpg",
        chapterSlug: "manual-1",
        bogus: true,
        alsoBogus: "no",
      }),
    ).toEqual({
      phase: "extract",
      current: 2,
      total: 10,
      message: "001.jpg",
      chapterSlug: "manual-1",
    });
  });

  it("reads anything that is not an object as empty progress", () => {
    expect(toJobProgress(null)).toEqual({});
    expect(toJobProgress([1, 2])).toEqual({});
    expect(toJobProgress("nope")).toEqual({});
    expect(toJobProgress({ current: "3" })).toEqual({});
  });
});

describe("toJobConfig", () => {
  it("copies an object and flattens anything else to empty", () => {
    expect(toJobConfig({ a: 1 })).toEqual({ a: 1 });
    expect(toJobConfig(null)).toEqual({});
    expect(toJobConfig(["a"])).toEqual({});
  });
});

describe("toJobView", () => {
  it("turns every date into an ISO string", () => {
    const view = toJobView(row());
    expect(view.createdAt).toBe("2026-03-04T05:06:07.000Z");
    expect(view.startedAt).toBe("2026-03-04T05:06:07.000Z");
    expect(view.finishedAt).toBeNull();
    expect(view.progress).toEqual({ phase: "store", current: 3, total: 9 });
    expect(view.requestedBy).toBeNull();
    // pid, heartbeat and the raw log stay server-side.
    expect(view).not.toHaveProperty("pid");
    expect(view).not.toHaveProperty("outputLog");
  });

  it("exposes the requester as a UserRef", () => {
    const view = toJobView(row({ requestedBy: { id: "u1", displayName: "Ada" } }));
    expect(view.requestedBy).toEqual({ id: "u1", displayName: "Ada" });
  });
});

describe("job cursor", () => {
  it("round-trips", () => {
    const cursor = { createdAt: "2026-03-04T05:06:07.000Z", id: "job-1" };
    expect(decodeJobCursor(encodeJobCursor(cursor))).toEqual(cursor);
  });

  it("is opaque (no raw id in the encoding)", () => {
    const encoded = encodeJobCursor({ createdAt: "2026-03-04T05:06:07.000Z", id: "job-1" });
    expect(encoded).not.toContain("job-1");
  });

  it.each([
    "",
    "not-a-cursor",
    Buffer.from("[]").toString("base64url"),
    Buffer.from('{"id":""}').toString("base64url"),
    Buffer.from('{"createdAt":"nope","id":"a"}').toString("base64url"),
  ])("returns null for %s", (raw) => {
    expect(decodeJobCursor(raw)).toBeNull();
  });
});
