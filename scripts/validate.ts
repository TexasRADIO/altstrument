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
 *   - every hotlinked `video` / `image` still resolves (network; see below)
 *
 * Exit code 1 on any error. Warnings are printed but do not fail the run.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { parse } from 'yaml';
import { deviceSchema, firmwareBaseSchema, manufacturerSchema, refineFirmware } from '../src/content/schema';
import { slugify } from '../src/lib/slug';
import { youtubeOembedUrl } from '../src/lib/media';
import { isStale, newestDate } from '../src/lib/stale';
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
/** hide_stale_after_years per device, for the stale-entry warning and summary. */
const deviceHideYears = new Map<string, number>();
let hiddenTotal = 0;
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
  if (parsed.data.hide_stale_after_years !== undefined) deviceHideYears.set(slug, parsed.data.hide_stale_after_years);
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
/** Hotlinked media to check over the network once the local checks are done. */
const remoteChecks: { file: string; kind: 'video' | 'image'; url: string }[] = [];
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
    const hideYears = deviceHideYears.get(fw.device);
    if (hideYears !== undefined) {
      if (!newestDate(fw.versions)) {
        warn(file, `no dated version, so hide_stale_after_years (${hideYears}) on ${fw.device} can never hide it`);
      } else if (isStale(fw, hideYears)) {
        hiddenTotal++;
      }
    }
    if (fw.video) remoteChecks.push({ file, kind: 'video', url: fw.video.url });
    if (fw.image) remoteChecks.push({ file, kind: 'image', url: fw.image.url });
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

// ---- hotlinked media ------------------------------------------------------
//
// Videos are checked with YouTube's oEmbed endpoint (200 only for a public,
// embeddable video); images must answer 2xx with an image/* content type.
// A definitive answer (404, 401, 403, 410, wrong type) is an error; timeouts,
// 5xx and DNS trouble are warnings so a flaky network doesn't block a build.
// ALTSTRUMENT_SKIP_REMOTE=1 skips the pass (offline development).

const DEFINITIVE = new Set([401, 403, 404, 410]);
const REMOTE_CONCURRENCY = 8;

async function request(url: string, method: 'GET' | 'HEAD'): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        headers: { 'User-Agent': 'altstrument-validate' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** undefined when fine, otherwise [definitive?, message]. */
async function checkRemote(kind: 'video' | 'image', url: string): Promise<[boolean, string] | undefined> {
  try {
    if (kind === 'video') {
      const res = await request(youtubeOembedUrl(url), 'GET');
      await res.body?.cancel();
      if (res.ok) return undefined;
      return [DEFINITIVE.has(res.status), `video ${url} is unavailable or not embeddable (oEmbed HTTP ${res.status})`];
    }
    let res = await request(url, 'HEAD');
    // Some hosts refuse HEAD; ask again with GET before calling it broken.
    if (!res.ok) res = await request(url, 'GET');
    const type = res.headers.get('content-type') ?? '';
    await res.body?.cancel();
    if (!res.ok) return [DEFINITIVE.has(res.status), `image ${url} returned HTTP ${res.status}`];
    if (!type.startsWith('image/')) return [true, `image ${url} is served as "${type || 'no content-type'}", not an image`];
    return undefined;
  } catch (e) {
    return [false, `${kind} ${url} could not be checked: ${(e as Error).message}`];
  }
}

let remoteNote = '';
if (process.env.ALTSTRUMENT_SKIP_REMOTE) {
  remoteNote = `, ${remoteChecks.length} hotlinked media not checked (ALTSTRUMENT_SKIP_REMOTE)`;
} else if (remoteChecks.length) {
  let next = 0;
  let broken = 0;
  await Promise.all(
    Array.from({ length: Math.min(REMOTE_CONCURRENCY, remoteChecks.length) }, async () => {
      while (next < remoteChecks.length) {
        const c = remoteChecks[next++];
        const problem = await checkRemote(c.kind, c.url);
        if (!problem) continue;
        broken++;
        (problem[0] ? fail : warn)(c.file, problem[1]);
      }
    }),
  );
  remoteNote = `, ${remoteChecks.length - broken}/${remoteChecks.length} hotlinked media OK`;
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
  `\nCatalog OK: ${deviceSlugs.size} device(s), ${firmwareTotal} firmware entr${firmwareTotal === 1 ? 'y' : 'ies'}, ${manufacturerTotal} manufacturer file(s)${hiddenTotal ? ` (${hiddenTotal} hidden as stale)` : ''}${remoteNote}.`,
);
