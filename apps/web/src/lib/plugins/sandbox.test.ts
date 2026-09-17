/**
 * Sandbox flag derivation and the `warn`-mode diagnostic.
 *
 * The exact flags matter: they were arrived at empirically against Node 24 and
 * the template plugin (see the comment at the top of `sandbox.ts`), and getting
 * one wrong turns "sandboxed" into "broken" or "not sandboxed at all".
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginDescriptor } from "@/lib/contracts/plugins";
import {
  describeAccessDenial,
  isAccessDenied,
  isUnsandboxed,
  parseAccessDenial,
  sandboxArgs,
} from "@/lib/plugins/sandbox";

type Descriptor = Pick<PluginDescriptor, "capabilities" | "sandbox">;

const strict: Descriptor = { capabilities: ["network"], sandbox: "strict" };
const relaxed: Descriptor = { capabilities: ["network"], sandbox: "relaxed" };
const browser: Descriptor = { capabilities: ["network", "browser"], sandbox: "strict" };

const paths = {
  pluginDir: path.resolve("/data/plugins/demo"),
  sdkDir: path.resolve("/app/sdk/2.0.0"),
  outputDir: path.resolve("/data/library/series-1"),
  tmpDir: path.resolve("/data/tmp/jobs/job-1"),
};

const originalPlaywright = process.env["PLAYWRIGHT_BROWSERS_PATH"];

afterEach(() => {
  if (originalPlaywright === undefined) delete process.env["PLAYWRIGHT_BROWSERS_PATH"];
  else process.env["PLAYWRIGHT_BROWSERS_PATH"] = originalPlaywright;
});

describe("sandboxArgs", () => {
  it("allows reading the plugin, the SDK, the output and the temp dir", () => {
    const args = sandboxArgs(strict, paths, "on");

    expect(args[0]).toBe("--permission");
    expect(args).toContain(`--allow-fs-read=${paths.pluginDir}`);
    // The SDK lives behind a junction/symlink and Node checks the resolved
    // path, so it needs its own allowance.
    expect(args).toContain(`--allow-fs-read=${paths.sdkDir}`);
    // The output directory needs READ as well: the SDK re-reads manifest.json
    // on every checkpoint.
    expect(args).toContain(`--allow-fs-read=${paths.outputDir}`);
    expect(args).toContain(`--allow-fs-write=${paths.outputDir}`);
    expect(args).toContain(`--allow-fs-read=${paths.tmpDir}`);
    expect(args).toContain(`--allow-fs-write=${paths.tmpDir}`);
  });

  it("never grants write to the plugin or SDK directories", () => {
    const args = sandboxArgs(strict, paths, "on");
    expect(args).not.toContain(`--allow-fs-write=${paths.pluginDir}`);
    expect(args).not.toContain(`--allow-fs-write=${paths.sdkDir}`);
  });

  it("omits the output directory for verbs that write nothing", () => {
    const args = sandboxArgs(strict, { ...paths, outputDir: null }, "on");
    expect(args.some((arg) => arg.includes("library"))).toBe(false);
    expect(args).toContain(`--allow-fs-read=${paths.pluginDir}`);
  });

  it("adds child-process rights for browser and subprocess plugins", () => {
    expect(sandboxArgs(browser, paths, "on")).toContain("--allow-child-process");
    expect(sandboxArgs({ capabilities: ["subprocess"], sandbox: "strict" }, paths, "on")).toContain(
      "--allow-child-process",
    );
    expect(sandboxArgs(strict, paths, "on")).not.toContain("--allow-child-process");
  });

  it("allows the Playwright browser cache when one is configured", () => {
    process.env["PLAYWRIGHT_BROWSERS_PATH"] = path.resolve("/ms-playwright");
    const args = sandboxArgs(browser, paths, "on");
    expect(args).toContain(`--allow-fs-read=${path.resolve("/ms-playwright")}`);
  });

  it("is empty when the sandbox is off", () => {
    expect(sandboxArgs(strict, paths, "off")).toEqual([]);
  });

  it("is empty for a plugin the admin let out of the sandbox", () => {
    expect(sandboxArgs(relaxed, paths, "on")).toEqual([]);
    expect(sandboxArgs(relaxed, paths, "warn")).toEqual([]);
    expect(isUnsandboxed(relaxed, "on")).toBe(true);
    expect(isUnsandboxed(strict, "on")).toBe(false);
    expect(isUnsandboxed(strict, "off")).toBe(true);
  });

  it("does not repeat a path that plays two roles", () => {
    const shared = path.resolve("/data/shared");
    const args = sandboxArgs(
      strict,
      {
        pluginDir: shared,
        sdkDir: shared,
        outputDir: shared,
        tmpDir: shared,
      },
      "on",
    );
    expect(args.filter((arg) => arg.startsWith("--allow-fs-read="))).toHaveLength(1);
    expect(args.filter((arg) => arg.startsWith("--allow-fs-write="))).toHaveLength(1);
  });
});

describe("access-denied diagnostics", () => {
  // Verbatim from Node 24 on Windows.
  const stderr = [
    "Error: Access to this API has been restricted. Use --allow-fs-read to manage permissions.",
    "    at Object.openSync (node:fs:560:18) {",
    "  code: 'ERR_ACCESS_DENIED',",
    "  permission: 'FileSystemRead',",
    "  resource: '\\\\\\\\?\\\\C:\\\\app\\\\sdk\\\\2.0.0\\\\dist\\\\index.js'",
    "}",
  ].join("\n");

  it("recognises a permission failure", () => {
    expect(isAccessDenied(stderr)).toBe(true);
    expect(isAccessDenied("ordinary plugin noise")).toBe(false);
  });

  it("names the denied path and permission", () => {
    const denial = parseAccessDenial(stderr);
    expect(denial.permission).toBe("FileSystemRead");
    expect(denial.resource).toBe("C:\\app\\sdk\\2.0.0\\dist\\index.js");
  });

  it("explains what it is about to do", () => {
    const message = describeAccessDenial("demo", stderr);
    expect(message).toContain("demo");
    expect(message).toContain("C:\\app\\sdk\\2.0.0\\dist\\index.js");
    expect(message).toContain("KIRI_PLUGIN_SANDBOX=on");
  });

  it("degrades gracefully when Node reported no resource", () => {
    const denial = parseAccessDenial("code: 'ERR_ACCESS_DENIED'");
    expect(denial.resource).toBeNull();
    expect(describeAccessDenial("demo", "code: 'ERR_ACCESS_DENIED'")).toContain(
      "an unreported path",
    );
  });
});
