/**
 * Route-handler toolkit.
 *
 * Every JSON API route in Kiri is built from `withAuth` / `withPublic` so that
 * authentication, zod validation, error shapes and status codes are decided in
 * exactly one place (V1 hand-rolled these per route and drifted).
 *
 * Success: the handler return value, JSON-serialised (`undefined` yields 204).
 * Failure: `{ error: { code, message, details? } }` with `Cache-Control: no-store`.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser, UnauthorizedError } from "@/lib/auth/session";
import { isAdmin, type SessionUser } from "@/lib/auth/types";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Codes the toolkit itself produces. Routes may add their own strings. */
export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "INVALID_JSON"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL";

/** Thrown by route handlers (and lib code) to produce a specific status. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function badRequest(message = "Bad request", details?: unknown): ApiError {
  return new ApiError(400, "BAD_REQUEST", message, details);
}

export function unauthorized(message = "Sign in required"): ApiError {
  return new ApiError(401, "UNAUTHORIZED", message);
}

export function forbidden(message = "You do not have access to this resource"): ApiError {
  return new ApiError(403, "FORBIDDEN", message);
}

export function notFound(what = "Resource"): ApiError {
  return new ApiError(404, "NOT_FOUND", `${what} not found`);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, "CONFLICT", message);
}

export function payloadTooLarge(limitBytes: number): ApiError {
  return new ApiError(
    413,
    "PAYLOAD_TOO_LARGE",
    `Request body must be ${limitBytes} bytes or smaller`,
  );
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

function jsonReplacer(_key: string, value: unknown): unknown {
  // Dates already stringify to ISO through Date.prototype.toJSON; BigInt throws.
  return typeof value === "bigint" ? value.toString() : value;
}

/** JSON response with BigInt support. Used for every success and error body. */
export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(data, jsonReplacer), { ...init, headers });
}

function errorResponse(status: number, code: string, message: string, details?: unknown): Response {
  return jsonResponse(
    { error: details === undefined ? { code, message } : { code, message, details } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface ValidationIssue {
  path: string;
  message: string;
}

/** zod 4 issues flattened to `{ path, message }` for the `details` field. */
export function flattenIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join("."),
    message: issue.message,
  }));
}

function validationError(error: z.ZodError, message: string): ApiError {
  return new ApiError(400, "VALIDATION_FAILED", message, flattenIssues(error));
}

function parseWith<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationError(parsed.error, `Invalid ${what}`);
  }
  return parsed.data as z.infer<T>;
}

/** Repeated query keys collapse to an array, single keys stay scalar. */
export function searchParamsToObject(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : (values[0] ?? "");
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Handler wiring                                                             */
/* -------------------------------------------------------------------------- */

/** Raw route params as Next.js delivers them (awaited by the toolkit). */
export type RawParams = Record<string, string | string[]>;

export interface RouteContext {
  params: Promise<RawParams>;
}

export type RouteHandler = (req: NextRequest, ctx: RouteContext) => Promise<Response>;

type InferOr<S, Fallback> = S extends z.ZodType ? z.infer<S> : Fallback;

export interface HandlerArgs<TUser, TBody, TQuery, TParams> {
  req: NextRequest;
  user: TUser;
  body: TBody;
  query: TQuery;
  params: TParams;
}

export interface RouteOptions<
  TBody extends z.ZodType | undefined,
  TQuery extends z.ZodType | undefined,
  TParams extends z.ZodType | undefined,
> {
  /** Restrict the route to admins (withAuth only). */
  role?: "admin";
  /** When set, the JSON request body is parsed and validated. */
  body?: TBody;
  /** Validates `req.nextUrl.searchParams` as a plain object. */
  query?: TQuery;
  /** Validates the awaited dynamic route params. */
  params?: TParams;
  /**
   * Cap on the JSON request body, in bytes. Defaults to
   * {@link DEFAULT_MAX_BODY_BYTES}; raise it only for routes that genuinely
   * accept large JSON (file uploads go through multipart, not this path).
   */
  maxBodyBytes?: number;
}

type Handler<TUser, TBody, TQuery, TParams> = (
  args: HandlerArgs<TUser, TBody, TQuery, TParams>,
) => unknown | Promise<unknown>;

/**
 * Structural check for `Prisma.PrismaClientKnownRequestError`. Structural on
 * purpose: the toolkit stays free of the generated client (and its runtime)
 * while still mapping the three error codes routes actually hit.
 */
function isPrismaKnownError(error: unknown): error is { code: string } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; clientVersion?: unknown; name?: unknown };
  return (
    typeof candidate.code === "string" &&
    /^P\d{4}$/.test(candidate.code) &&
    (typeof candidate.clientVersion === "string" ||
      candidate.name === "PrismaClientKnownRequestError")
  );
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function toResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  if (result === undefined) return new Response(null, { status: 204 });
  return jsonResponse(result, { status: 200 });
}

function safePathname(req: NextRequest): string {
  try {
    return req.nextUrl.pathname;
  } catch {
    return req.url;
  }
}

function handleError(error: unknown, req: NextRequest): Response {
  if (error instanceof ApiError) {
    return errorResponse(error.status, error.code, error.message, error.details);
  }
  if (
    error instanceof UnauthorizedError ||
    (error instanceof Error && error.name === "UnauthorizedError")
  ) {
    return errorResponse(401, "UNAUTHORIZED", "Sign in required");
  }
  if (error instanceof z.ZodError) {
    return errorResponse(400, "VALIDATION_FAILED", "Invalid request", flattenIssues(error));
  }
  if (isPrismaKnownError(error)) {
    switch (error.code) {
      case "P2025":
        return errorResponse(404, "NOT_FOUND", "Resource not found");
      case "P2002":
        return errorResponse(409, "CONFLICT", "That record already exists");
      case "P2003":
        return errorResponse(400, "BAD_REQUEST", "Related record does not exist");
      default:
        break;
    }
  }

  console.error(`[api] ${req.method} ${safePathname(req)} failed`, error);
  const message =
    isProduction() || !(error instanceof Error) ? "Something went wrong" : error.message;
  return errorResponse(500, "INTERNAL", message);
}

/**
 * Default cap on a JSON request body. Every route the toolkit wires accepts
 * small documents (a form, a sync batch); without a cap, `req.json()` buffers
 * whatever the client sends, so one request can pin an arbitrary amount of the
 * server's memory.
 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Read the body as text without ever buffering more than `maxBytes`.
 *
 * `content-length` is checked first because it lets an oversized request be
 * refused before a single byte is read, but it is only a claim: a chunked
 * request has no length at all, and a lying one must not be believed. So the
 * stream is also counted as it arrives and aborted the moment it goes over.
 */
async function readTextWithin(req: NextRequest, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw payloadTooLarge(maxBytes);
  }

  const stream = req.body;
  if (!stream) return req.text();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw payloadTooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel(); nothing to do.
    }
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function readBody<T extends z.ZodType>(
  req: NextRequest,
  schema: T,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<z.infer<T>> {
  const text = await readTextWithin(req, maxBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
  return parseWith(schema, raw, "request body");
}

async function resolveInputs<
  TBody extends z.ZodType | undefined,
  TQuery extends z.ZodType | undefined,
  TParams extends z.ZodType | undefined,
>(
  req: NextRequest,
  ctx: RouteContext | undefined,
  options: RouteOptions<TBody, TQuery, TParams>,
): Promise<{ body: unknown; query: unknown; params: unknown }> {
  const rawParams: RawParams = (await ctx?.params) ?? {};
  const params = options.params ? parseWith(options.params, rawParams, "route params") : rawParams;

  const rawQuery = searchParamsToObject(req.nextUrl.searchParams);
  const query = options.query ? parseWith(options.query, rawQuery, "query string") : rawQuery;

  // The body is only read when a schema asks for it, so GET/DELETE routes never
  // touch the stream.
  const body = options.body
    ? await readBody(req, options.body, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
    : undefined;

  return { body, query, params };
}

/**
 * Authenticated route. Resolves the session user (401 when signed out),
 * enforces `role`, validates the request, and maps thrown errors to statuses.
 */
export function withAuth<
  TBody extends z.ZodType | undefined = undefined,
  TQuery extends z.ZodType | undefined = undefined,
  TParams extends z.ZodType | undefined = undefined,
>(
  options: RouteOptions<TBody, TQuery, TParams>,
  handler: Handler<
    SessionUser,
    InferOr<TBody, undefined>,
    InferOr<TQuery, RawParams>,
    InferOr<TParams, RawParams>
  >,
): RouteHandler {
  return async (req, ctx) => {
    try {
      const user = await getCurrentUser();
      if (!user) {
        return errorResponse(401, "UNAUTHORIZED", "Sign in required");
      }
      if (options.role === "admin" && !isAdmin(user)) {
        return errorResponse(403, "FORBIDDEN", "Admin access required");
      }
      const { body, query, params } = await resolveInputs(req, ctx, options);
      const result = await handler({
        req,
        user,
        body: body as InferOr<TBody, undefined>,
        query: query as InferOr<TQuery, RawParams>,
        params: params as InferOr<TParams, RawParams>,
      });
      return toResponse(result);
    } catch (error) {
      return handleError(error, req);
    }
  };
}

/**
 * Unauthenticated route (health, version, sign-in endpoints). No session is
 * resolved, so `user` is always null.
 */
export function withPublic<
  TBody extends z.ZodType | undefined = undefined,
  TQuery extends z.ZodType | undefined = undefined,
  TParams extends z.ZodType | undefined = undefined,
>(
  options: Omit<RouteOptions<TBody, TQuery, TParams>, "role">,
  handler: Handler<
    null,
    InferOr<TBody, undefined>,
    InferOr<TQuery, RawParams>,
    InferOr<TParams, RawParams>
  >,
): RouteHandler {
  return async (req, ctx) => {
    try {
      const { body, query, params } = await resolveInputs(req, ctx, options);
      const result = await handler({
        req,
        user: null,
        body: body as InferOr<TBody, undefined>,
        query: query as InferOr<TQuery, RawParams>,
        params: params as InferOr<TParams, RawParams>,
      });
      return toResponse(result);
    } catch (error) {
      return handleError(error, req);
    }
  };
}
