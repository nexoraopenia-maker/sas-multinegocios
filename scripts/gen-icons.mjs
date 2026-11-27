// Genera los íconos PNG de la PWA sin dependencias. Ejecutar solo si cambia el diseño.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(size, scale) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const bars = [[0, 2], [3, 1], [5, 3], [9, 1], [11, 2], [14, 1], [16, 2]]; // código de barras
  const w = size * 0.56 * scale, h = size * 0.46 * scale, x0 = (size - w) / 2, y0 = (size - h) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = ((x - x0) / w) * 18;
    const white = y >= y0 && y < y0 + h && bars.some(([s, l]) => u >= s && u < s + l);
    raw.set(white ? [255, 255, 255] : [15, 107, 95], y * (size * 3 + 1) + 1 + x * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const [name, size, scale] of [['icon-192', 192, 1.2], ['icon-512', 512, 1.2], ['maskable-512', 512, 0.95], ['apple-touch-icon', 180, 1.1]]) {
  writeFileSync(new URL(`../public/icons/${name}.png`, import.meta.url), png(size, scale));
}
