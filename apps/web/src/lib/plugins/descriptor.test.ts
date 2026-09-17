/**
 * Descriptor validation, host matching and the descriptor hash — the checks
 * that decide whether Kiri will run a directory at all. No database, no
 * subprocess: everything here is files and pure functions.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  DescriptorError,
  descriptorHashOf,
  hostMatches,
  hostnameOf,
  hostsMatch,
  needsCookie,
  normalizeHostname,
  readDescriptor,
} from "@/lib/plugins/descriptor";
import { pluginDescriptorSchema } from "@/lib/contracts/plugins";
import { parseVersion, satisfies } from "@/lib/plugins/semver";

const SDK_VERSION = "2.0.0-alpha.0";

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "kiri-descriptor-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface PluginFixture {
  id?: string;
  descriptor?: Record<string, unknown> | string;
  entryFile?: string | null;
}

/** Write a plugin directory named after `id` and return its path. */
function makePlugin(name: string, fixture: PluginFixture = {}): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  if (fixture.entryFile !== null) {
    writeFileSync(path.join(dir, fixture.entryFile ?? "src/index.mjs"), "// entry\n");
  }
  const descriptor = fixture.descriptor ?? {
    id: fixture.id ?? name,
    name: "Test Plugin",
    version: "1.0.0",
    sdk: "^2.0.0-alpha.0",
    entry: "./src/index.mjs",
    hosts: ["example.com"],
  };
  writeFileSync(
    path.join(dir, "kiri-plugin.json"),
    typeof descriptor === "string" ? descriptor : JSON.stringify(descriptor, null, 2),
  );
  return dir;
}

async function expectFailure(dir: string, code: string): Promise<DescriptorError> {
  const error = await readDescriptor(dir, { sdkVersion: SDK_VERSION }).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DescriptorError);
  expect((error as DescriptorError).code).toBe(code);
  return error as DescriptorError;
}

describe("readDescriptor", () => {
  it("accepts a well-formed plugin and applies schema defaults", async () => {
    const dir = makePlugin("good-plugin");
    const loaded = await readDescriptor(dir, { sdkVersion: SDK_VERSION });

    expect(loaded.descriptor.id).toBe("good-plugin");
    expect(loaded.entryPath).toBe(path.join(dir, "src", "index.mjs"));
    expect(loaded.descriptorHash).toMatch(/^[0-9a-f]{64}$/);
    // Defaults the contract fills in.
    expect(loaded.descriptor.capabilities).toEqual(["network"]);
    expect(loaded.descriptor.sandbox).toBe("strict");
    expect(loaded.descriptor.adult).toBe(false);
  });

  it("refuses a descriptor whose id is not the directory name", async () => {
    const dir = makePlugin("directory-name", { id: "another-id" });
    const error = await expectFailure(dir, "ID_MISMATCH");
    expect(error.message).toContain("directory-name");
  });

  it("accepts a mismatched name when the caller supplies expectId (install staging)", async () => {
    const dir = makePlugin("staging-tmp", { id: "real-id" });
    const loaded = await readDescriptor(dir, { sdkVersion: SDK_VERSION, expectId: "real-id" });
    expect(loaded.descriptor.id).toBe("real-id");
  });

  it("reports a missing descriptor", async () => {
    const dir = path.join(root, "no-descriptor");
    mkdirSync(dir, { recursive: true });
    await expectFailure(dir, "DESCRIPTOR_MISSING");
  });

  it("reports malformed JSON", async () => {
    const dir = makePlugin("bad-json", { descriptor: "{ not json" });
    await expectFailure(dir, "DESCRIPTOR_INVALID");
  });

  it("rejects an id that is not a slug or reverse-DNS name", async () => {
    for (const id of ["Bad_Id", "a", "-leading", "trailing-", "UPPER"]) {
      expect(pluginDescriptorSchema.safeParse({ ...base(), id }).success).toBe(false);
    }
    for (const id of ["mangadex", "my-site-2", "org.example.reader"]) {
      expect(pluginDescriptorSchema.safeParse({ ...base(), id }).success).toBe(true);
    }
  });

  it("rejects an entry that escapes the plugin directory", async () => {
    const dir = makePlugin("escaping-entry", {
      descriptor: { ...base(), id: "escaping-entry", entry: "../../../etc/passwd" },
    });
    // The contract's own schema catches "..", so this never reaches the fs.
    await expectFailure(dir, "DESCRIPTOR_INVALID");
  });

  it("rejects an absolute entry", async () => {
    expect(pluginDescriptorSchema.safeParse({ ...base(), entry: "/etc/passwd" }).success).toBe(
      false,
    );
    expect(
      pluginDescriptorSchema.safeParse({ ...base(), entry: "C:/windows/system32" }).success,
    ).toBe(false);
  });

  it("rejects an entry that does not exist", async () => {
    const dir = makePlugin("missing-entry", { entryFile: null });
    await expectFailure(dir, "ENTRY_MISSING");
  });

  it("rejects a plugin whose sdk range this Kiri cannot satisfy", async () => {
    const dir = makePlugin("old-sdk", {
      descriptor: { ...base(), id: "old-sdk", sdk: "^1.0.0" },
    });
    const error = await expectFailure(dir, "SDK_INCOMPATIBLE");
    expect(error.message).toContain("2.0.0-alpha.0");
  });

  it("rejects hosts that are not host names", async () => {
    for (const host of ["https://example.com", "example.com/path", "*", "*.*.com", "a..b"]) {
      expect(pluginDescriptorSchema.safeParse({ ...base(), hosts: [host] }).success).toBe(false);
    }
    expect(
      pluginDescriptorSchema.safeParse({ ...base(), hosts: ["example.com", "*.example.com"] })
        .success,
    ).toBe(true);
  });
});

function base(): Record<string, unknown> {
  return {
    id: "test-plugin",
    name: "Test",
    version: "1.0.0",
    sdk: "^2.0.0-alpha.0",
    entry: "./src/index.mjs",
    hosts: ["example.com"],
  };
}

describe("descriptorHashOf", () => {
  it("ignores key order and formatting", () => {
    const a = pluginDescriptorSchema.parse(base());
    const b = pluginDescriptorSchema.parse({
      hosts: ["example.com"],
      entry: "./src/index.mjs",
      sdk: "^2.0.0-alpha.0",
      version: "1.0.0",
      name: "Test",
      id: "test-plugin",
    });
    expect(descriptorHashOf(a)).toBe(descriptorHashOf(b));
  });

  it("changes when a host is added", () => {
    const a = pluginDescriptorSchema.parse(base());
    const b = pluginDescriptorSchema.parse({
      ...base(),
      hosts: ["example.com", "cdn.example.com"],
    });
    expect(descriptorHashOf(a)).not.toBe(descriptorHashOf(b));
  });

  it("serialises nested values deterministically", () => {
    expect(canonicalJson({ b: 1, a: [3, { d: 4, c: 5 }] })).toBe('{"a":[3,{"c":5,"d":4}],"b":1}');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("hostMatches", () => {
  it("matches an exact host, case- and dot-insensitively", () => {
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches("EXAMPLE.com", "example.com")).toBe(true);
    expect(hostMatches("example.com.", "example.com")).toBe(true);
    expect(hostMatches("evil-example.com", "example.com")).toBe(false);
    expect(hostMatches("example.com.evil.net", "example.com")).toBe(false);
  });

  it("treats a leading *. as exactly one label", () => {
    expect(hostMatches("cdn.example.com", "*.example.com")).toBe(true);
    expect(hostMatches("example.com", "*.example.com")).toBe(false);
    expect(hostMatches("a.b.example.com", "*.example.com")).toBe(false);
    expect(hostMatches(".example.com", "*.example.com")).toBe(false);
  });

  it("never matches an empty host or pattern", () => {
    expect(hostMatches("", "example.com")).toBe(false);
    expect(hostMatches("example.com", "")).toBe(false);
    expect(hostMatches("example.com", "*.")).toBe(false);
  });

  it("hostsMatch checks a whole list", () => {
    const hosts = ["mangadex.org", "*.mangadex.org"];
    expect(hostsMatch(hosts, "api.mangadex.org")).toBe(true);
    expect(hostsMatch(hosts, "mangadex.org")).toBe(true);
    expect(hostsMatch(hosts, "mangadex.org.evil.net")).toBe(false);
  });

  it("normalizeHostname and hostnameOf agree", () => {
    expect(normalizeHostname(" EXAMPLE.com. ")).toBe("example.com");
    expect(hostnameOf("https://Example.com/series/1")).toBe("example.com");
    expect(hostnameOf("http://127.0.0.1:8080/x")).toBe("127.0.0.1");
    expect(hostnameOf("ftp://example.com")).toBeNull();
    expect(hostnameOf("not a url")).toBeNull();
  });
});

describe("needsCookie", () => {
  it("is true only for the cookie capability", () => {
    expect(needsCookie({ capabilities: ["network"] })).toBe(false);
    expect(needsCookie({ capabilities: ["network", "cookie"] })).toBe(true);
    expect(needsCookie({ capabilities: [] })).toBe(false);
  });
});

describe("satisfies (the sdk range check)", () => {
  it("handles the operators a descriptor may use", () => {
    expect(satisfies("2.1.0", "^2.0.0")).toBe(true);
    expect(satisfies("3.0.0", "^2.0.0")).toBe(false);
    expect(satisfies("2.0.5", "~2.0.0")).toBe(true);
    expect(satisfies("2.1.0", "~2.0.0")).toBe(false);
    expect(satisfies("2.0.0", ">=2.0.0 <3.0.0")).toBe(true);
    expect(satisfies("2.0.0", "1.x || >=2.0.0")).toBe(true);
    expect(satisfies("2.0.0", "*")).toBe(true);
    expect(satisfies("2.0.0", "=2.0.0")).toBe(true);
    expect(satisfies("not-a-version", "*")).toBe(false);
  });

  it("keeps a prerelease out of a stable range (this is why plugins pin -alpha.0)", () => {
    expect(satisfies("2.0.0-alpha.0", "^2.0.0")).toBe(false);
    expect(satisfies("2.0.0-alpha.0", "^2.0.0-alpha.0")).toBe(true);
    expect(satisfies("2.0.0-alpha.1", "^2.0.0-alpha.0")).toBe(true);
    expect(satisfies("2.1.0-beta.1", "^2.0.0-alpha.0")).toBe(false);
    expect(satisfies("2.0.0", "^2.0.0-alpha.0")).toBe(true);
  });

  it("treats an unparseable range as any, so a typo cannot brick a plugin", () => {
    expect(satisfies("2.0.0", "definitely not a range")).toBe(true);
  });

  it("parses versions with build metadata", () => {
    expect(parseVersion("1.2.3+build.5")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("v1.2.3")).toMatchObject({ major: 1 });
    expect(parseVersion("1.2")).toBeNull();
  });
});
