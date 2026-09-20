/**
 * Generates the placeholder artwork used by the AMPED-01 scaffold.
 *
 * Why generated rather than downloaded: the scaffold must be self-contained,
 * must not depend on a third-party image host being up, and must not ship
 * photographs nobody has licensed. These files are abstract stage-lighting
 * artwork sized to the real poster (3:4) and hero (16:9) slots, so layout,
 * contrast and loading behaviour can be judged honestly.
 *
 * Event titles are NOT baked into the artwork. Typography is rendered in HTML
 * over the image, which keeps one consistent type system across the site and
 * avoids an SVG loaded via <img> falling back to whatever condensed face the
 * viewer happens to have installed.
 *
 * AMPED-05A replaces every one of these with a real R2 upload. Deleting this
 * script and public/media at that point is expected and correct.
 *
 * Run: node scripts/generate-artwork.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'media');
mkdirSync(OUT, { recursive: true });

/** Stage-lighting palettes. Each gig gets a different rig. */
const PALETTES = {
  voltage: ['#E8FF3A', '#FF3B6B', '#12121A'],
  wash: ['#FF3B6B', '#7C4DFF', '#0D0B14'],
  cyan: ['#3BE0FF', '#E8FF3A', '#08121A'],
  ember: ['#FF8A1A', '#FF2E4D', '#160B08'],
  mint: ['#3BE07A', '#3BE0FF', '#07140F'],
  ultra: ['#B04CFF', '#3BE0FF', '#0B0818'],
  rose: ['#FF6FA8', '#FFC93B', '#160A12'],
};

const noise = (id) => `
  <filter id="${id}" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" stitchTiles="stitch" seed="7"/>
    <feColorMatrix type="saturate" values="0"/>
  </filter>`;

const grain = (id, opacity = 0.16) =>
  `<rect width="100%" height="100%" filter="url(#${id})" opacity="${opacity}" style="mix-blend-mode:overlay"/>`;

/** Motifs give each poster its own identity without any typography. */
const MOTIFS = {
  beams(w, h, [a, b]) {
    let out = '';
    for (let i = 0; i < 7; i += 1) {
      const x = (w / 6) * i - w * 0.15;
      const colour = i % 2 === 0 ? a : b;
      out += `<polygon points="${x},0 ${x + w * 0.09},0 ${x - w * 0.28},${h} ${x - w * 0.52},${h}"
        fill="${colour}" opacity="${0.07 + (i % 3) * 0.035}"/>`;
    }
    return out;
  },
  rings(w, h, [a, b]) {
    let out = '';
    const cx = w * 0.5;
    const cy = h * 0.42;
    for (let i = 10; i > 0; i -= 1) {
      out += `<circle cx="${cx}" cy="${cy}" r="${i * (w * 0.062)}" fill="none"
        stroke="${i % 2 === 0 ? a : b}" stroke-width="${1 + i * 0.35}" opacity="${0.05 + i * 0.022}"/>`;
    }
    return out;
  },
  waveform(w, h, [a, b]) {
    let out = '';
    const bars = 34;
    const gap = w / bars;
    for (let i = 0; i < bars; i += 1) {
      const t = i / bars;
      const amp = Math.abs(Math.sin(t * 7.4) * Math.cos(t * 2.1)) * 0.46 + 0.05;
      const bh = h * amp;
      out += `<rect x="${i * gap + gap * 0.18}" y="${h * 0.72 - bh}" width="${gap * 0.64}" height="${bh}"
        fill="${i % 5 === 0 ? b : a}" opacity="${0.16 + (i % 4) * 0.06}" rx="${gap * 0.18}"/>`;
    }
    return out;
  },
  halftone(w, h, [a, b]) {
    let out = '';
    const cols = 16;
    const step = w / cols;
    for (let x = 0; x < cols; x += 1) {
      for (let y = 0; y < Math.round(cols * (h / w)); y += 1) {
        const d = Math.hypot(x / cols - 0.5, (y * step) / h - 0.38);
        const r = Math.max(0, (0.52 - d) * step * 0.95);
        if (r > 0.4) {
          out += `<circle cx="${x * step + step / 2}" cy="${y * step + step / 2}" r="${r.toFixed(2)}"
            fill="${(x + y) % 7 === 0 ? b : a}" opacity="0.30"/>`;
        }
      }
    }
    return out;
  },
  grid(w, h, [a, b]) {
    let out = '';
    for (let i = 1; i < 14; i += 1) {
      out += `<line x1="0" y1="${(h / 14) * i}" x2="${w}" y2="${(h / 14) * i}" stroke="${a}"
        stroke-width="1" opacity="${0.05 + (i % 3) * 0.03}"/>`;
    }
    for (let i = 1; i < 10; i += 1) {
      out += `<line x1="${(w / 10) * i}" y1="0" x2="${(w / 10) * i}" y2="${h}" stroke="${b}"
        stroke-width="1" opacity="0.06"/>`;
    }
    out += `<circle cx="${w * 0.5}" cy="${h * 0.4}" r="${w * 0.3}" fill="${b}" opacity="0.10"/>`;
    return out;
  },
  scan(w, h, [a, b]) {
    let out = `<rect x="0" y="${h * 0.3}" width="${w}" height="${h * 0.34}" fill="${a}" opacity="0.10"/>`;
    for (let i = 0; i < 60; i += 1) {
      out += `<rect x="0" y="${(h / 60) * i}" width="${w}" height="${h / 190}" fill="${i % 9 === 0 ? b : a}"
        opacity="${0.04 + (i % 5) * 0.02}"/>`;
    }
    return out;
  },
  crowd(w, h, [a, b]) {
    // Abstract silhouetted heads and raised arms along the bottom edge.
    let out = `<rect x="0" y="${h * 0.62}" width="${w}" height="${h * 0.38}" fill="#000" opacity="0.55"/>`;
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 46; i += 1) {
      const x = rnd() * w;
      const r = w * (0.016 + rnd() * 0.014);
      const y = h * (0.78 + rnd() * 0.18);
      out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#000" opacity="0.85"/>`;
      if (rnd() > 0.72) {
        out += `<rect x="${(x - r * 0.25).toFixed(1)}" y="${(y - r * 5).toFixed(1)}" width="${(r * 0.5).toFixed(1)}"
          height="${(r * 4).toFixed(1)}" rx="${(r * 0.25).toFixed(1)}" fill="#000" opacity="0.8"/>`;
      }
    }
    out += `<ellipse cx="${w * 0.5}" cy="${h * 0.66}" rx="${w * 0.55}" ry="${h * 0.16}" fill="${b}" opacity="0.13"/>`;
    out += `<ellipse cx="${w * 0.3}" cy="${h * 0.52}" rx="${w * 0.2}" ry="${h * 0.3}" fill="${a}" opacity="0.10"/>`;
    return out;
  },
};

function artwork({ width, height, palette, motif, glowY = 0.3 }) {
  const [a, b, base] = PALETTES[palette];
  const id = `${palette}-${motif}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="presentation">
  <defs>
    <radialGradient id="key-${id}" cx="50%" cy="${glowY * 100}%" r="78%">
      <stop offset="0%" stop-color="${a}" stop-opacity="0.55"/>
      <stop offset="45%" stop-color="${b}" stop-opacity="0.24"/>
      <stop offset="100%" stop-color="${base}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="floor-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${base}" stop-opacity="0"/>
      <stop offset="70%" stop-color="#000" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.9"/>
    </linearGradient>
    ${noise(`grain-${id}`)}
  </defs>
  <rect width="${width}" height="${height}" fill="${base}"/>
  ${MOTIFS[motif](width, height, [a, b, base])}
  <rect width="${width}" height="${height}" fill="url(#key-${id})"/>
  <rect width="${width}" height="${height}" fill="url(#floor-${id})"/>
  ${grain(`grain-${id}`)}
</svg>
`;
}

const POSTER = { width: 900, height: 1200 };
const HERO = { width: 1920, height: 1080 };
const SQUARE = { width: 800, height: 800 };
const WIDE = { width: 1200, height: 800 };

/** [filename, spec] - keep in sync with src/data/fixtures/media.ts */
const FILES = [
  ['poster-glass-hearts.svg', { ...POSTER, palette: 'voltage', motif: 'beams' }],
  ['poster-northern-static.svg', { ...POSTER, palette: 'cyan', motif: 'waveform' }],
  ['poster-velvet-antler.svg', { ...POSTER, palette: 'ultra', motif: 'rings' }],
  ['poster-ledger.svg', { ...POSTER, palette: 'ember', motif: 'halftone' }],
  ['poster-winter-amp.svg', { ...POSTER, palette: 'mint', motif: 'grid' }],
  ['poster-saltwater.svg', { ...POSTER, palette: 'rose', motif: 'scan' }],
  ['poster-hollow-coast.svg', { ...POSTER, palette: 'wash', motif: 'beams' }],
  ['poster-brass-tacks.svg', { ...POSTER, palette: 'voltage', motif: 'halftone' }],
  ['poster-paper-lions.svg', { ...POSTER, palette: 'cyan', motif: 'rings' }],
  ['poster-spring-amp.svg', { ...POSTER, palette: 'ember', motif: 'waveform' }],

  ['hero-glass-hearts.svg', { ...HERO, palette: 'voltage', motif: 'crowd', glowY: 0.28 }],
  ['hero-northern-static.svg', { ...HERO, palette: 'cyan', motif: 'crowd', glowY: 0.3 }],
  ['hero-velvet-antler.svg', { ...HERO, palette: 'ultra', motif: 'crowd', glowY: 0.26 }],
  ['hero-ledger.svg', { ...HERO, palette: 'ember', motif: 'crowd', glowY: 0.32 }],
  ['hero-hollow-coast.svg', { ...HERO, palette: 'wash', motif: 'crowd', glowY: 0.3 }],
  ['hero-brass-tacks.svg', { ...HERO, palette: 'rose', motif: 'crowd', glowY: 0.28 }],

  ['artist-glass-hearts.svg', { ...SQUARE, palette: 'voltage', motif: 'rings' }],
  ['artist-northern-static.svg', { ...SQUARE, palette: 'cyan', motif: 'waveform' }],
  ['artist-velvet-antler.svg', { ...SQUARE, palette: 'ultra', motif: 'halftone' }],
  ['artist-ledger.svg', { ...SQUARE, palette: 'ember', motif: 'grid' }],
  ['artist-saltwater-parade.svg', { ...SQUARE, palette: 'rose', motif: 'rings' }],
  ['artist-hollow-coast.svg', { ...SQUARE, palette: 'wash', motif: 'scan' }],
  ['artist-brass-tacks.svg', { ...SQUARE, palette: 'mint', motif: 'waveform' }],
  ['artist-paper-lions.svg', { ...SQUARE, palette: 'cyan', motif: 'beams' }],
  ['artist-mara-veil.svg', { ...SQUARE, palette: 'ultra', motif: 'rings' }],
  ['artist-second-city-sound.svg', { ...SQUARE, palette: 'voltage', motif: 'grid' }],

  ['gallery-01.svg', { ...WIDE, palette: 'voltage', motif: 'crowd', glowY: 0.3 }],
  ['gallery-02.svg', { ...WIDE, palette: 'cyan', motif: 'crowd', glowY: 0.24 }],
  ['gallery-03.svg', { ...WIDE, palette: 'ultra', motif: 'beams' }],
  ['gallery-04.svg', { ...WIDE, palette: 'ember', motif: 'crowd', glowY: 0.34 }],
  ['gallery-05.svg', { ...WIDE, palette: 'rose', motif: 'halftone' }],
  ['gallery-06.svg', { ...WIDE, palette: 'mint', motif: 'crowd', glowY: 0.28 }],
  ['gallery-07.svg', { ...WIDE, palette: 'wash', motif: 'waveform' }],
  ['gallery-08.svg', { ...WIDE, palette: 'cyan', motif: 'scan' }],
  ['gallery-09.svg', { ...WIDE, palette: 'voltage', motif: 'crowd', glowY: 0.22 }],
  ['gallery-10.svg', { ...WIDE, palette: 'ember', motif: 'beams' }],
  ['gallery-11.svg', { ...WIDE, palette: 'ultra', motif: 'crowd', glowY: 0.36 }],
  ['gallery-12.svg', { ...WIDE, palette: 'rose', motif: 'crowd', glowY: 0.3 }],

  ['social-01.svg', { ...SQUARE, palette: 'voltage', motif: 'crowd', glowY: 0.3 }],
  ['social-02.svg', { ...SQUARE, palette: 'cyan', motif: 'halftone' }],
  ['social-03.svg', { ...SQUARE, palette: 'rose', motif: 'crowd', glowY: 0.26 }],
  ['social-04.svg', { ...SQUARE, palette: 'ultra', motif: 'waveform' }],

  ['og-default.svg', { width: 1200, height: 630, palette: 'voltage', motif: 'beams' }],
];

let written = 0;
for (const [name, spec] of FILES) {
  writeFileSync(join(OUT, name), artwork(spec), 'utf8');
  written += 1;
}
console.log(`generate-artwork: wrote ${written} files to public/media`);
