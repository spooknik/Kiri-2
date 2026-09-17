/**
 * Minimal but *valid* image bytes, built by hand so the tests never depend on
 * a fixture file or an image library. Each helper produces a real header the
 * SDK's sniffer and dimension parsers must accept.
 */
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** A real 8-bit RGB PNG filled with one colour. */
export function makePng(
  width: number,
  height: number,
  rgb: [number, number, number] = [1, 2, 3],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** JFIF header + a baseline SOF0 frame carrying the dimensions. */
export function makeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  sof.set([0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 10);
  return Buffer.concat([app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** GIF89a header (screen descriptor holds the dimensions) plus the trailer. */
export function makeGif(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(14);
  buffer.write("GIF89a", 0, "latin1");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  buffer[13] = 0x3b;
  return buffer;
}

/** Extended WebP (`VP8X`): the canvas size lives in the chunk header. */
export function makeWebpExtended(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write("VP8X", 12, "latin1");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

/** Lossless WebP (`VP8L`): 14 bits of width and height packed into 4 bytes. */
export function makeWebpLossless(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(25);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(17, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write("VP8L", 12, "latin1");
  buffer.writeUInt32LE(5, 16);
  buffer[20] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  buffer[21] = w & 0xff;
  buffer[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  buffer[23] = (h >> 2) & 0xff;
  buffer[24] = (h >> 10) & 0x0f;
  return buffer;
}
