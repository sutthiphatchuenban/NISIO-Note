/**
 * Generates assets/icon.ico with no dependencies.
 *
 * The mark is drawn analytically (signed distance fields) so every icon size
 * is antialiased at its native resolution instead of being scaled from one
 * bitmap. Run with `bun scripts/make-icon.ts`.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const OUT = "assets/icon.ico";
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function roundedRectSdf(
  x: number,
  y: number,
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
) {
  const qx = Math.abs(x - cx) - (halfWidth - radius);
  const qy = Math.abs(y - cy) - (halfHeight - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

function segmentDistance(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = x - ax;
  const apy = y - ay;
  const lengthSq = abx * abx + aby * aby || 1;
  const t = Math.min(1, Math.max(0, (apx * abx + apy * aby) / lengthSq));
  return Math.hypot(apx - abx * t, apy - aby * t);
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** Returns RGBA pixels, top-down. */
function render(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const center = size / 2;
  const half = size * 0.44;
  const radius = size * 0.215;

  // "N" geometry in unit space.
  const pad = size * 0.005;
  const ax = size * 0.315 + pad;
  const bx = size * 0.315 + pad;
  const cx = size * 0.685 - pad;
  const dx = size * 0.685 - pad;
  const top = size * 0.245 + pad;
  const bottom = size * 0.755 - pad;
  const stroke = Math.max(0.7, size * 0.062);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px + 0.5;
      const y = py + 0.5;

      const background = clamp01(0.5 - roundedRectSdf(x, y, center, center, half, half, radius));
      if (background <= 0) continue;

      const t = clamp01((x + y) / (2 * size));
      let r = mix(0x5b, 0x8b, t);
      let g = mix(0x6c, 0x5c, t);
      let b = mix(0xff, 0xf6, t);

      const distance = Math.min(
        segmentDistance(x, y, ax, bottom, bx, top),
        segmentDistance(x, y, bx, top, cx, bottom),
        segmentDistance(x, y, cx, bottom, dx, top),
      );
      const mark = clamp01(0.5 + stroke - distance) * background;
      if (mark > 0) {
        r = mix(r, 255, mark);
        g = mix(g, 255, mark);
        b = mix(b, 255, mark);
      }

      const offset = (py * size + px) * 4;
      pixels[offset] = Math.round(r);
      pixels[offset + 1] = Math.round(g);
      pixels[offset + 2] = Math.round(b);
      pixels[offset + 3] = Math.round(background * 255);
    }
  }

  return pixels;
}

function dibFor(size: number): Buffer {
  const pixels = render(size);
  const rowBytes = size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(rowBytes * size, 20);

  const pixelsBuffer = Buffer.alloc(rowBytes * size);
  for (let row = 0; row < size; row++) {
    const sourceRow = size - 1 - row;
    for (let column = 0; column < size; column++) {
      const source = (sourceRow * size + column) * 4;
      const target = row * rowBytes + column * 4;
      pixelsBuffer[target] = pixels[source + 2]!;
      pixelsBuffer[target + 1] = pixels[source + 1]!;
      pixelsBuffer[target + 2] = pixels[source]!;
      pixelsBuffer[target + 3] = pixels[source + 3]!;
    }
  }

  const mask = Buffer.alloc(maskRowBytes * size);
  return Buffer.concat([header, pixelsBuffer, mask]);
}

const images = SIZES.map((size) => ({ size, data: dibFor(size) }));

const directorySize = 6 + images.length * 16;
let offset = directorySize;

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

const directory: Buffer[] = [];
for (const image of images) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
  entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += image.data.length;
  directory.push(entry);
}

const ico = Buffer.concat([header, ...directory, ...images.map((image) => image.data)]);

await mkdir(dirname(OUT), { recursive: true });
await Bun.write(OUT, ico);
console.log(`Wrote ${OUT} (${(ico.length / 1024).toFixed(1)} KB, ${SIZES.length} sizes)`);
