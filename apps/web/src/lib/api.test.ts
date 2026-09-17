import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { RouteContext } from "@/lib/api";
import {
  ApiError,
  badRequest,
  conflict,
  DEFAULT_MAX_BODY_BYTES,
  forbidden,
  jsonResponse,
  notFound,
  searchParamsToObject,
  unauthorized,
  withAuth,
  withPublic,
} from "@/lib/api";
import { getCurrentUser } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return { ...actual, getCurrentUser: vi.fn() };
});

const getCurrentUserMock = vi.mocked(getCurrentUser);

const member: SessionUser = {
  id: "user-1",
  email: "member@example.com",
  displayName: "Member",
  role: "member",
  showAdult: false,
  showSpoilers: false,
  mustSetPassword: false,
};
const admin: SessionUser = { ...member, id: "user-2", role: "admin" };

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function req(url = "http://localhost:3000/api/thing", init?: NextRequestInit): NextRequest {
  return new NextRequest(url, init);
}

function ctx(params: Record<string, string | string[]> = {}) {
  return { params: Promise.resolve(params) };
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockResolvedValue(member);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jsonResponse", () => {
  it("serialises dates to ISO and bigints to strings", async () => {
    const res = jsonResponse({ at: new Date("2024-01-02T03:04:05.000Z"), big: 42n });
    expect(res.headers.get("Content-Type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ at: "2024-01-02T03:04:05.000Z", big: "42" });
  });
});

describe("searchParamsToObject", () => {
  it("keeps single values scalar and collapses repeats into arrays", () => {
    const params = new URLSearchParams("tag=a&tag=b&q=hi&empty=");
    expect(searchParamsToObject(params)).toEqual({ tag: ["a", "b"], q: "hi", empty: "" });
  });
});

describe("error helpers", () => {
  it("carry status, code and details", () => {
    expect(badRequest("nope", { a: 1 })).toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      details: { a: 1 },
    });
    expect(unauthorized()).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(forbidden()).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(notFound("Series")).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(notFound("Series").message).toBe("Series not found");
    expect(conflict("dupe")).toMatchObject({ status: 409, code: "CONFLICT" });
    expect(new ApiError(418, "TEAPOT", "short")).toBeInstanceOf(Error);
  });
});

describe("withAuth", () => {
  it("returns 401 when there is no session", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const handler = withAuth({}, () => ({ ok: true }));

    const res = await handler(req(), ctx());

    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: "Sign in required" },
    });
  });

  it("returns 403 when the route requires admin", async () => {
    const handler = withAuth({ role: "admin" }, () => ({ ok: true }));

    const res = await handler(req(), ctx());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("allows admins through the admin gate", async () => {
    getCurrentUserMock.mockResolvedValue(admin);
    const handler = withAuth({ role: "admin" }, ({ user }) => ({ id: user.id }));

    const res = await handler(req(), ctx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "user-2" });
  });

  it("passes the user, query and awaited params to the handler", async () => {
    const handler = withAuth(
      {
        query: z.object({ page: z.coerce.number().default(1) }),
        params: z.object({ id: z.string().min(1) }),
      },
      ({ user, query, params }) => ({ email: user.email, page: query.page, id: params.id }),
    );

    const res = await handler(
      req("http://localhost:3000/api/series/abc?page=3"),
      ctx({ id: "abc" }),
    );

    await expect(res.json()).resolves.toEqual({
      email: "member@example.com",
      page: 3,
      id: "abc",
    });
  });

  it("exposes raw params and query when no schema is given", async () => {
    const handler = withAuth({}, ({ body, query, params }) => ({ body, query, params }));

    const res = await handler(req("http://localhost:3000/api/x?a=1&a=2"), ctx({ id: "z" }));

    await expect(res.json()).resolves.toEqual({
      query: { a: ["1", "2"] },
      params: { id: "z" },
    });
  });

  it("returns 400 INVALID_JSON for an unparseable body", async () => {
    const handler = withAuth({ body: z.object({ title: z.string() }) }, ({ body }) => body);

    const res = await handler(
      req("http://localhost:3000/api/x", { method: "POST", body: "{" }),
      ctx(),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "INVALID_JSON" } });
  });

  it("returns 400 VALIDATION_FAILED with flattened issues", async () => {
    const handler = withAuth(
      { body: z.object({ title: z.string().min(3), nested: z.object({ n: z.number() }) }) },
      ({ body }) => body,
    );

    const res = await handler(
      req("http://localhost:3000/api/x", {
        method: "POST",
        body: JSON.stringify({ title: "a", nested: { n: "x" } }),
      }),
      ctx(),
    );

    expect(res.status).toBe(400);
    const payload = (await res.json()) as {
      error: { code: string; details: { path: string; message: string }[] };
    };
    expect(payload.error.code).toBe("VALIDATION_FAILED");
    expect(payload.error.details.map((d) => d.path).sort()).toEqual(["nested.n", "title"]);
    expect(payload.error.details.every((d) => typeof d.message === "string")).toBe(true);
  });

  it("does not read the body when no body schema is declared", async () => {
    const handler = withAuth({}, ({ body }) => ({ body: body ?? null }));

    const res = await handler(
      req("http://localhost:3000/api/x", { method: "POST", body: "not json at all" }),
      ctx(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ body: null });
  });

  it("maps a thrown ApiError to its status", async () => {
    const handler = withAuth({}, () => {
      throw conflict("Series already in the library");
    });

    const res = await handler(req(), ctx());

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: { code: "CONFLICT", message: "Series already in the library" },
    });
  });

  it("maps UnauthorizedError thrown inside the handler to 401", async () => {
    const { UnauthorizedError } = await import("@/lib/auth/session");
    const handler = withAuth({}, () => {
      throw new UnauthorizedError();
    });

    const res = await handler(req(), ctx());

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("maps a ZodError thrown inside the handler to 400", async () => {
    const handler = withAuth({}, () => {
      z.object({ a: z.string() }).parse({ a: 1 });
      return null;
    });

    const res = await handler(req(), ctx());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  const prismaCases: { code: string; status: number; errorCode: string }[] = [
    { code: "P2025", status: 404, errorCode: "NOT_FOUND" },
    { code: "P2002", status: 409, errorCode: "CONFLICT" },
    { code: "P2003", status: 400, errorCode: "BAD_REQUEST" },
  ];
  for (const { code, status, errorCode } of prismaCases) {
    it(`maps Prisma ${code} to ${status}`, async () => {
      const handler = withAuth({}, () => {
        throw new Prisma.PrismaClientKnownRequestError("db said no", {
          code,
          clientVersion: "7.10.0",
        });
      });

      const res = await handler(req(), ctx());

      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toMatchObject({ error: { code: errorCode } });
    });
  }

  it("masks unexpected errors as 500 and logs the route", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", "production");

    const handler = withAuth({}, () => {
      throw new Error("connection string leaked here");
    });
    const res = await handler(req("http://localhost:3000/api/secret"), ctx());

    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("INTERNAL");
    expect(payload.error.message).not.toContain("leaked");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("/api/secret"), expect.any(Error));

    vi.unstubAllEnvs();
    expect(process.env.NODE_ENV).toBe(previous);
  });

  it("includes the error message outside production", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withAuth({}, () => {
      throw new Error("boom in dev");
    });

    const res = await handler(req(), ctx());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: { message: "boom in dev" } });
  });

  it("passes a Response returned by the handler straight through", async () => {
    const handler = withAuth({}, () => new Response("raw bytes", { status: 206 }));

    const res = await handler(req(), ctx());

    expect(res.status).toBe(206);
    await expect(res.text()).resolves.toBe("raw bytes");
  });

  it("returns 204 when the handler returns nothing", async () => {
    const handler = withAuth({}, () => undefined);

    const res = await handler(req(), ctx());

    expect(res.status).toBe(204);
    await expect(res.text()).resolves.toBe("");
  });

  it("tolerates a missing context object", async () => {
    const handler = withAuth({}, ({ params }) => ({ params }));

    const res = await handler(req(), undefined as unknown as RouteContext);

    await expect(res.json()).resolves.toEqual({ params: {} });
  });
});

describe("request body limit", () => {
  const schema = z.object({ text: z.string() });

  /** A body that arrives in chunks with no content-length, like a chunked POST. */
  function streamed(chunks: string[]): NextRequest {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new NextRequest("http://localhost:3000/api/x", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as unknown as NextRequestInit);
  }

  it("refuses a declared content-length over the limit without reading the body", async () => {
    const handler = withAuth({ body: schema }, ({ body }) => body);

    const res = await handler(
      req("http://localhost:3000/api/x", {
        method: "POST",
        headers: { "content-length": String(DEFAULT_MAX_BODY_BYTES + 1) },
        body: JSON.stringify({ text: "small in reality" }),
      }),
      ctx(),
    );

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("aborts a streamed body that goes past the limit", async () => {
    const handler = withAuth({ body: schema, maxBodyBytes: 64 }, ({ body }) => body);
    const chunk = "x".repeat(32);

    const res = await handler(streamed([chunk, chunk, chunk, chunk]), ctx());

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("accepts a streamed body inside the limit", async () => {
    const handler = withAuth({ body: schema, maxBodyBytes: 1024 }, ({ body }) => body);

    const res = await handler(streamed(['{"text":', '"hello"}']), ctx());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ text: "hello" });
  });

  it("honours a per-route maxBodyBytes override for the content-length check", async () => {
    const handler = withAuth({ body: schema, maxBodyBytes: 16 }, ({ body }) => body);

    const res = await handler(
      req("http://localhost:3000/api/x", {
        method: "POST",
        headers: { "content-length": "17" },
        body: JSON.stringify({ text: "hello" }),
      }),
      ctx(),
    );

    expect(res.status).toBe(413);
  });

  it("still parses a normal body", async () => {
    const handler = withAuth({ body: schema }, ({ body }) => body);

    const res = await handler(
      req("http://localhost:3000/api/x", {
        method: "POST",
        body: JSON.stringify({ text: "fine" }),
      }),
      ctx(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ text: "fine" });
  });

  it("applies the same limit to public routes", async () => {
    const handler = withPublic({ body: schema, maxBodyBytes: 8 }, ({ body }) => body);

    const res = await handler(streamed(['{"text":"much too long"}']), ctx());

    expect(res.status).toBe(413);
  });
});

describe("withPublic", () => {
  it("never resolves a session", async () => {
    const handler = withPublic({}, ({ user }) => ({ user }));

    const res = await handler(req(), ctx());

    expect(getCurrentUserMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ user: null });
  });

  it("still validates input", async () => {
    const handler = withPublic({ body: z.object({ email: z.email() }) }, ({ body }) => body);

    const res = await handler(
      req("http://localhost:3000/api/auth", {
        method: "POST",
        body: JSON.stringify({ email: "nope" }),
      }),
      ctx(),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });
});
