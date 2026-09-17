#!/usr/bin/env node
/**
 * Package a plugin directory as an installable zip.
 *
 *   npm run plugin:zip -- mangadex            # packages/sources/mangadex → dist/plugins/mangadex.zip
 *   npm run plugin:zip -- ./path/to/plugin    # any directory containing kiri-plugin.json
 *
 * The zip has kiri-plugin.json at its root (what the installer expects) and
 * includes package.json, src/**, README.md and LICENSE when present. Entries
 * are stored uncompressed (plugins are tiny); no dependencies needed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
if (!arg) {
  console.error("usage: npm run plugin:zip -- <plugin id under packages/sources | directory>");
  process.exit(2);
}
const dir =
  existsSync(path.resolve(arg)) && statSync(path.resolve(arg)).isDirectory()
    ? path.resolve(arg)
    : path.join(root, "packages", "sources", arg);
const descriptorPath = path.join(dir, "kiri-plugin.json");
if (!existsSync(descriptorPath)) {
  console.error(`no kiri-plugin.json in ${dir}`);
  process.exit(2);
}
const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));

const INCLUDE_FILES = ["kiri-plugin.json", "package.json", "README.md", "LICENSE"];
const INCLUDE_DIRS = ["src"];

function walk(base, rel, out) {
  for (const entry of readdirSync(path.join(base, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(base, relPath, out);
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
}

const files = [];
for (const name of INCLUDE_FILES) if (existsSync(path.join(dir, name))) files.push(name);
for (const sub of INCLUDE_DIRS) if (existsSync(path.join(dir, sub))) walk(dir, sub, files);

// CRC-32 (IEEE), table driven.
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const locals = [];
const centrals = [];
let offset = 0;
const now = dosDateTime(new Date());
for (const rel of files) {
  const data = readFileSync(path.join(dir, rel));
  const name = Buffer.from(rel, "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // utf-8 names
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(now.time, 10);
  local.writeUInt16LE(now.day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(now.time, 12);
  central.writeUInt16LE(now.day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  locals.push(local, name, data);
  centrals.push(central, name);
  offset += local.length + name.length + data.length;
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const zip = Buffer.concat([...locals, ...centrals, end]);
const outDir = path.join(root, "dist", "plugins");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${descriptor.id}.zip`);
writeFileSync(outFile, zip);
const sha = createHash("sha256").update(zip).digest("hex").slice(0, 12);
console.log(
  `${path.relative(root, outFile)}  ${files.length} files  ${zip.length} bytes  sha256:${sha}`,
);
