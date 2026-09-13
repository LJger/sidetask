import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

// A code-drawn app mark; no external font, image, or build-time graphics dependency.
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
await mkdir(assets, { recursive: true });
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const value of buffer) c = crcTable[(c ^ value) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([header, name, data, checksum]);
}
function roundRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(right - radius, x));
  const cy = Math.max(top + radius, Math.min(bottom - radius, y));
  return x >= left && x <= right && y >= top && y <= bottom && (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}
function segment(x, y, ax, ay, bx, by, thickness) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) <= thickness / 2;
}
function polygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i], [bx, by] = points[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
function pixel(x, y, small = false) {
  if (!roundRect(x, y, .025, .025, .975, .975, .24)) return [0, 0, 0, 0];
  const shade = Math.max(0, Math.min(1, (x + y) / 2));
  let color = [Math.round(53 - shade * 23), Math.round(112 - shade * 38), Math.round(87 - shade * 27), 255];
  if (roundRect(x, y, .235, .214, .765, .842, .085)) color = [31, 70, 53, 255];
  if (roundRect(x, y, .225, .19, .755, .81, .085)) color = [245, 250, 245, 255];
  const check = segment(x, y, .315, .422, .401, .512, .058) || segment(x, y, .401, .512, .557, .352, .058);
  if (check) color = [40, 91, 70, 255];
  if (!small && (segment(x, y, .315, .645, .578, .645, .027) || segment(x, y, .315, .718, .489, .718, .027))) color = [141, 174, 152, 255];
  if (polygon(x, y, [[.64,.165],[.785,.165],[.785,.50],[.7125,.449],[.64,.50]])) color = [161, 204, 179, 255];
  return color;
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const sample = pixel((x + (sx + .5) / 4) / size, (y + (sy + .5) / 4) / size, size < 24);
        for (let c = 0; c < 3; c++) sum[c] += sample[c] * sample[3] / 255;
        sum[3] += sample[3];
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[offset + c] = sum[3] ? Math.round(sum[c] * 255 / sum[3]) : 0;
      raw[offset + 3] = Math.round(sum[3] / 16);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16, 20, 24, 32, 48, 64, 128, 256];
const images = sizes.map(png);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}
await writeFile(path.join(assets, 'icon.png'), png(512));
await writeFile(path.join(assets, 'tray.png'), png(32));
await writeFile(path.join(assets, 'icon.ico'), Buffer.concat([header, ...images]));
await writeFile(path.join(assets, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#357057"/><stop offset="1" stop-color="#1e4a3c"/></linearGradient></defs><rect x="8" y="8" width="304" height="304" rx="77" fill="url(#g)"/><rect x="75.2" y="68.5" width="169.6" height="201" rx="27.2" fill="#1f4635"/><rect x="72" y="60.8" width="169.6" height="198.4" rx="27.2" fill="#f5faf5"/><path d="m100.8 135 27.5 28.8 50-51.2" fill="none" stroke="#285b46" stroke-width="18.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M100.8 206.4H185M100.8 229.8H156.5" stroke="#8dae98" stroke-width="8.6" stroke-linecap="round"/><path d="M204.8 52.8h46.4V160L228 143.7 204.8 160Z" fill="#a1ccb3"/></svg>\n');
process.stdout.write('Generated 512px app icon, tray icon, SVG master and 8-size Windows ICO.\n');
