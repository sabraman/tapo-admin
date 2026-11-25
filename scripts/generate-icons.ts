import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT_DIR = join(import.meta.dir, "..");
const ASSETS_DIR = join(ROOT_DIR, "assets");
const ICONSET_DIR = join(ASSETS_DIR, "icon.iconset");

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = data.length;
  const out = Buffer.allocUnsafe(12 + len);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  const crc = crc32(out.subarray(4, 8 + len));
  out.writeUInt32BE(crc, 8 + len);
  return out;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = 0; // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const compressed = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(entries: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.allocUnsafe(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.allocUnsafe(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  for (let i = 0; i < entries.length; i++) {
    const { size, png } = entries[i]!;
    const dim = size >= 256 ? 0 : size;
    const base = i * 16;
    dir[base] = dim;
    dir[base + 1] = dim;
    dir[base + 2] = 0;
    dir[base + 3] = 0;
    dir.writeUInt16LE(1, base + 4);
    dir.writeUInt16LE(32, base + 6);
    dir.writeUInt32LE(png.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += png.length;
  }

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sdRoundBox(px: number, py: number, bx: number, by: number, r: number): number {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function sampleAppIcon(u: number, v: number, pixelWidth: number): [number, number, number, number] {
  // Normalized coordinates in [0, 512] matching assets/icon.svg
  const x = u * 512;
  const y = v * 512;
  const aa = 512 / pixelWidth;

  const boxD = sdRoundBox(x - 256, y - 256, 228, 228, 108);
  const outerAlpha = 1 - smoothstep(-aa * 0.7, aa * 0.7, boxD);
  if (outerAlpha <= 0.001) return [0, 0, 0, 0];

  // Background gradient (#1e293b -> #090d16)
  const gt = Math.max(0, Math.min(1, ((x - 64) + (y - 32)) / (384 + 448)));
  let r = mix(30, 9, gt);
  let g = mix(41, 13, gt);
  let b = mix(59, 22, gt);

  // Subtle tile border (#334155)
  const borderMask = 1 - smoothstep(0, aa * 1.2, Math.abs(boxD + 4) - 3.5);
  r = mix(r, 51, borderMask * 0.9);
  g = mix(g, 65, borderMask * 0.9);
  b = mix(b, 85, borderMask * 0.9);

  const dx = x - 256;
  const dy = y - 256;
  const dist = Math.hypot(dx, dy);

  // Outer housing bezel (#0b1220 fill, #1e293b rim)
  const housingMask = 1 - smoothstep(-aa * 0.7, aa * 0.7, dist - 144);
  if (housingMask > 0) {
    r = mix(r, 11, housingMask);
    g = mix(g, 18, housingMask);
    b = mix(b, 32, housingMask);

    const rimMask = 1 - smoothstep(-aa * 0.7, aa * 0.7, Math.abs(dist - 144) - 3);
    r = mix(r, 30, rimMask);
    g = mix(g, 41, rimMask);
    b = mix(b, 59, rimMask);
  }

  // Cyan aperture ring (radius 112, stroke width 20 -> [102..122])
  const ringDist = Math.abs(dist - 112) - 10;
  const ringMask = 1 - smoothstep(-aa * 0.7, aa * 0.7, ringDist);
  if (ringMask > 0) {
    const rt = Math.max(0, Math.min(1, ((x - 140) + (y - 140)) / 464));
    const cr = rt < 0.5 ? mix(56, 6, rt * 2) : mix(6, 8, (rt - 0.5) * 2);
    const cg = rt < 0.5 ? mix(189, 182, rt * 2) : mix(182, 145, (rt - 0.5) * 2);
    const cb = rt < 0.5 ? mix(248, 212, rt * 2) : mix(212, 178, (rt - 0.5) * 2);
    r = mix(r, cr, ringMask);
    g = mix(g, cg, ringMask);
    b = mix(b, cb, ringMask);
  }

  // Inner lens glass (radius 80)
  const glassMask = 1 - smoothstep(-aa * 0.7, aa * 0.7, dist - 80);
  if (glassMask > 0) {
    const gx = (x - (256 - 12)) / 96;
    const gy = (y - (256 - 18)) / 96;
    const gr = Math.min(1, Math.hypot(gx, gy));
    const lr = gr < 0.65 ? mix(22, 11, gr / 0.65) : mix(11, 3, (gr - 0.65) / 0.35);
    const lg = gr < 0.65 ? mix(78, 19, gr / 0.65) : mix(19, 7, (gr - 0.65) / 0.35);
    const lb = gr < 0.65 ? mix(99, 36, gr / 0.65) : mix(36, 18, (gr - 0.65) / 0.35);
    r = mix(r, lr, glassMask);
    g = mix(g, lg, glassMask);
    b = mix(b, lb, glassMask);

    // Core aperture pupil (radius 34)
    const coreMask = 1 - smoothstep(-aa * 0.7, aa * 0.7, dist - 34);
    r = mix(r, 4, coreMask);
    g = mix(g, 8, coreMask);
    b = mix(b, 18, coreMask);

    const coreRim = 1 - smoothstep(-aa * 0.7, aa * 0.7, Math.abs(dist - 34) - 2);
    r = mix(r, 14, coreRim);
    g = mix(g, 116, coreRim);
    b = mix(b, 144, coreRim);

    // Specular highlights
    const spec1 = 1 - smoothstep(-aa * 0.7, aa * 0.7, Math.hypot(x - 222, y - 220) - 18);
    r = mix(r, 103, spec1 * 0.45);
    g = mix(g, 232, spec1 * 0.45);
    b = mix(b, 249, spec1 * 0.45);

    const spec2 = 1 - smoothstep(-aa * 0.7, aa * 0.7, Math.hypot(x - 286, y - 288) - 7);
    r = mix(r, 56, spec2 * 0.25);
    g = mix(g, 189, spec2 * 0.25);
    b = mix(b, 248, spec2 * 0.25);
  }

  // Live emerald indicator dot at (382, 130)
  const dotDist = Math.hypot(x - 382, y - 130);
  const dotCutout = 1 - smoothstep(-aa * 0.7, aa * 0.7, dotDist - 30);
  if (dotCutout > 0) {
    r = mix(r, 9, dotCutout);
    g = mix(g, 13, dotCutout);
    b = mix(b, 22, dotCutout);
  }
  const dotFill = 1 - smoothstep(-aa * 0.7, aa * 0.7, dotDist - 21);
  if (dotFill > 0) {
    r = mix(r, 16, dotFill);
    g = mix(g, 185, dotFill);
    b = mix(b, 129, dotFill);

    const dotHighlight = 1 - smoothstep(-aa * 0.7, aa * 0.7, Math.hypot(x - 376, y - 124) - 6);
    r = mix(r, 167, dotHighlight * 0.7);
    g = mix(g, 243, dotHighlight * 0.7);
    b = mix(b, 208, dotHighlight * 0.7);
  }

  return [
    Math.round(Math.max(0, Math.min(255, r))),
    Math.round(Math.max(0, Math.min(255, g))),
    Math.round(Math.max(0, Math.min(255, b))),
    Math.round(Math.max(0, Math.min(255, outerAlpha * 255))),
  ];
}

function sampleTrayTemplate(u: number, v: number, pixelWidth: number): [number, number, number, number] {
  // Monochrome template glyph in 36x36 coordinate space (macOS uses alpha channel of black pixels)
  const x = u * 36;
  const y = v * 36;
  const aa = 36 / pixelWidth;

  const boxD = sdRoundBox(x - 18, y - 18, 14.5, 14.5, 4.5);
  const boxFill = 1 - smoothstep(-aa * 0.7, aa * 0.7, boxD);

  // Carve circular lens ring & live dot cutout for high legibility at 18pt
  const dist = Math.hypot(x - 18, y - 18);
  const ringGap = 1 - smoothstep(-aa * 0.7, aa * 0.7, Math.abs(dist - 8.2) - 1.7);
  const dotCutout = 1 - smoothstep(-aa * 0.7, aa * 0.7, Math.hypot(x - 26.5, y - 9.5) - 2.4);

  const alpha = Math.max(0, boxFill * (1 - ringGap) * (1 - dotCutout));
  return [0, 0, 0, Math.round(alpha * 255)];
}

function renderIcon(
  size: number,
  sampler: (u: number, v: number, pixelWidth: number) => [number, number, number, number],
): Buffer {
  const ss = size >= 512 ? 2 : 4;
  const rgba = new Uint8Array(size * size * 4);
  const invTotal = 1 / (ss * ss);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const [r, g, b, a] = sampler(u, v, size);
          const wf = a / 255;
          sr += r * wf;
          sg += g * wf;
          sb += b * wf;
          sa += a;
        }
      }

      const idx = (y * size + x) * 4;
      const avgAlpha = sa * invTotal;
      if (avgAlpha > 0.5) {
        const wSum = sa / 255;
        rgba[idx] = Math.round(sr / wSum);
        rgba[idx + 1] = Math.round(sg / wSum);
        rgba[idx + 2] = Math.round(sb / wSum);
        rgba[idx + 3] = Math.round(avgAlpha);
      }
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(ICONSET_DIR, { recursive: true });

const iconsetSpecs: Array<{ name: string; size: number }> = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

const pngCache = new Map<number, Buffer>();
function getAppPng(size: number): Buffer {
  let buf = pngCache.get(size);
  if (!buf) {
    buf = renderIcon(size, sampleAppIcon);
    pngCache.set(size, buf);
  }
  return buf;
}

for (const spec of iconsetSpecs) {
  writeFileSync(join(ICONSET_DIR, spec.name), getAppPng(spec.size));
}

const winIco = encodeIco(
  [16, 32, 48, 256].map((size) => ({ size, png: getAppPng(size) })),
);
writeFileSync(join(ASSETS_DIR, "icon.ico"), winIco);

const trayTemplate = renderIcon(36, sampleTrayTemplate);
writeFileSync(join(ASSETS_DIR, "tray-Template.png"), trayTemplate);

const trayIco = encodeIco(
  [16, 32].map((size) => ({ size, png: getAppPng(size) })),
);
writeFileSync(join(ASSETS_DIR, "tray.ico"), trayIco);

console.log("Generated app icons in assets/icon.iconset, assets/icon.ico, assets/tray-Template.png, assets/tray.ico");
