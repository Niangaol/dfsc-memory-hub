#!/usr/bin/env node
/**
 * 生成插件图标：128×128 PNG，零依赖（手写 PNG 编码 + zlib）。
 *
 * 图形：深色圆角底 + 记忆芯片（发光边框、四角触点）+ 三条渐隐的"记忆轨道"，
 * 表达"沉积、检索、随时间巩固"这件事，而不是一个通用齿轮。
 *
 * 运行：node scripts/make-icon.mjs
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'memory-hub', 'icon.png');

const BACKGROUND_TOP = [24, 30, 46];
const BACKGROUND_BOTTOM = [14, 18, 30];
const CHIP_FILL = [30, 41, 63];
const ACCENT = [96, 208, 255];
const ACCENT_SOFT = [64, 156, 214];
const WARM = [255, 196, 120];

const pixels = new Uint8Array(SIZE * SIZE * 3);

function mix(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

function blend(x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || alpha <= 0) return;
  const index = (y * SIZE + x) * 3;
  const clamped = Math.min(1, alpha);
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[index + channel] = Math.round(pixels[index + channel] * (1 - clamped) + color[channel] * clamped);
  }
}

function roundedRect(x0, y0, x1, y1, radius) {
  const inside = (px, py) => {
    const cx = Math.max(x0 + radius, Math.min(px, x1 - radius));
    const cy = Math.max(y0 + radius, Math.min(py, y1 - radius));
    return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
  };
  return inside;
}

// 背景：垂直渐变 + 圆角裁切 + 顶部一抹冷光
const insideBackground = roundedRect(2, 2, SIZE - 2, SIZE - 2, 26);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const index = (y * SIZE + x) * 3;
    if (!insideBackground(x + 0.5, y + 0.5)) {
      pixels[index] = 0;
      pixels[index + 1] = 0;
      pixels[index + 2] = 0;
      continue;
    }
    const base = mix(BACKGROUND_TOP, BACKGROUND_BOTTOM, y / SIZE);
    const glow = Math.max(0, 1 - Math.hypot(x - 44, y - 26) / 78) * 0.22;
    pixels[index] = Math.round(base[0] + ACCENT[0] * glow);
    pixels[index + 1] = Math.round(base[1] + ACCENT[1] * glow);
    pixels[index + 2] = Math.round(base[2] + ACCENT[2] * glow);
  }
}

// 芯片主体：圆角矩形 + 上下左右各三个触点
const chip = roundedRect(26, 32, 102, 96, 12);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    if (!chip(x + 0.5, y + 0.5)) continue;
    const edge = Math.min(x - 26, 102 - x, y - 32, 96 - y);
    blend(x, y, CHIP_FILL, edge < 2 ? 0.95 : 0.72);
  }
}

// 芯片边框：一圈亮线，靠外侧更亮
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const inside = chip(x + 0.5, y + 0.5);
    const neighbourOutside = !chip(x - 1 + 0.5, y + 0.5) || !chip(x + 1 + 0.5, y + 0.5)
      || !chip(x + 0.5, y - 1 + 0.5) || !chip(x + 0.5, y + 1 + 0.5);
    if (inside && neighbourOutside) blend(x, y, ACCENT, 0.85);
  }
}

// 触点：上下各三根，两侧各两根，向芯片外延伸 8 px
const pins = [
  [42, 32, 0, -1], [64, 32, 0, -1], [86, 32, 0, -1],
  [42, 96, 0, 1], [64, 96, 0, 1], [86, 96, 0, 1],
  [26, 48, -1, 0], [26, 78, -1, 0],
  [102, 48, 1, 0], [102, 78, 1, 0],
];
for (const [px, py, dx, dy] of pins) {
  for (let step = 0; step <= 8; step += 1) {
    const x = px + dx * step;
    const y = py + dy * step;
    blend(x, y, step > 6 ? ACCENT : ACCENT_SOFT, step > 6 ? 0.95 : 0.55);
    if (dx === 0) blend(x + 1, y, ACCENT_SOFT, 0.35);
    else blend(x, y + 1, ACCENT_SOFT, 0.35);
  }
}

// 记忆轨道：三条横线，长度与亮度递减，最后一条用暖色表示"最近一次"
const rows = [
  { y: 50, from: 38, to: 90, color: ACCENT, alpha: 0.95 },
  { y: 64, from: 38, to: 80, color: ACCENT_SOFT, alpha: 0.8 },
  { y: 78, from: 38, to: 66, color: WARM, alpha: 0.9 },
];
for (const row of rows) {
  for (let x = row.from; x <= row.to; x += 1) {
    const fade = 1 - (x - row.from) / (row.to - row.from + 1);
    blend(x, row.y, row.color, row.alpha * (0.55 + 0.45 * fade));
    blend(x, row.y + 1, row.color, row.alpha * 0.25 * (0.55 + 0.45 * fade));
  }
  // 轨道末端的圆点，像一次命中被点亮
  const dotX = row.to + 4;
  for (let dy = -3; dy <= 3; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const distance = Math.hypot(dx, dy);
      if (distance > 3.4) continue;
      blend(dotX + dx, row.y + dy, row.color, Math.max(0, 1 - distance / 3.4));
    }
  }
}

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const offset = y * (SIZE * 3 + 1);
  raw[offset] = 0; // filter: none
  pixels.subarray(y * SIZE * 3, (y + 1) * SIZE * 3).forEach((value, index) => {
    raw[offset + 1 + index] = value;
  });
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 2; // colour type: truecolour
header[10] = 0;
header[11] = 0;
header[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(OUT, png);
process.stdout.write(`wrote ${OUT} (${png.length} bytes, ${SIZE}x${SIZE})\n`);
