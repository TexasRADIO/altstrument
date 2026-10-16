/**
 * Display labels, tones and short definitions for the schema enums.
 * Definitions follow the comments in src/content/schema.ts.
 */
import type { Distribution, SourceStatus, Status, Kind, DeviceImage, ManufacturerLogo } from '@/content/schema';

export type Tone = 'green' | 'blue' | 'amber' | 'red' | 'gray' | 'violet';

export const STATUS_INFO: Record<Status, { label: string; tone: Tone; desc: string }> = {
  active: { label: 'Active', tone: 'green', desc: 'Commits or releases within roughly the last year.' },
  maintained: {
    label: 'Maintained',
    tone: 'blue',
    desc: 'Stable, with infrequent updates; the author is still responsive.',
  },
  dormant: { label: 'Dormant', tone: 'amber', desc: 'No activity for a long time, but still usable.' },
  archived: { label: 'Archived', tone: 'gray', desc: 'Explicitly archived or abandoned by the author.' },
  announced: {
    label: 'Announced',
    tone: 'violet',
    desc: 'Publicly announced, with nothing downloadable yet.',
  },
  unknown: { label: 'Unknown', tone: 'gray', desc: 'Project state has not been established.' },
};

export const SOURCE_INFO: Record<SourceStatus, { label: string; tone: Tone; desc: string }> = {
  open: { label: 'open', tone: 'green', desc: 'Full source is published.' },
  'patcher-only': {
    label: 'patcher only',
    tone: 'blue',
    desc: 'The patch tooling is public; the firmware changes themselves are not.',
  },
  'binary-only': { label: 'binary only', tone: 'amber', desc: 'Only compiled images are distributed.' },
  closed: { label: 'closed', tone: 'red', desc: 'Nothing is public.' },
};

export const DISTRIBUTION_LABELS: Record<Distribution, string> = {
  download: 'Prebuilt image you flash yourself',
  'browser-installer': 'Browser installer (WebMIDI / WebUSB)',
  'patch-your-own': 'Patches a stock file you supply',
  commercial: 'Commercial (paid)',
  'source-only': 'Build from source yourself',
};

export const KIND_LABELS: Record<Kind, string> = {
  firmware: 'Firmware',
  tool: 'Tool',
};

export const LICENSE_SENTINELS: Record<string, string> = {
  proprietary: 'All rights reserved, or custom non-open terms.',
  unspecified: 'No license file or statement was found.',
};

export function isSpdx(license: string): boolean {
  return !(license in LICENSE_SENTINELS);
}

export function spdxUrl(license: string): string {
  return `https://spdx.org/licenses/${encodeURIComponent(license)}.html`;
}

/** Heuristic for image licenses: "CC-BY-SA-4.0" yes, "manufacturer press kit" no. */
export function looksLikeSpdx(license: string): boolean {
  return /^[A-Z0-9.-]+$/.test(license) && /\d/.test(license);
}

/** The schema's `credit` may or may not already start with "Photo:"; show it once. */
export function creditName(credit: string): string {
  return credit.replace(/^\s*photo\s*(?:by\b\s*:?|:)\s*/i, '').trim() || credit;
}

/**
 * Caption lead-in for a device image, shown before the license and source link.
 *   photo:    "Photo: Jane Doe"
 *   line-art: "Line art by altstrument, after the Elektron product image"
 */
export function imageCreditLabel(image: Pick<DeviceImage, 'style' | 'credit'>): string {
  if (image.style === 'line-art') {
    const after = image.credit.replace(/^\s*(?:line art\b.*?,\s*)?after\s+/i, '').trim() || image.credit.trim();
    return `Line art by altstrument, after ${after}`;
  }
  return `Photo: ${creditName(image.credit)}`;
}

/**
 * Caption lead-in for a manufacturer logo: "Logo: <credit>". The credit is shown
 * once even if it already starts with "Logo:".
 */
export function logoCreditLabel(logo: Pick<ManufacturerLogo, 'credit'>): string {
  const name = logo.credit.replace(/^\s*logo\s*(?:by\b\s*:?|:)\s*/i, '').trim() || logo.credit.trim();
  return `Logo: ${name}`;
}
