import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PluginError } from "../src/errors.js";
import { HttpClient, looksLikeChallenge, parseRetryAfter } from "../src/http.js";

type Handler = (request: IncomingMessage, response: ServerResponse, hit: number) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
let hits: number;
let lastHeaders: IncomingMessage["headers"];

beforeAll(async () => {
  server = createServer((request, response) => {
    hits += 1;
    lastHeaders = request.headers;
    handler(request, response, hits);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = 0;
  handler = (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  };
});

/** Fast defaults: no politeness delays, no rate limit, tiny backoff. */
function client(overrides: ConstructorParameters<typeof HttpClient>[0] = {}): HttpClient {
  return new HttpClient({
    jitterMs: 0,
    requestsPerSecond: 0,
    backoffMs: 10,
    timeoutMs: 2000,
    ...overrides,
  });
}

async function expectPluginError(promise: Promise<unknown>): Promise<PluginError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError);
    return error as PluginError;
  }
  throw new Error("expected the call to reject");
}

describe("retry and backoff", () => {
  it("retries a 500 and returns the eventual success", async () => {
    handler = (_request, response, hit) => {
      if (hit < 3) {
        response.writeHead(500);
        response.end("boom");
        return;
      }
      response.writeHead(200);
      response.end("finally");
    };
    const text = await client({ retries: 3 }).fetchText(`${baseUrl}/flaky`);
    expect(text).toBe("finally");
    expect(hits).toBe(3);
  });

  it("gives up after `retries` attempts with a NETWORK error", async () => {
    handler = (_request, response) => {
      response.writeHead(502);
      response.end("bad gateway");
    };
    const error = await expectPluginError(client({ retries: 2 }).fetchText(`${baseUrl}/down`));
    expect(error.code).toBe("NETWORK");
    expect(error.retryable).toBe(true);
    expect(hits).toBe(3);
  });

  it("waits longer on each attempt and reports retries", async () => {
    handler = (_request, response) => {
      response.writeHead(500);
      response.end();
    };
    const seen: number[] = [];
    const started = Date.now();
    await expectPluginError(
      client({ retries: 2, backoffMs: 60, onRetry: (info) => seen.push(info.delayMs) }).fetchText(
        `${baseUrl}/slow-retry`,
      ),
    );
    // 60 ms then 120 ms — exponential, and actually slept.
    expect(seen).toEqual([60, 120]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });
});

describe("status handling", () => {
  it("maps 404 to NOT_FOUND without retrying", async () => {
    handler = (_request, response) => {
      response.writeHead(404);
      response.end("nope");
    };
    const error = await expectPluginError(client({ retries: 3 }).fetchText(`${baseUrl}/missing`));
    expect(error.code).toBe("NOT_FOUND");
    expect(hits).toBe(1);
  });

  it("maps a persistent 429 to RATE_LIMITED", async () => {
    handler = (_request, response) => {
      response.writeHead(429, { "retry-after": "0" });
      response.end("slow down");
    };
    const error = await expectPluginError(client({ retries: 2 }).fetchText(`${baseUrl}/limited`));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
    expect(hits).toBe(3);
  });

  it("honours Retry-After and gives up when it is absurd", async () => {
    handler = (_request, response) => {
      response.writeHead(429, { "retry-after": "3600" });
      response.end();
    };
    const error = await expectPluginError(
      client({ retries: 3, maxRetryAfterMs: 1000 }).fetchText(`${baseUrl}/long-wait`),
    );
    expect(error.code).toBe("RATE_LIMITED");
    // No point sleeping for an hour inside a job.
    expect(hits).toBe(1);
  });

  it("retries after a short Retry-After", async () => {
    handler = (_request, response, hit) => {
      if (hit === 1) {
        response.writeHead(429, { "retry-after": "0" });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end("after the wait");
    };
    expect(await client({ retries: 2 }).fetchText(`${baseUrl}/wait`)).toBe("after the wait");
    expect(hits).toBe(2);
  });

  it("maps 401 and a plain 403 to credential and block errors", async () => {
    handler = (_request, response) => {
      response.writeHead(401);
      response.end("login required");
    };
    expect((await expectPluginError(client().fetchText(`${baseUrl}/private`))).code).toBe(
      "NEEDS_CREDENTIAL",
    );

    handler = (_request, response) => {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("region locked");
    };
    const blocked = await expectPluginError(client().fetchText(`${baseUrl}/geo`));
    expect(blocked.code).toBe("BLOCKED");
    expect(blocked.retryable).toBe(false);
  });

  it("maps an unknown 4xx to a non-retryable NETWORK error", async () => {
    handler = (_request, response) => {
      response.writeHead(418);
      response.end("teapot");
    };
    const error = await expectPluginError(client({ retries: 2 }).fetchText(`${baseUrl}/teapot`));
    expect(error.code).toBe("NETWORK");
    expect(error.retryable).toBe(false);
    expect(hits).toBe(1);
  });
});

describe("Cloudflare detection (detection only, never a bypass)", () => {
  it("detects the interstitial body behind a 403", async () => {
    handler = (_request, response) => {
      response.writeHead(403, { "content-type": "text/html", server: "cloudflare" });
      response.end("<html><head><title>Just a moment...</title></head><body></body></html>");
    };
    const error = await expectPluginError(client({ retries: 3 }).fetchText(`${baseUrl}/cf`));
    expect(error.code).toBe("NEEDS_CREDENTIAL");
    expect(error.hint).toMatch(/cf_clearance/i);
    expect(hits).toBe(1);
  });

  it("detects the cf-mitigated header behind a 503", async () => {
    handler = (_request, response) => {
      response.writeHead(503, { "cf-mitigated": "challenge" });
      response.end("<html>whatever</html>");
    };
    expect((await expectPluginError(client().fetchText(`${baseUrl}/cf503`))).code).toBe(
      "NEEDS_CREDENTIAL",
    );
  });

  it("treats a plain 503 as a retryable network error", async () => {
    handler = (_request, response) => {
      response.writeHead(503);
      response.end("maintenance");
    };
    const error = await expectPluginError(client({ retries: 1 }).fetchText(`${baseUrl}/down503`));
    expect(error.code).toBe("NETWORK");
    expect(hits).toBe(2);
  });

  it("recognises the known markers", () => {
    const headers = (init: Record<string, string>) => new Headers(init);
    expect(looksLikeChallenge(headers({ "cf-mitigated": "challenge" }), "")).toBe(true);
    expect(looksLikeChallenge(headers({}), "<title>Just a moment</title>")).toBe(true);
    expect(looksLikeChallenge(headers({}), "/cdn-cgi/challenge-platform/h/b/orchestrate")).toBe(
      true,
    );
    expect(looksLikeChallenge(headers({ server: "cloudflare" }), "<h1>Hello</h1>")).toBe(false);
  });
});

describe("requests", () => {
  it("sends the default headers plus cookie, User-Agent and Referer", async () => {
    const http = client({ cookie: "cf_clearance=abc", userAgent: "KiriTest/1.0" });
    await http.fetchText(`${baseUrl}/headers`, { referer: "https://example.com/series" });
    expect(lastHeaders["cookie"]).toBe("cf_clearance=abc");
    expect(lastHeaders["user-agent"]).toBe("KiriTest/1.0");
    expect(lastHeaders["referer"]).toBe("https://example.com/series");
    expect(lastHeaders["accept-language"]).toMatch(/en/);
    expect(lastHeaders["accept"]).toMatch(/text\/html/);
  });

  it("falls back to KIRI_COOKIE and KIRI_USER_AGENT from the environment", async () => {
    const http = client({ env: { KIRI_COOKIE: "session=1", KIRI_USER_AGENT: "FromEnv/2" } });
    await http.fetchText(`${baseUrl}/env-headers`);
    expect(lastHeaders["cookie"]).toBe("session=1");
    expect(lastHeaders["user-agent"]).toBe("FromEnv/2");
  });

  it("parses JSON and reports bad JSON as PARSE", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"title":"Starlight"}');
    };
    expect(await client().fetchJson<{ title: string }>(`${baseUrl}/meta`)).toEqual({
      title: "Starlight",
    });

    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("<html>not json</html>");
    };
    expect((await expectPluginError(client().fetchJson(`${baseUrl}/broken`))).code).toBe("PARSE");
  });

  it("returns bytes, content type and the final URL", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([1, 2, 3, 4]));
    };
    const result = await client().fetchBuffer(`${baseUrl}/pixel.png`);
    expect(result.buffer.length).toBe(4);
    expect(result.contentType).toBe("image/png");
    expect(result.finalUrl).toBe(`${baseUrl}/pixel.png`);
  });
});

describe("timeouts, cancellation and rate limiting", () => {
  it("times out a slow response", async () => {
    handler = (_request, response) => {
      setTimeout(() => {
        response.writeHead(200);
        response.end("too late");
      }, 500);
    };
    const error = await expectPluginError(
      client({ retries: 0, timeoutMs: 60 }).fetchText(`${baseUrl}/slow`),
    );
    expect(error.code).toBe("NETWORK");
    expect(error.message).toMatch(/timed out/i);
  });

  it("turns a parent abort into CANCELLED", async () => {
    const controller = new AbortController();
    handler = (_request, response) => {
      setTimeout(() => {
        response.writeHead(200);
        response.end("never read");
      }, 500);
    };
    const http = client({ retries: 0, signal: controller.signal });
    const pending = http.fetchText(`${baseUrl}/cancel-me`);
    setTimeout(() => controller.abort(), 30);
    expect((await expectPluginError(pending)).code).toBe("CANCELLED");
  });

  it("reports a dead host as NETWORK", async () => {
    // Port 1 is never listening.
    const error = await expectPluginError(
      client({ retries: 1 }).fetchText("http://127.0.0.1:1/nothing"),
    );
    expect(error.code).toBe("NETWORK");
  });

  it("spaces requests out with the token bucket", async () => {
    const http = new HttpClient({ jitterMs: 0, requestsPerSecond: 20, burst: 1 });
    const started = Date.now();
    for (let index = 0; index < 3; index += 1) {
      await http.fetchText(`${baseUrl}/bucket-${index}`);
    }
    // Two 50 ms gaps between three requests (minus timer slop).
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(hits).toBe(3);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds, HTTP dates and junk", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const future = new Date(Date.now() + 30_000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThan(25_000);
  });
});
