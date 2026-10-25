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

// A clean app icon: a rounded-square tile with a vertical blue gradient and a
// simple white bell. Rendered at 4x and box-downsampled for smooth edges, so no
// image library is needed.
function makeIcon() {
  const size = 256;
  const SS = 4; // supersample factor
  const N = size * SS;
  const hi = new Float32Array(N * N * 4);

  const cx = N / 2;
  const tileR = 0.223 * N; // corner radius of the tile

  // Rounded-rect signed test (true inside).
  const inTile = (x, y) => {
    const nx = Math.min(x, N - x);
    const ny = Math.min(y, N - y);
    if (nx >= tileR && ny >= tileR) return true;
    const dx = Math.max(tileR - nx, 0);
    const dy = Math.max(tileR - ny, 0);
    return dx * dx + dy * dy <= tileR * tileR;
  };

  const circle = (x, y, ox, oy, r) => (x - ox) ** 2 + (y - oy) ** 2 <= r * r;

  // Bell silhouette as a union of simple shapes, in icon units scaled to N.
  const u = N / 256;
  const bell = (x, y) => {
    const bx = x / u;
    const by = y / u;
    const mx = 128;
    // knob + neck
    if (circle(bx, by, mx, 72, 15)) return true;
    if (bx > mx - 8 && bx < mx + 8 && by > 70 && by < 96) return true;
    // shoulders/dome
    if (circle(bx, by, mx, 120, 44) && by < 128) return true;
    // flaring skirt
    if (by >= 118 && by <= 176) {
      const half = 38 + ((by - 118) / 58) * 32; // 38 -> 70
      if (bx > mx - half && bx < mx + half) return true;
    }
    // rim
    if (by >= 172 && by <= 190 && bx > mx - 76 && bx < mx + 76) return true;
    // clapper
    if (circle(bx, by, mx, 202, 13)) return true;
    return false;
  };

  for (let y = 0; y < N; y++) {
    const t = y / N;
    // gradient: top #4ca6ff -> bottom #0a63be
    const br = 76 + (10 - 76) * t;
    const bg = 166 + (99 - 166) * t;
    const bb = 255 + (190 - 255) * t;
    for (let x = 0; x < N; x++) {
      const o = (y * N + x) * 4;
      if (!inTile(x, y)) {
        hi[o + 3] = 0;
        continue;
      }
      if (bell(x, y)) {
        hi[o] = 255;
        hi[o + 1] = 255;
        hi[o + 2] = 255;
      } else {
        hi[o] = br;
        hi[o + 1] = bg;
        hi[o + 2] = bb;
      }
      hi[o + 3] = 255;
    }
  }

  // Box downsample SSxSS -> 1x with straight-alpha averaging.
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * N + (x * SS + sx)) * 4;
          const al = hi[o + 3] / 255;
          r += hi[o] * al;
          g += hi[o + 1] * al;
          b += hi[o + 2] * al;
          a += hi[o + 3];
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const o = (y * size + x) * 4;
      if (alpha > 0) {
        const wsum = a / 255;
        px[o] = Math.round(r / wsum);
        px[o + 1] = Math.round(g / wsum);
        px[o + 2] = Math.round(b / wsum);
      }
      px[o + 3] = Math.round(alpha);
    }
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
