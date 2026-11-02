/** Generates <dir>/icon-<size>.png (a stopwatch) with no image dependency: node scripts/icons.mjs <dir> <sizes> */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function icon(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const c = size / 2;
  const r = size * 0.42;
  const cy = c + size * 0.04;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d = Math.hypot(px - c, py - cy);
      let rgba = [0, 0, 0, 0];
      const crown = Math.abs(px - c) < size * 0.08 && py > size * 0.02 && py < cy - r + size * 0.04;
      if (d <= r || crown) rgba = [21, 128, 61, 255];
      if (d <= r * 0.78) rgba = [255, 255, 255, 255];
      const hand = (Math.abs(px - c) < Math.max(1, size * 0.05) && py < cy && py > cy - r * 0.62) ||
        (Math.abs(py - cy) < Math.max(1, size * 0.05) && px > c && px < c + r * 0.45);
      if (d <= r * 0.78 && hand) rgba = [21, 128, 61, 255];
      raw.set(rgba, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = process.argv[2] ?? 'static/icons';
mkdirSync(dir, { recursive: true });
for (const size of (process.argv[3] ?? "16,32,48,128").split(",").map(Number)) {
  writeFileSync(`${dir}/icon-${size}.png`, icon(size));
}
