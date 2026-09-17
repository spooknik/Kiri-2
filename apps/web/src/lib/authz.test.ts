import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  assertCanEditSeries,
  assertCanViewSeries,
  canEditSeries,
  canViewSeries,
  requireAdmin,
  visibleSeriesWhere,
  type SeriesAccess,
} from "@/lib/authz";
import type { SessionUser } from "@/lib/auth/types";

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "user-1",
    email: "member@example.com",
    displayName: "Member",
    role: "member",
    showAdult: false,
    showSpoilers: false,
    mustSetPassword: false,
    ...overrides,
  };
}

function series(overrides: Partial<SeriesAccess> = {}): SeriesAccess {
  return { visibility: "SHARED", isAdult: false, createdById: "creator-1", ...overrides };
}

/** Assert that `fn` throws an ApiError with the given status (and code). */
function expectApiError(fn: () => void, status: number, code?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject(code === undefined ? { status } : { status, code });
    return;
  }
  expect.unreachable(`expected an ApiError with status ${status}`);
}

const owner = user({ id: "creator-1" });
const admin = user({ id: "admin-1", role: "admin" });

describe("canViewSeries", () => {
  it("lets anyone see a shared, non-adult series", () => {
    expect(canViewSeries(user(), series())).toBe(true);
  });

  it("hides private series from everyone but the creator, admins included", () => {
    const s = series({ visibility: "PRIVATE" });
    expect(canViewSeries(user(), s)).toBe(false);
    expect(canViewSeries(owner, s)).toBe(true);
    expect(canViewSeries(admin, s)).toBe(false);
  });

  it("hides adult series unless showAdult is on, or the viewer created it", () => {
    const s = series({ isAdult: true });
    expect(canViewSeries(user(), s)).toBe(false);
    expect(canViewSeries(user({ showAdult: true }), s)).toBe(true);
    expect(canViewSeries(owner, s)).toBe(true);
  });

  it("does not exempt admins from private or adult filtering", () => {
    expect(canViewSeries(admin, series({ visibility: "PRIVATE", isAdult: true }))).toBe(false);
  });
});

describe("canEditSeries", () => {
  it("is creator or admin only", () => {
    expect(canEditSeries(user(), series())).toBe(false);
    expect(canEditSeries(owner, series())).toBe(true);
    expect(canEditSeries(admin, series())).toBe(true);
  });
});

describe("assertCanViewSeries", () => {
  it("passes silently when allowed", () => {
    expect(() => assertCanViewSeries(user(), series())).not.toThrow();
  });

  it("reports a hidden private series as 404 so existence is not leaked", () => {
    expectApiError(
      () => assertCanViewSeries(user(), series({ visibility: "PRIVATE" })),
      404,
      "NOT_FOUND",
    );
  });

  it("reports adult filtering as 403 because the viewer can change it", () => {
    expectApiError(() => assertCanViewSeries(user(), series({ isAdult: true })), 403, "FORBIDDEN");
  });
});

describe("assertCanEditSeries", () => {
  it("throws 403 for a viewer who may see but not edit", () => {
    expectApiError(() => assertCanEditSeries(user(), series()), 403);
  });

  it("throws 404 rather than 403 for an invisible private series", () => {
    expectApiError(() => assertCanEditSeries(user(), series({ visibility: "PRIVATE" })), 404);
  });

  it("allows the creator; admins cannot edit what they cannot see", () => {
    expect(() => assertCanEditSeries(owner, series())).not.toThrow();
    expect(() => assertCanEditSeries(admin, series({ visibility: "PRIVATE" }))).toThrow();
  });
});

describe("requireAdmin", () => {
  it("throws 403 for members and passes for admins", () => {
    expectApiError(() => requireAdmin(user()), 403, "FORBIDDEN");
    expect(() => requireAdmin(admin)).not.toThrow();
  });
});

describe("visibleSeriesWhere", () => {
  it("filters visibility and adult content for members", () => {
    expect(visibleSeriesWhere(user())).toEqual({
      OR: [{ visibility: "SHARED" }, { createdById: "user-1" }],
      AND: [{ OR: [{ isAdult: false }, { createdById: "user-1" }] }],
    });
  });

  it("drops the adult clause when showAdult is on", () => {
    expect(visibleSeriesWhere(user({ showAdult: true }))).toEqual({
      OR: [{ visibility: "SHARED" }, { createdById: "user-1" }],
    });
  });

  it("applies the same filters to admins", () => {
    expect(visibleSeriesWhere(admin)).toEqual(
      visibleSeriesWhere(user({ id: "admin-1", role: "member" })),
    );
  });
});
