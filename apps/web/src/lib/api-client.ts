/**
 * Browser-side fetch wrapper for Kiri's JSON API.
 *
 * - Sends/receives JSON, same-origin, credentials included (session cookie).
 * - Errors follow src/lib/api.ts: `{ error: { code, message, details } }` and
 *   are thrown as ApiClientError so callers (TanStack Query, forms) can branch
 *   on `status`/`code`.
 * - A network failure (offline, DNS) becomes status 0 / code "OFFLINE" so the
 *   UI can distinguish "no connection" from a server rejection.
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isOffline(): boolean {
    return this.status === 0;
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  /** JSON-serialised unless it is FormData. */
  body?: unknown;
  /** Query parameters appended to the path; undefined/null values are skipped. */
  query?: Record<string, string | number | boolean | null | undefined>;
}

function buildUrl(path: string, query?: ApiFetchOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, query, headers, ...rest } = options;
  const init: RequestInit = { credentials: "same-origin", ...rest };
  const finalHeaders = new Headers(headers);
  finalHeaders.set("Accept", "application/json");

  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    finalHeaders.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }
  init.headers = finalHeaders;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), init);
  } catch (err) {
    throw new ApiClientError(0, "OFFLINE", "You appear to be offline", err);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    throw new ApiClientError(
      response.status,
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? response.statusText ?? "Request failed",
      error?.details,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: "POST", body }),
  put: <T>(path: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: "PUT", body }),
  patch: <T>(path: string, body?: unknown, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: "PATCH", body }),
  delete: <T>(path: string, options?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...options, method: "DELETE" }),
};
