/**
 * make-icons.js — rasterize the sidebranch mark into the extension's PNGs.
 *
 * Run offline, by hand, when the mark changes:
 *
 *     node scripts/make-icons.js
 *
 * Not a build step and not part of `npm test` — the four PNGs are committed,
 * exactly like the WOFF2 font, and this file exists so they are reproducible
 * rather than mysterious. It is deliberately not published (`files` in
 * package.json excludes it).
 *
 * Zero dependencies, so everything here is hand-rolled: the mark is the same
 * path served in shell.html's favicon, flattened from cubic Béziers into
 * polygons, filled with a nonzero-winding scanline pass at 4x supersampling,
 * and written out through Node's own zlib as a PNG. That is a lot of words
 * for "draw a rounded square with a letterform in it", but the alternative is
 * a rendering dependency, and this repo does not take those.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
const SIZES = [16, 32, 48, 128];

const BG = [0x19, 0x19, 0x19];
const FG = [0xff, 0xff, 0xff];

// The mark, in a 100x100 viewBox: a rounded-rect plate, then the glyph on top
// (translate(14.85 14.85) scale(0.7), baked into the coordinates below).
const PLATE_RADIUS = 20;
const GLYPH = "M45 11C50.5228 11 55 15.4772 55 21V39H40C34.4772 39 30 43.4772 30 49V78C30 83.5228 34.4772 88 40 88H26C20.4772 88 16 83.5228 16 78V21C16 15.4772 20.4772 11 26 11H45ZM73 39C78.5228 39 83 43.4772 83 49V78C83 83.5228 78.5228 88 73 88H45C50.5228 88 55 83.5228 55 78V39H73Z";
const GLYPH_OFFSET = 14.85;
const GLYPH_SCALE = 0.7;

/* ------------------------------ path -> polygons --------------------------- */

/**
 * A minimal SVG path reader: absolute M/L/H/V/C/Z only, which is all the mark
 * uses. Anything else is a hard error rather than a silent misdraw — if the
 * mark is ever redrawn with an arc or a relative command, this should stop.
 */
function toPolygons(d, steps = 24) {
  const tokens = d.match(/[MLHVCZ]|-?\d*\.?\d+/gi) ?? [];
  const polys = [];
  let poly = null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let i = 0;
  const num = () => Number(tokens[i++]);

  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (!/[MLHVCZ]/i.test(cmd)) throw new Error(`unsupported path token: ${cmd}`);
    if (cmd === "M") {
      if (poly?.length) polys.push(poly);
      cx = num(); cy = num(); sx = cx; sy = cy;
      poly = [[cx, cy]];
    } else if (cmd === "L") {
      cx = num(); cy = num(); poly.push([cx, cy]);
    } else if (cmd === "H") {
      cx = num(); poly.push([cx, cy]);
    } else if (cmd === "V") {
      cy = num(); poly.push([cx, cy]);
    } else if (cmd === "C") {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        poly.push([
          u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
          u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
        ]);
      }
      cx = x; cy = y;
    } else {
      poly.push([sx, sy]);
      polys.push(poly);
      poly = null;
      cx = sx; cy = sy;
    }
  }
  if (poly?.length) polys.push(poly);
  return polys;
}

function roundedRect(x, y, w, h, r, steps = 24) {
  const poly = [];
  const corner = (ccx, ccy, from) => {
    for (let s = 0; s <= steps; s++) {
      const a = from + (Math.PI / 2) * (s / steps);
      poly.push([ccx + r * Math.cos(a), ccy + r * Math.sin(a)]);
    }
  };
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  corner(x + w - r, y + r, -Math.PI / 2);
  poly.push(poly[0]);
  return [poly];
}

function transform(polys, scale, offset) {
  return polys.map((p) => p.map(([x, y]) => [x * scale + offset, y * scale + offset]));
}

/* --------------------------------- raster ---------------------------------- */

/** Nonzero winding: the counter-drawn hole in the glyph depends on it. */
function windingAt(polys, px, py) {
  let w = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly.length - 1; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[i + 1];
      if (y1 <= py) {
        if (y2 > py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) > 0) w++;
      } else if (y2 <= py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) < 0) w--;
    }
  }
  return w;
}

function coverage(polys, x, y, unit, ss = 4) {
  let hits = 0;
  for (let sy = 0; sy < ss; sy++) {
    for (let sx = 0; sx < ss; sx++) {
      const px = (x + (sx + 0.5) / ss) * unit;
      const py = (y + (sy + 0.5) / ss) * unit;
      if (windingAt(polys, px, py) !== 0) hits++;
    }
  }
  return hits / (ss * ss);
}

function render(size) {
  const unit = 100 / size;
  const plate = roundedRect(0, 0, 100, 100, PLATE_RADIUS);
  const glyph = transform(toPolygons(GLYPH), GLYPH_SCALE, GLYPH_OFFSET);
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(plate, x, y, unit);
      const g = coverage(glyph, x, y, unit);
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[o + c] = Math.round(BG[c] * (1 - g) + FG[c] * g);
      }
      rgba[o + 3] = Math.round(255 * a);
    }
  }
  return rgba;
}

/* ---------------------------------- PNG ------------------------------------ */

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolor + alpha
  // Filter byte 0 (None) per scanline: at these sizes the win from real
  // filtering is a few hundred bytes and the code is 40 more lines.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, render(size)));
  process.stdout.write(`${path.relative(process.cwd(), file)}  ${fs.statSync(file).size} B\n`);
}
