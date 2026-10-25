// Generates the app's placeholder assets with no external tools:
//   assets/ring.wav  — a gentle two-tone doorbell loop
//   assets/icon.png  — a simple bell icon (256x256)
// Replace either with your own artwork; the build just needs these paths.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
fs.mkdirSync(assets, { recursive: true });

// ---- ring.wav -------------------------------------------------------------
// A 2.4 s "ding-dong" that loops: two descending tones with a soft envelope.

function makeRing() {
  const rate = 44100;
  const dur = 2.4;
  const n = Math.floor(rate * dur);
  const data = Buffer.alloc(n * 2);

  const tone = (t, f) => Math.sin(2 * Math.PI * f * t);
  // Two chimes within the loop, each a quick attack + long decay.
  const chimes = [
    { start: 0.0, f1: 660, f2: 528 },
    { start: 1.1, f1: 660, f2: 528 },
  ];

  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let s = 0;
    for (const c of chimes) {
      const dt = t - c.start;
      if (dt < 0 || dt > 1.0) continue;
      const env = Math.exp(-3.2 * dt) * (1 - Math.exp(-60 * dt));
      // Ding then dong.
      const f = dt < 0.35 ? c.f1 : c.f2;
      s += env * (tone(dt, f) * 0.6 + tone(dt, f * 2) * 0.12);
    }
    const v = Math.max(-1, Math.min(1, s)) * 0.8;
    data.writeInt16LE((v * 32767) | 0, i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  fs.writeFileSync(path.join(assets, 'ring.wav'), Buffer.concat([header, data]));
}

// ---- icon.png -------------------------------------------------------------
// A minimal 256x256 PNG drawn by hand: a bell glyph on a rounded blue tile.

function makeIcon() {
  const size = 256;
  const px = Buffer.alloc(size * size * 4);

  const bg = [76, 141, 255, 255]; // blue
  const bell = [255, 255, 255, 255];

  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3];
  };

  const r = 48;
  const inRounded = (x, y) => {
    const nx = Math.min(x, size - 1 - x);
    const ny = Math.min(y, size - 1 - y);
    if (nx >= r || ny >= r) return true;
    const dx = r - nx;
    const dy = r - ny;
    return dx * dx + dy * dy <= r * r;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRounded(x, y)) set(x, y, bg);
      else set(x, y, [0, 0, 0, 0]);
    }
  }

  // Bell body: a trapezoid-ish dome with a clapper.
  const cx = 128;
  for (let y = 70; y < 180; y++) {
    const prog = (y - 70) / 110;
    const halfW = 20 + prog * 55;
    for (let x = cx - halfW; x <= cx + halfW; x++) set(Math.round(x), y, bell);
  }
  // Rim
  for (let x = cx - 85; x <= cx + 85; x++) { set(x, 181, bell); set(x, 182, bell); }
  // Top knob
  for (let y = 56; y < 72; y++) for (let x = cx - 8; x <= cx + 8; x++) set(x, y, bell);
  // Clapper
  for (let y = 186; y < 202; y++) {
    const hw = 10 - (y - 186) * 0.1;
    for (let x = cx - hw; x <= cx + hw; x++) set(Math.round(x), y, bell);
  }

  fs.writeFileSync(path.join(assets, 'icon.png'), encodePng(px, size, size));
}

// Minimal PNG encoder (truecolor+alpha, single IDAT, zlib deflate).
function encodePng(rgba, width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

makeRing();
makeIcon();
console.log('Assets generados en assets/.');
