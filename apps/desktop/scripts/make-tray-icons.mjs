// Rasterises the Loop mark (the stroke in src/renderer/src/components/Logo.tsx) into the tray PNGs in resources/.
// No dependencies: a distance-to-polyline coverage test, supersampled, written with node:zlib.
// Run: node apps/desktop/scripts/make-tray-icons.mjs   (the generated files are committed)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "../resources");
const STROKE = 4.5; // in the logo's 40x40 viewBox

// "M6.5 33.5 L11.81 28.19 A13 13 0 1 1 18.74 31.8": a tail, then a large clockwise arc (r=13) back near the start.
function arcPoints([x1, y1], [x2, y2], r, largeArc, sweep, steps = 120) {
  // SVG endpoint -> centre parameterisation (no rotation, circle)
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const d = Math.sqrt(Math.max(0, (r * r - dx * dx - dy * dy) / (dx * dx + dy * dy)));
  const sign = largeArc === sweep ? -1 : 1;
  const cx = (x1 + x2) / 2 + sign * d * dy;
  const cy = (y1 + y2) / 2 - sign * d * dx;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  let delta = Math.atan2(y2 - cy, x2 - cx) - a1;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  return Array.from({ length: steps + 1 }, (_, i) => [cx + r * Math.cos(a1 + (delta * i) / steps), cy + r * Math.sin(a1 + (delta * i) / steps)]);
}
const line = [[6.5, 33.5], [11.81, 28.19]];
const path = [...line, ...arcPoints([11.81, 28.19], [18.74, 31.8], 13, 1, 1).slice(1)];

function distToSegment([px, py], [ax, ay], [bx, by]) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
const covered = (p) => path.slice(1).some((b, i) => distToSegment(p, path[i], b) <= STROKE / 2); // round caps come for free

function render(size, rgb) {
  const SS = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) if (covered([((x + (sx + 0.5) / SS) * 40) / size, ((y + (sy + 0.5) / SS) * 40) / size])) hits++;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw.set([...rgb, Math.round((255 * hits) / (SS * SS))], o);
    }
  }
  return png(size, raw);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}
function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync(out, { recursive: true });
const files = {
  // macOS template image: black + alpha, the OS tints it for light/dark menu bars (the "Template" suffix is the signal)
  "trayTemplate.png": render(16, [0, 0, 0]),
  "trayTemplate@2x.png": render(32, [0, 0, 0]),
  // Windows / Linux: the accent colour (moss-300)
  "tray.png": render(16, [0xb4, 0xd0, 0x8c]),
  "tray@2x.png": render(32, [0xb4, 0xd0, 0x8c]),
};
for (const [name, data] of Object.entries(files)) writeFileSync(join(out, name), data);
console.log(`wrote ${Object.keys(files).join(", ")} to ${out}`);
