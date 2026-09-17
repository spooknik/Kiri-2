/**
 * SSRF guard: the address classifier, the pre-flight check and the per-hop
 * re-check safeFetch does on redirects.
 *
 * DNS is mocked so the suite is hermetic (no name ever leaves the machine);
 * the one real socket test proves a blocked host is refused *before* a
 * connection is attempted.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPublicHttpUrl, isBlockedIpAddress, safeFetch, SafeFetchError } from "./safe-fetch";
import { lookup } from "node:dns/promises";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const lookupMock = lookup as unknown as ReturnType<
  typeof vi.fn<(host: string, options: { all: true }) => Promise<{ address: string }[]>>
>;

/** Resolve every name to `addresses` for the next check. */
function resolvesTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(addresses.map((address) => ({ address })));
}

const env = process.env as Record<string, string | undefined>;
const originalHatch = env["KIRI_ALLOW_PRIVATE_FETCH"];
const originalNodeEnv = env["NODE_ENV"];

beforeEach(() => {
  // test/setup.ts turns the hatch on for the rest of the suite; these tests are
  // about what happens with it off.
  delete env["KIRI_ALLOW_PRIVATE_FETCH"];
  lookupMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  env["KIRI_ALLOW_PRIVATE_FETCH"] = originalHatch;
  env["NODE_ENV"] = originalNodeEnv;
});

/* -------------------------------------------------------------------------- */
/* Classifier                                                                 */
/* -------------------------------------------------------------------------- */

describe("isBlockedIpAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ])("blocks the IPv4 address %s", (address) => {
    expect(isBlockedIpAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1", "192.167.1.1", "100.63.255.255"])(
    "allows the public IPv4 address %s",
    (address) => {
      expect(isBlockedIpAddress(address)).toBe(false);
    },
  );

  it.each(["::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1"])(
    "blocks the IPv6 address %s",
    (address) => {
      expect(isBlockedIpAddress(address)).toBe(true);
    },
  );

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "allows the public IPv6 address %s",
    (address) => {
      expect(isBlockedIpAddress(address)).toBe(false);
    },
  );

  it("sees through IPv4-mapped, NAT64 and 6to4 forms", () => {
    expect(isBlockedIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedIpAddress("64:ff9b::7f00:1")).toBe(true);
    expect(isBlockedIpAddress("64:ff9b::808:808")).toBe(false);
    expect(isBlockedIpAddress("2002:7f00:1::")).toBe(true);
  });

  it("refuses anything that is not an address at all", () => {
    expect(isBlockedIpAddress("example.com")).toBe(true);
    expect(isBlockedIpAddress("")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* assertPublicHttpUrl                                                        */
/* -------------------------------------------------------------------------- */

describe("assertPublicHttpUrl", () => {
  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://example.com/x",
    "ext::sh -c whoami",
  ])("refuses the scheme in %s", async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toMatchObject({
      name: "SafeFetchError",
      code: "SCHEME",
    });
  });

  it("refuses a private IP literal without asking DNS", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1:5432/")).rejects.toMatchObject({
      code: "BLOCKED_HOST",
    });
    await expect(assertPublicHttpUrl("http://[::1]/x")).rejects.toMatchObject({
      code: "BLOCKED_HOST",
    });
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      SafeFetchError,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("accepts a public IP literal", async () => {
    const url = await assertPublicHttpUrl("https://93.184.216.34/x");
    expect(url.hostname).toBe("93.184.216.34");
  });

  it("refuses a name that resolves into a blocked range", async () => {
    resolvesTo("169.254.169.254");
    await expect(assertPublicHttpUrl("https://metadata.example/")).rejects.toMatchObject({
      code: "BLOCKED_HOST",
    });
  });

  it("refuses when only one of several answers is private", async () => {
    resolvesTo("93.184.216.34", "10.0.0.5");
    await expect(assertPublicHttpUrl("https://mixed.example/")).rejects.toMatchObject({
      code: "BLOCKED_HOST",
    });
  });

  it("accepts a name that resolves publicly", async () => {
    resolvesTo("93.184.216.34");
    await expect(assertPublicHttpUrl("https://good.example/cover.png")).resolves.toBeInstanceOf(
      URL,
    );
  });

  it("fails closed when the name does not resolve", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertPublicHttpUrl("https://nowhere.invalid/")).rejects.toMatchObject({
      code: "DNS",
    });
  });

  it("honours the test escape hatch outside production only", async () => {
    env["KIRI_ALLOW_PRIVATE_FETCH"] = "1";
    await expect(assertPublicHttpUrl("http://127.0.0.1:3000/x")).resolves.toBeInstanceOf(URL);
    // …but the scheme check is not part of the hatch.
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toMatchObject({
      code: "SCHEME",
    });

    env["NODE_ENV"] = "production";
    await expect(assertPublicHttpUrl("http://127.0.0.1:3000/x")).rejects.toMatchObject({
      code: "BLOCKED_HOST",
    });
    env["NODE_ENV"] = originalNodeEnv;
  });
});

/* -------------------------------------------------------------------------- */
/* safeFetch                                                                  */
/* -------------------------------------------------------------------------- */

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe("safeFetch", () => {
  it("re-checks every redirect hop and refuses one that turns inward", async () => {
    resolvesTo("93.184.216.34");
    const fetchMock = vi.fn<typeof fetch>(async () => redirectTo("http://127.0.0.1:8080/admin"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(safeFetch("https://open.example/x")).rejects.toMatchObject({
      code: "BLOCKED_HOST",
    });
    // The first hop happened, the second never did.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect that stays public", async () => {
    resolvesTo("93.184.216.34");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectTo("https://cdn.example/final.png"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await safeFetch("https://open.example/x");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://cdn.example/final.png");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("gives up after three hops", async () => {
    resolvesTo("93.184.216.34");
    const fetchMock = vi.fn<typeof fetch>(async () => redirectTo("https://open.example/again"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(safeFetch("https://open.example/x")).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("refuses a response that declares more than maxBytes", async () => {
    resolvesTo("93.184.216.34");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("x", { headers: { "content-length": "5000" } })),
    );
    await expect(safeFetch("https://open.example/big", { maxBytes: 1000 })).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });

  it("caps a response that lies about its length while streaming", async () => {
    resolvesTo("93.184.216.34");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("0123456789")),
    );
    const response = await safeFetch("https://open.example/big", { maxBytes: 4 });
    await expect(response.arrayBuffer()).rejects.toThrow(/larger than 4 bytes/);
  });

  it("never opens a socket to a blocked host", async () => {
    let hits = 0;
    const server: Server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(302, { location: "http://127.0.0.1:1/" }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
        code: "BLOCKED_HOST",
      });
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
