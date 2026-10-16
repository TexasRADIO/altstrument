/**
 * Social preview cards (og:image), rendered at build time with Takumi.
 * src/pages/og/[...path].png.ts calls renderCard once per page; Base.astro points
 * og:image at the result. 1200x630, the light palette from global.css.
 *
 * Text is set in Geist, the font Takumi bundles (Latin only). Takumi never reads
 * system fonts, so a name in another script would need a font passed to the Renderer.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render } from 'takumi-js';
import { Renderer } from 'takumi-js/node';
import { container, image, text, type Node } from 'takumi-js/helpers';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

export interface CardInput {
  /** Small accent line above the title, e.g. "Firmware for Digitakt · Elektron". */
  eyebrow?: string;
  title: string;
  summary?: string;
  /** Site-relative path under public/ (device photo or manufacturer logo). */
  visual?: string;
  /** Right side of the bottom strip, e.g. "12 firmwares and tools". */
  footer?: string;
}

// Light tokens from src/styles/global.css.
const C = {
  bg: '#f8f8f4',
  surface: '#ffffff',
  line: '#d6d6cc',
  fg: '#1a1a17',
  muted: '#55554d',
  accent: '#0a6262',
};

// The mark from src/components/Logo.astro, filled with the accent. Takumi rasterizes SVG itself.
const MARK_SRC = 'altstrument-mark.svg';
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3 5 26 22" width="52" height="44">
  <defs><mask id="alt">
    <rect width="32" height="32" fill="#fff"/>
    <path d="M7 21V13L9 11H11L13 13V21H11V18H9V21ZM9 13V16H11V13Z" fill="#000" fill-rule="evenodd"/>
    <path d="M15 11H17V19H19V21H15Z" fill="#000"/>
    <path d="M19 11H25V13H23V21H21V13H19Z" fill="#000"/>
  </mask></defs>
  <path d="M8.5 5V8M13.5 5V8M18.5 5V8M23.5 5V8M8.5 24V27M13.5 24V27M18.5 24V27M23.5 24V27" fill="none" stroke="${C.accent}" stroke-width="1"/>
  <rect x="3" y="8" width="26" height="16" rx="3" fill="${C.accent}" mask="url(#alt)"/>
</svg>`;

// One renderer for the whole build, so fonts and decoded images are reused across pages.
const renderer = new Renderer();

// Many firmware cards share one device photo; read each file once.
const files = new Map<string, Promise<Uint8Array>>();
function publicFile(src: string): Promise<Uint8Array> {
  let data = files.get(src);
  if (!data) {
    data = readFile(join(process.cwd(), 'public', src));
    files.set(src, data);
  }
  return data;
}

function card({ eyebrow, title, summary, visual, footer }: CardInput): Node {
  const copy = container({
    style: { display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 18 },
    children: [
      eyebrow && text(eyebrow, { fontSize: 28, fontWeight: 600, color: C.accent, lineClamp: 1, textOverflow: 'ellipsis' }),
      text(title, { fontSize: 64, fontWeight: 700, lineHeight: 1.08, color: C.fg, lineClamp: 2, textOverflow: 'ellipsis' }),
      summary && text(summary, { fontSize: 30, lineHeight: 1.35, color: C.muted, lineClamp: 3, textOverflow: 'ellipsis' }),
    ].filter(Boolean) as Node[],
  });

  const picture =
    visual &&
    container({
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Landscape: most device photos are wider than tall.
        width: 460,
        height: 340,
        flexShrink: 0,
        padding: 20,
        backgroundColor: C.surface,
        border: `2px solid ${C.line}`,
        borderRadius: 16,
      },
      children: [image({ src: visual, style: { width: '100%', height: '100%', objectFit: 'contain' } })],
    });

  return container({
    style: {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      padding: '52px 64px 0',
      backgroundColor: C.bg,
      color: C.fg,
    },
    children: [
      container({
        style: { display: 'flex', alignItems: 'center', gap: 16 },
        children: [
          image({ src: MARK_SRC, style: { width: 52, height: 44 } }),
          text('altstrument', { fontSize: 34, fontWeight: 600, letterSpacing: -0.5 }),
        ],
      }),
      container({
        style: { display: 'flex', alignItems: 'center', flexGrow: 1, gap: 48 },
        children: [copy, picture].filter(Boolean) as Node[],
      }),
      container({
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          height: 80,
          borderTop: `2px solid ${C.line}`,
          fontSize: 26,
          color: C.muted,
        },
        children: [
          text('altstrument.org'),
          footer && text(footer, { maxWidth: 780, lineClamp: 1, textOverflow: 'ellipsis' }),
        ].filter(Boolean) as Node[],
      }),
    ],
  });
}

export async function renderCard(input: CardInput): Promise<Uint8Array<ArrayBuffer>> {
  const images: { src: string; data: Uint8Array }[] = [{ src: MARK_SRC, data: new TextEncoder().encode(MARK) }];
  if (input.visual) images.push({ src: input.visual, data: await publicFile(input.visual) });
  return render(card(input), { renderer, width: OG_WIDTH, height: OG_HEIGHT, format: 'png', images });
}
