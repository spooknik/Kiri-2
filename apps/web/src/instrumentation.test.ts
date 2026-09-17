/**
 * The instrumentation hook must be inert everywhere except a running Node
 * server, and must never stack its interval on a dev hot reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The hook must stay inert in tests: never start a real runner or load the
// handler graph (a stray background drain would leak into other test files).
vi.mock("@/lib/jobs/handlers", () => ({}));
vi.mock("@/lib/jobs/runner", () => ({ startJobRunner: vi.fn(async () => {}) }));
vi.mock("@/lib/retention", () => ({ runRetention: vi.fn(async () => ({ error: null })) }));

import { register } from "@/instrumentation";

interface RetentionGlobal {
  __kiriRetentionScheduled?: boolean;
}

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.useFakeTimers();
  delete (globalThis as unknown as RetentionGlobal).__kiriRetentionScheduled;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  delete (globalThis as unknown as RetentionGlobal).__kiriRetentionScheduled;
});

function timerSpies() {
  return {
    timeout: vi.spyOn(globalThis, "setTimeout"),
    interval: vi.spyOn(globalThis, "setInterval"),
  };
}

describe("register", () => {
  it("does nothing outside the node runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const spies = timerSpies();

    await register();

    expect(spies.timeout).not.toHaveBeenCalled();
    expect(spies.interval).not.toHaveBeenCalled();
  });

  it("does nothing during next build", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PHASE = "phase-production-build";
    const spies = timerSpies();

    await register();

    expect(spies.timeout).not.toHaveBeenCalled();
    expect(spies.interval).not.toHaveBeenCalled();
  });

  it("schedules the sweep once, however often it is called", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    delete process.env.NEXT_PHASE;
    const spies = timerSpies();

    await register();
    await register();
    await register();

    expect(spies.timeout).toHaveBeenCalledTimes(1);
    expect(spies.interval).toHaveBeenCalledTimes(1);
    expect(spies.timeout.mock.calls[0]?.[1]).toBe(30_000);
    expect(spies.interval.mock.calls[0]?.[1]).toBe(6 * 60 * 60 * 1000);
    expect((globalThis as unknown as RetentionGlobal).__kiriRetentionScheduled).toBe(true);
  });
});
