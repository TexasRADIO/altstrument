/**
 * Standalone catalog validator.
 *
 * Runs before `astro build` (see package.json) and in CI. It re-parses every
 * YAML file with the same Zod schemas Astro uses, then applies cross-file rules
 * Zod cannot express on its own:
 *
 *   - firmware directory name must equal the `device` field
 *   - `device` must point at an existing device file
 *   - `related` device slugs must exist
 *   - every device should have at least one firmware or an explanatory `notes`
 *   - file names must be kebab-case slugs
 *
 * Exit code 1 on any error. Warnings are printed but do not fail the run.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { parse } from 'yaml';
import { deviceSchema, firmwareBaseSchema, manufacturerSchema, refineFirmware } from '../src/content/schema';
import { slugify } from '../src/lib/slug';
import { z } from 'astro/zod';

const ROOT = new URL('..', import.meta.url).pathname;
const DEVICES_DIR = join(ROOT, 'src/content/devices');
const FIRMWARES_DIR = join(ROOT, 'src/content/firmwares');
const MANUFACTURERS_DIR = join(ROOT, 'src/content/manufacturers');
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const firmwareSchema = refineFirmware(
  firmwareBaseSchema.extend({ device: z.string().regex(SLUG) }),
);

const errors: string[] = [];
const warnings: string[] = [];
const rel = (p: string) => relative(ROOT, p);

function fail(file: string, msg: string) {
  errors.push(`${rel(file)}: ${msg}`);
}
function warn(file: string, msg: string) {
  warnings.push(`${rel(file)}: ${msg}`);
}

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((i) => `  - ${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`)
    .join('\n');
}

function listYaml(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'))
    .map((n) => join(dir, n))
    .sort();
}

function loadYaml(file: string): unknown {
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(file, `YAML parse error: ${(e as Error).message}`);
    return undefined;
  }
}

// ---- devices ---------------------------------------------------------------

const deviceSlugs = new Set<string>();
const deviceNotes = new Map<string, string | undefined>();
const deviceRelated = new Map<string, string[]>();
const deviceManufacturers = new Set<string>();

for (const file of listYaml(DEVICES_DIR)) {
  const slug = basename(file).replace(/\.ya?ml$/, '');
  if (!file.endsWith('.yaml')) warn(file, 'use the .yaml extension (not .yml)');
  if (!SLUG.test(slug)) fail(file, `file name "${slug}" is not a kebab-case slug`);
  const raw = loadYaml(file);
  if (raw === undefined) continue;
  const parsed = deviceSchema.safeParse(raw);
  if (!parsed.success) {
    fail(file, `schema errors\n${formatIssues(parsed.error.issues)}`);
    continue;
  }
  deviceSlugs.add(slug);
  deviceNotes.set(slug, parsed.data.notes);
  deviceRelated.set(slug, parsed.data.related);
  deviceManufacturers.add(parsed.data.manufacturer);
  if (parsed.data.image && !existsSync(join(ROOT, 'public', parsed.data.image.src))) {
    fail(file, `image file ${parsed.data.image.src} does not exist under public/`);
  }
}

// ---- manufacturers ---------------------------------------------------------

let manufacturerTotal = 0;
for (const file of listYaml(MANUFACTURERS_DIR)) {
  const slug = basename(file).replace(/\.ya?ml$/, '');
  const raw = loadYaml(file);
  if (raw === undefined) continue;
  const parsed = manufacturerSchema.safeParse(raw);
  if (!parsed.success) {
    fail(file, `schema errors\n${formatIssues(parsed.error.issues)}`);
    continue;
  }
  const expected = slugify(parsed.data.name);
  if (expected !== slug) fail(file, `file name should be "${expected}.yaml" (slugify of name "${parsed.data.name}")`);
  if (!deviceManufacturers.has(parsed.data.name)) {
    warn(file, `no device uses manufacturer "${parsed.data.name}" (names must match device files exactly)`);
  }
  if (parsed.data.logo && !existsSync(join(ROOT, 'public', parsed.data.logo.src))) {
    fail(file, `logo file ${parsed.data.logo.src} does not exist under public/`);
  }
  manufacturerTotal++;
}

for (const [slug, related] of deviceRelated) {
  for (const r of related) {
    if (!deviceSlugs.has(r)) {
      fail(join(DEVICES_DIR, `${slug}.yaml`), `related device "${r}" does not exist`);
    }
  }
}

// ---- firmwares -------------------------------------------------------------

const firmwareCountByDevice = new Map<string, number>();
let firmwareTotal = 0;

let deviceDirs: string[] = [];
try {
  deviceDirs = readdirSync(FIRMWARES_DIR)
    .map((n) => join(FIRMWARES_DIR, n))
    .filter((p) => statSync(p).isDirectory())
    .sort();
} catch {
  /* no firmwares yet */
}

for (const dir of deviceDirs) {
  const dirSlug = basename(dir);
  if (!deviceSlugs.has(dirSlug)) {
    fail(dir, `firmware directory has no matching device file src/content/devices/${dirSlug}.yaml`);
  }
  const files = listYaml(dir);
  if (files.length === 0) warn(dir, 'empty firmware directory');
  for (const file of files) {
    const fwSlug = basename(file).replace(/\.ya?ml$/, '');
    if (!file.endsWith('.yaml')) warn(file, 'use the .yaml extension (not .yml)');
    if (!SLUG.test(fwSlug)) fail(file, `file name "${fwSlug}" is not a kebab-case slug`);
    const raw = loadYaml(file);
    if (raw === undefined) continue;
    const parsed = firmwareSchema.safeParse(raw);
    if (!parsed.success) {
      fail(file, `schema errors\n${formatIssues(parsed.error.issues)}`);
      continue;
    }
    const fw = parsed.data;
    if (fw.device !== dirSlug) {
      fail(file, `device "${fw.device}" does not match directory "${dirSlug}"`);
    }
    if (!deviceSlugs.has(fw.device)) {
      fail(file, `device "${fw.device}" does not exist`);
    }
    if (fw.kind === 'firmware' && fw.versions.length === 0 && fw.status !== 'announced') {
      warn(file, 'no versions listed');
    }
    if (fw.license === 'unspecified' && fw.source_status === 'open') {
      warn(file, 'open source but license unspecified; double-check the repo for a LICENSE file');
    }
    firmwareTotal++;
    firmwareCountByDevice.set(fw.device, (firmwareCountByDevice.get(fw.device) ?? 0) + 1);
  }
}

for (const slug of deviceSlugs) {
  if (!firmwareCountByDevice.has(slug) && !deviceNotes.get(slug)) {
    warn(
      join(DEVICES_DIR, `${slug}.yaml`),
      'device has no firmware entries and no notes explaining why',
    );
  }
}

// ---- report ----------------------------------------------------------------

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  x ${e}`);
  console.error('\nCatalog validation failed.');
  process.exit(1);
}
console.log(
  `\nCatalog OK: ${deviceSlugs.size} device(s), ${firmwareTotal} firmware entr${firmwareTotal === 1 ? 'y' : 'ies'}, ${manufacturerTotal} manufacturer file(s).`,
);
