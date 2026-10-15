/**
 * Rasterizes public/favicon.svg into the bitmap fallbacks:
 *   public/favicon.ico          16, 32 and 48 px PNG frames
 *   public/apple-touch-icon.png 180 px on a solid background (iOS shows transparency as black)
 * Run by hand after changing the SVG: `pnpm icons`. The outputs are committed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const pub = (p: string) => fileURLToPath(new URL(`../public/${p}`, import.meta.url));

// Bitmaps can't follow prefers-color-scheme, so render the light colors only.
const svg = Buffer.from(readFileSync(pub('favicon.svg'), 'utf8').replace(/^.*@media.*$/m, ''));

const render = (size: number) => sharp(svg, { density: (72 * size) / 32 }).resize(size, size).png().toBuffer();

/** ICO container holding PNG frames: ICONDIR, one ICONDIRENTRY per frame, then the payloads. */
function ico(frames: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); // width (0 = 256)
    header.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
    header.writeUInt8(0, e + 2); // palette colors
    header.writeUInt8(0, e + 3); // reserved
    header.writeUInt16LE(1, e + 4); // color planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.png)]);
}

// At 16px the ALT strokes fall between pixels and smear, so that frame is
// hand-pixeled instead: # package, + rounded corner, . clear.
const PIXEL16 = [
  '.+############+.',
  '+##############+',
  '################',
  '################',
  '###..##.###...##',
  '##.##.#.####.###',
  '##.##.#.####.###',
  '##.##.#.####.###',
  '##....#.####.###',
  '##.##.#.####.###',
  '##.##.#.####.###',
  '##.##.#...##.###',
  '################',
  '################',
  '+##############+',
  '.+############+.',
];
function pixel16(): Promise<Buffer> {
  const alpha: Record<string, number> = { '#': 255, '+': 128, '.': 0 };
  const raw = Buffer.alloc(16 * 16 * 4);
  PIXEL16.join('').split('').forEach((ch, i) => {
    raw.set([0x0a, 0x62, 0x62, alpha[ch]], i * 4);
  });
  return sharp(raw, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
}

const frames = await Promise.all(
  [16, 32, 48].map(async (size) => ({ size, png: size === 16 ? await pixel16() : await render(size) })),
);
writeFileSync(pub('favicon.ico'), ico(frames));

const touch = 180;
const mark = Math.round(touch * 0.72);
const pad = Math.round((touch - mark) / 2);
writeFileSync(
  pub('apple-touch-icon.png'),
  await sharp(await render(mark))
    .extend({ top: pad, bottom: touch - mark - pad, left: pad, right: touch - mark - pad, background: '#f8f8f4' })
    .flatten({ background: '#f8f8f4' })
    .png()
    .toBuffer(),
);

console.log('Wrote public/favicon.ico and public/apple-touch-icon.png');
