/**
 * Candidate gatherer for the /discover skill (.claude/skills/discover/).
 *
 * Looks for firmware that might belong in the catalog but is not there yet.
 * It never edits the catalog; it only reports. The /discover skill runs this
 * script, then reviews the output with the maintainer.
 *
 * Sources (all configured in config.yaml next to this file):
 *
 *   - news: RSS/Atom feeds, filtered by keyword or by a catalog device name
 *   - GitHub: repository searches (generic queries plus one per catalog device),
 *     minus every repo the catalog already links to or the maintainer ignored
 *   - prior art: recent commits to other firmware lists (awesome-lists etc.)
 *
 * GitHub is reached through the `gh` CLI, so there is no token plumbing; it
 * must be installed and authenticated. Search is rate limited to 30 requests a
 * minute, so searches are spaced 2.1 s apart.
 *
 * The full report is always written as JSON to --out (default
 * discover-candidates.json in the repo root, which is gitignored). stdout gets a
 * markdown summary, or the JSON with --json. Progress goes to stderr.
 *
 * Exit code 0 on success even with problems; 1 on a config error or when every
 * network source failed; 2 on bad command-line usage.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { parse } from 'yaml';
import { z } from 'astro/zod';

const ROOT = new URL('../../../', import.meta.url).pathname;
const DEFAULT_CONFIG = new URL('./config.yaml', import.meta.url).pathname;
const DEFAULT_OUT = join(ROOT, 'discover-candidates.json');
const CATALOG_DIRS = ['src/content/devices', 'src/content/firmwares', 'src/content/manufacturers'].map((d) =>
  join(ROOT, d),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const FEED_CONCURRENCY = 4;
const FEED_TIMEOUT_MS = 20_000;
const SAME_HOST_DELAY_MS = 2000;
const MAX_RATE_WAIT_S = 60;
const SEARCH_DELAY_MS = 2100;
const SUMMARY_MAX = 400;
const DESCRIPTION_MAX = 120;

// ---- types -----------------------------------------------------------------

interface NewsCandidate {
  source: string;
  title: string;
  link: string;
  date?: string;
  summary: string;
  /** Keywords and device names that hit. Empty for prefiltered feeds. */
  matched: string[];
  /** Catalog firmware names, repos or hosts the item mentions. */
  knownMentions: string[];
}

interface DeviceGuess {
  slug: string;
  matched: string;
}

interface RepoCandidate {
  repo: string;
  url: string;
  description: string;
  stars: number;
  pushed: string;
  license?: string;
  topics: string[];
  queries: string[];
  deviceGuess: DeviceGuess[];
}

interface CommitCandidate {
  repo: string;
  sha7: string;
  date: string;
  subject: string;
  url: string;
}

interface Report {
  generatedAt: string;
  sinceDays: number;
  since: string;
  news: NewsCandidate[];
  github: RepoCandidate[];
  priorArt: CommitCandidate[];
  problems: string[];
  stats: {
    feedsChecked: number;
    feedItemsSeen: number;
    searchQueries: number;
    reposSeen: number;
    reposKnown: number;
    reposIgnored: number;
  };
  /** Rows dropped by --limit, per section (all zero without --limit). */
  omitted: { news: number; github: number; priorArt: number };
}

// ---- config ----------------------------------------------------------------

const configSchema = z.object({
  since_days: z.number().int().positive().default(14),
  user_agent: z.string().min(1),
  keywords: z.array(z.string().min(1)).default([]),
  feeds: z
    .array(z.object({ label: z.string().min(1), url: z.url(), prefiltered: z.boolean().default(false) }))
    .default([]),
  github_queries: z.array(z.string().min(1)).default([]),
  /** {name} and {manufacturer} are replaced per device. */
  device_query_template: z.string().min(1).default('{manufacturer} "{name}" firmware'),
  prior_art_repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/repo')).default([]),
  ignore: z
    .array(
      z.object({
        url: z.string().min(1),
        reason: z.string().optional(),
        date: z.union([z.string(), z.date()]).optional(),
      }),
    )
    .default([]),
});
type Config = z.infer<typeof configSchema>;

function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`Cannot read config ${path}: ${(e as Error).message}`);
    process.exit(1);
  }
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    console.error(`Invalid config ${path}:`);
    for (const i of parsed.error.issues) {
      console.error(`  - ${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

// ---- small helpers ------------------------------------------------------------

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
const arr = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Text of a parsed XML node: plain string/number, or the `#text` of a node with attributes. */
function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return str(v[0]);
  const o = asObj(v);
  return o ? str(o['#text']) : '';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Case-insensitive match of `s` not embedded in a longer word. */
const wordRe = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, 'iu');

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const isoDay = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);

function progress(msg: string) {
  console.error(msg);
}

// ---- repo keys -------------------------------------------------------------------

const GIT_HOSTS = new Set(['github.com', 'codeberg.org', 'gitlab.com']);
/** First path segments on github.com that are not owners. */
const NOT_OWNERS = new Set(['orgs', 'sponsors', 'topics', 'users', 'settings', 'marketplace', 'features', 'about']);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * `owner/repo` (lowercase) for github.com URLs, `host/owner/repo` for codeberg.org and
 * gitlab.com, undefined for anything else (including gist.github.com and bare owners).
 */
function repoKey(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!GIT_HOSTS.has(host)) return undefined;
  const [owner, repoRaw] = u.pathname.split('/').filter(Boolean);
  if (!owner || !repoRaw) return undefined;
  if (host === 'github.com' && NOT_OWNERS.has(owner.toLowerCase())) return undefined;
  const key = `${owner}/${repoRaw.replace(/\.git$/i, '')}`.toLowerCase();
  return host === 'github.com' ? key : `${host}/${key}`;
}

const URL_RE = /https?:\/\/[^\s"'<>()[\]{}\\^`|]+/g;
const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, '');

function urlsIn(text: string): string[] {
  return (text.match(URL_RE) ?? []).map(trimUrl);
}

// ---- catalog index ----------------------------------------------------------------

interface DeviceInfo {
  slug: string;
  name: string;
  manufacturer: string;
  fullName: string;
}

interface Catalog {
  knownRepos: Set<string>;
  knownHosts: Set<string>;
  devices: DeviceInfo[];
  firmwareNames: { name: string; deviceSlug: string; fwSlug: string }[];
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

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function walkStrings(v: unknown, fn: (s: string) => void) {
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) for (const x of v) walkStrings(x, fn);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) walkStrings(x, fn);
}

function buildCatalog(problems: string[]): Catalog {
  const knownRepos = new Set<string>();
  const knownHosts = new Set<string>();
  const devices: DeviceInfo[] = [];
  const firmwareNames: Catalog['firmwareNames'] = [];

  const addUrl = (u: string) => {
    const key = repoKey(u);
    if (key) knownRepos.add(key);
  };
  /** Reads a YAML file, registers every URL in it, and returns the parsed data. */
  const read = (file: string): Obj | undefined => {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      problems.push(`catalog: cannot read ${relative(ROOT, file)}: ${(e as Error).message}`);
      return undefined;
    }
    for (const u of urlsIn(raw)) addUrl(u);
    let data: unknown;
    try {
      data = parse(raw);
    } catch (e) {
      problems.push(`catalog: YAML error in ${relative(ROOT, file)}: ${(e as Error).message.split('\n')[0]}`);
      return undefined;
    }
    walkStrings(data, (s) => {
      for (const u of urlsIn(s)) addUrl(u);
    });
    return asObj(data);
  };
  const slugOf = (file: string) => basename(file).replace(/\.ya?ml$/, '');

  for (const file of listYaml(CATALOG_DIRS[0])) {
    const d = read(file);
    const name = d && str(d.name);
    const manufacturer = d && str(d.manufacturer);
    if (name && manufacturer) {
      devices.push({ slug: slugOf(file), name, manufacturer, fullName: `${manufacturer} ${name}` });
    }
  }

  for (const dir of listDirs(CATALOG_DIRS[1])) {
    for (const file of listYaml(dir)) {
      const fw = read(file);
      if (!fw) continue;
      const name = str(fw.name);
      if (name) firmwareNames.push({ name, deviceSlug: basename(dir), fwSlug: slugOf(file) });
      // Only source/homepage count as "hosts the catalog already covers"; forum or
      // video links in community sections must not.
      for (const field of ['source', 'homepage']) {
        const host = hostOf(str(fw[field]));
        if (host && host !== 'github.com') knownHosts.add(host);
      }
    }
  }

  for (const file of listYaml(CATALOG_DIRS[2])) read(file);

  return { knownRepos, knownHosts, devices, firmwareNames };
}

// ---- matching ---------------------------------------------------------------------

interface Matcher {
  slug: string;
  re: RegExp;
}

/** fullName always; bare name only when it is long enough not to hit common words (Arc, Crow, Force). */
function buildDeviceMatchers(devices: DeviceInfo[]): Matcher[] {
  const out: Matcher[] = [];
  for (const d of devices) {
    out.push({ slug: d.slug, re: wordRe(d.fullName) });
    if (d.name.length >= 5 && d.name.toLowerCase() !== d.fullName.toLowerCase()) {
      out.push({ slug: d.slug, re: wordRe(d.name) });
    }
  }
  return out;
}

function matchDevices(text: string, matchers: Matcher[]): DeviceGuess[] {
  const out: DeviceGuess[] = [];
  for (const m of matchers) {
    if (out.some((o) => o.slug === m.slug)) continue;
    const hit = m.re.exec(text);
    if (hit) out.push({ slug: m.slug, matched: hit[0] });
  }
  return out;
}

function matchKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

// ---- ignore list ---------------------------------------------------------------------

const normUrl = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '');

function makeIgnore(entries: Config['ignore']): (url: string) => boolean {
  const prepared = entries.map((e) => ({ norm: normUrl(e.url), key: repoKey(e.url) }));
  return (url) => {
    const norm = normUrl(url);
    const key = repoKey(url);
    // A GitHub ignore matches its repo; any other URL matches itself and everything below it
    // (path boundary, so ignoring .../foo does not hide .../foobar).
    return prepared.some(
      (p) =>
        (p.key !== undefined && p.key === key) ||
        norm === p.norm ||
        norm.startsWith(p.norm.endsWith('/') ? p.norm : `${p.norm}/`) ||
        norm.startsWith(`${p.norm}?`),
    );
  };
}

// ---- feeds ---------------------------------------------------------------------------

interface FeedItem {
  title: string;
  link: string;
  date?: Date;
  summary: string;
  /** URLs found in the item's raw markup, used to spot repos/hosts the catalog knows. */
  urls: string[];
  id: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(v: unknown): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** href of an Atom <link> (or RSS-embedded link) list: first rel=alternate, else the first with an href. */
function linkOf(v: unknown): string {
  const links = arr(v).map((l) => (typeof l === 'string' ? { href: l.trim(), rel: '' } : { href: str(asObj(l)?.['@_href']), rel: str(asObj(l)?.['@_rel']) }));
  const pick = links.find((l) => l.href && (l.rel === '' || l.rel === 'alternate')) ?? links.find((l) => l.href);
  return pick?.href ?? '';
}

function parseFeed(xml: string): FeedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
  const doc = asObj(parser.parse(xml));
  if (!doc) throw new Error('not XML');
  const rssChannel = asObj(arr(asObj(doc.rss)?.channel)[0]);
  const atomFeed = asObj(doc.feed);
  const rdf = asObj(doc['rdf:RDF']);
  const out: FeedItem[] = [];

  const push = (title: string, link: string, date: Date | undefined, rawSummary: string, id: string) => {
    if (!title && !link) return;
    out.push({
      title: plainText(title),
      link,
      date,
      summary: truncate(plainText(rawSummary), SUMMARY_MAX),
      urls: urlsIn(rawSummary).concat(link ? [link] : []),
      id: id || link,
    });
  };

  if (rssChannel || rdf) {
    for (const it of arr(rssChannel?.item ?? rdf?.item)) {
      const o = asObj(it);
      if (!o) continue;
      push(
        str(o.title),
        linkOf(o.link),
        parseDate(o.pubDate) ?? parseDate(o['dc:date']),
        str(o.description) || str(o['content:encoded']),
        str(o.guid),
      );
    }
  } else if (atomFeed) {
    for (const en of arr(atomFeed.entry)) {
      const o = asObj(en);
      if (!o) continue;
      push(
        str(o.title),
        linkOf(o.link),
        parseDate(o.published) ?? parseDate(o.updated),
        str(o.summary) || str(o.content),
        str(o.id),
      );
    }
  } else {
    throw new Error('not an RSS or Atom feed');
  }
  return out;
}

async function fetchText(url: string, userAgent: string): Promise<string> {
  let lastErr: unknown;
  let waitMs = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(waitMs || 500 * 2 ** attempt);
    waitMs = 0;
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
        },
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      });
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}`);
        // Reddit allows about one unauthenticated request a minute and says when the
        // window reopens; wait for it (up to a minute) instead of failing the feed.
        const reset = Number(res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset'));
        if (res.status === 429 && reset > 0 && reset <= MAX_RATE_WAIT_S) waitMs = (reset + 1) * 1000;
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw Object.assign(new Error(`HTTP ${res.status}`), { final: true });
      }
      return await res.text();
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface FeedResult {
  ok: boolean;
  seen: number;
  news: NewsCandidate[];
}

async function gatherNews(
  config: Config,
  since: Date,
  catalog: Catalog,
  deviceMatchers: Matcher[],
  problems: string[],
): Promise<FeedResult[]> {
  const firmwareRes = new Map<string, RegExp>();
  for (const f of catalog.firmwareNames) {
    if (f.name.length >= 4 && !firmwareRes.has(f.name.toLowerCase())) firmwareRes.set(f.name.toLowerCase(), wordRe(f.name));
  }

  const one = async (feed: Config['feeds'][number]): Promise<FeedResult> => {
    let items: FeedItem[];
    try {
      items = parseFeed(await fetchText(feed.url, config.user_agent));
    } catch (e) {
      problems.push(`feed ${feed.label} (${feed.url}): ${(e as Error).message}`);
      return { ok: false, seen: 0, news: [] };
    }
    const feedHost = hostOf(feed.url);
    const news: NewsCandidate[] = [];
    for (const it of items) {
      if (it.date && it.date < since) continue;
      const text = `${it.title} ${it.summary}`;
      const matched = feed.prefiltered
        ? []
        : [...new Set([...matchKeywords(text, config.keywords), ...matchDevices(text, deviceMatchers).map((d) => d.matched)])];
      if (!feed.prefiltered && matched.length === 0) continue;

      const mentions = new Set<string>();
      for (const [lower, re] of firmwareRes) {
        if (re.test(text)) mentions.add(catalog.firmwareNames.find((f) => f.name.toLowerCase() === lower)?.name ?? lower);
      }
      for (const u of it.urls) {
        const key = repoKey(u);
        if (key && catalog.knownRepos.has(key)) mentions.add(`repo:${key}`);
        // The feed's own site is not a mention, even when the catalog links to it.
        const host = hostOf(u);
        if (host && host !== feedHost && host !== hostOf(it.link) && catalog.knownHosts.has(host)) mentions.add(`host:${host}`);
      }
      news.push({
        source: feed.label,
        title: it.title || it.link,
        link: it.link,
        date: it.date?.toISOString(),
        summary: it.summary,
        matched,
        knownMentions: [...mentions],
      });
    }
    return { ok: true, seen: items.length, news };
  };

  // Feeds on the same host (the reddit searches) run one after another, spaced out,
  // or the host answers 429. Different hosts run FEED_CONCURRENCY at a time.
  const groups = new Map<string, Config['feeds']>();
  for (const feed of config.feeds) {
    const host = hostOf(feed.url) ?? feed.url;
    groups.set(host, [...(groups.get(host) ?? []), feed]);
  }
  const grouped = await pool([...groups.values()], FEED_CONCURRENCY, async (feeds) => {
    const results: FeedResult[] = [];
    for (const [i, feed] of feeds.entries()) {
      if (i > 0) await sleep(SAME_HOST_DELAY_MS);
      results.push(await one(feed));
    }
    return results;
  });
  return grouped.flat();
}

// ---- GitHub (via gh) ---------------------------------------------------------------------

type GhResult = { ok: true; json: unknown } | { ok: false; status?: number; message: string };

function gh(args: string[]): GhResult {
  try {
    const out = execFileSync('gh', ['api', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
    });
    return { ok: true, json: JSON.parse(out) as unknown };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (err.code === 'ENOENT') return { ok: false, message: 'gh CLI not found; install it and run `gh auth login`' };
    const detail = `${err.stderr ?? ''}\n${err.stdout ?? ''}`;
    const status = /HTTP (\d{3})/.exec(detail)?.[1];
    const message = (err.stderr || err.message).split('\n').find((l) => l.trim()) ?? 'gh api failed';
    return { ok: false, status: status ? Number(status) : undefined, message: message.trim() };
  }
}

interface SearchOutcome {
  repos: Map<string, RepoCandidate>;
  queriesRun: number;
  queriesOk: number;
}

async function runSearches(queries: string[], since: Date, problems: string[]): Promise<SearchOutcome> {
  const repos = new Map<string, RepoCandidate>();
  const day = isoDay(since);
  let run = 0;
  let ok = 0;
  for (const base of queries) {
    if (run > 0) await sleep(SEARCH_DELAY_MS);
    const q = `${base} fork:false pushed:>${day}`;
    run++;
    progress(`  search ${run}/${queries.length}: ${base}`);
    const res = gh(['-X', 'GET', 'search/repositories', '-f', `q=${q}`, '-f', 'per_page=30', '-f', 'sort=updated']);
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        problems.push(`GitHub search rate limit hit after ${run - 1} of ${queries.length} queries (${res.message}); results are partial`);
        break;
      }
      problems.push(`GitHub search "${base}": ${res.message}`);
      continue;
    }
    ok++;
    for (const item of arr(asObj(res.json)?.items)) {
      const o = asObj(item);
      const fullName = o && str(o.full_name);
      if (!o || !fullName) continue;
      const key = fullName.toLowerCase();
      const existing = repos.get(key);
      if (existing) {
        if (!existing.queries.includes(base)) existing.queries.push(base);
        continue;
      }
      repos.set(key, {
        repo: fullName,
        url: str(o.html_url) || `https://github.com/${fullName}`,
        description: str(o.description),
        stars: typeof o.stargazers_count === 'number' ? o.stargazers_count : 0,
        pushed: str(o.pushed_at),
        license: str(asObj(o.license)?.spdx_id) || undefined,
        topics: arr(o.topics).map(str).filter(Boolean),
        queries: [base],
        deviceGuess: [],
      });
    }
  }
  return { repos, queriesRun: run, queriesOk: ok };
}

function gatherPriorArt(repos: string[], since: Date, problems: string[]): { commits: CommitCandidate[]; ok: number } {
  const commits: CommitCandidate[] = [];
  let ok = 0;
  for (const repo of repos) {
    progress(`  commits: ${repo}`);
    const res = gh([`repos/${repo}/commits?since=${since.toISOString()}&per_page=30`]);
    if (!res.ok) {
      problems.push(`prior art ${repo}: ${res.message}`);
      continue;
    }
    ok++;
    for (const c of arr(res.json)) {
      const o = asObj(c);
      const commit = asObj(o?.commit);
      const sha = str(o?.sha);
      if (!o || !commit || !sha) continue;
      const date = str(asObj(commit.committer)?.date) || str(asObj(commit.author)?.date);
      commits.push({
        repo,
        sha7: sha.slice(0, 7),
        date,
        subject: str(commit.message).split('\n')[0].trim(),
        url: str(o.html_url) || `https://github.com/${repo}/commit/${sha}`,
      });
    }
  }
  return { commits, ok };
}

// ---- output -----------------------------------------------------------------------------------

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const linkText = (s: string) => cell(s).replace(/[[\]]/g, '\\$&');

function renderMarkdown(r: Report, outPath: string): string {
  const L: string[] = [];
  L.push(
    `Discover candidates, last ${r.sinceDays} days (since ${isoDay(r.since)}): ${r.news.length + r.omitted.news} news item(s) from ${r.stats.feedsChecked} feed(s) ` +
      `(${r.stats.feedItemsSeen} items seen), ${r.github.length + r.omitted.github} GitHub repo(s) not in the catalog ` +
      `(${r.stats.reposSeen} seen, ${r.stats.reposKnown} already known, ${r.stats.reposIgnored} ignored, ${r.stats.searchQueries} searches), ` +
      `${r.priorArt.length + r.omitted.priorArt} prior-art commit(s), ${r.problems.length} problem(s).`,
  );
  const more = (n: number) => (n > 0 ? [``, `… and ${n} more (raise --limit to see them)`] : []);

  L.push('', `## News (${r.news.length + r.omitted.news})`, '');
  if (r.news.length) {
    L.push('| Date | Source | Title | Matched | Mentions catalog |', '| --- | --- | --- | --- | --- |');
    for (const n of r.news) {
      L.push(
        `| ${n.date ? isoDay(n.date) : ''} | ${cell(n.source)} | [${linkText(truncate(n.title, 100))}](${n.link}) | ${cell(n.matched.join(', ') || '(search feed)')} | ${cell(n.knownMentions.join(', '))} |`,
      );
    }
    L.push(...more(r.omitted.news));
  } else L.push('None.');

  L.push('', `## GitHub repos not in the catalog (${r.github.length + r.omitted.github})`, '');
  if (r.github.length) {
    L.push('| Pushed | Repo | Stars | License | Description | Device guess | Queries |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const g of r.github) {
      const queries = g.queries.slice(0, 3).join(' · ') + (g.queries.length > 3 ? ` (+${g.queries.length - 3})` : '');
      L.push(
        `| ${isoDay(g.pushed)} | [${linkText(g.repo)}](${g.url}) | ${g.stars} | ${cell(g.license ?? '')} | ${cell(truncate(g.description, DESCRIPTION_MAX))} | ${cell(g.deviceGuess.map((d) => d.slug).join(', '))} | ${cell(queries)} |`,
      );
    }
    L.push(...more(r.omitted.github));
  } else L.push('None.');

  L.push('', `## Prior-art list changes (${r.priorArt.length + r.omitted.priorArt})`, '');
  if (r.priorArt.length) {
    L.push('| Date | Repo | Commit | Subject |', '| --- | --- | --- | --- |');
    for (const c of r.priorArt) {
      L.push(`| ${isoDay(c.date)} | ${cell(c.repo)} | [${c.sha7}](${c.url}) | ${cell(truncate(c.subject, 140))} |`);
    }
    L.push(...more(r.omitted.priorArt));
  } else L.push('None.');

  if (r.problems.length) {
    L.push('', '## Problems', '');
    for (const p of r.problems) L.push(`- ${p}`);
  }
  L.push('', `Full JSON written to ${outPath}.`);
  return L.join('\n');
}

/** Path relative to the working directory when it is inside it, else absolute. */
function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  return rel && !rel.startsWith('..') ? rel : p;
}

const HELP = `Usage: pnpm discover:candidates [options]

Gathers firmware candidates (news, GitHub repos, prior-art list commits) that
are not yet in the catalog. Settings live in .claude/skills/discover/config.yaml.

Options:
  --since-days N       Lookback window in days (default: config since_days)
  --limit N            Max rows per section (default: unlimited)
  --filter <text>      Keep only candidates whose title/description/url contain the text
  --no-feeds           Skip the news feeds
  --no-github          Skip all GitHub calls (searches and prior-art commits)
  --no-device-queries  Skip the per-device GitHub searches (about 2 s each)
  --out <file>         JSON output path (default: discover-candidates.json in the repo root)
  --json               Print JSON to stdout instead of a markdown report
  --config <path>      Config file (default: config.yaml next to this script)
  --help               Show this help

Exit codes: 0 success (even with problems), 1 config error or every network
source failed, 2 bad usage.`;

function positiveInt(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${name} expects a positive integer, got "${v}"`);
    process.exit(2);
  }
  return n;
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      options: {
        'since-days': { type: 'string' },
        limit: { type: 'string' },
        filter: { type: 'string' },
        'no-device-queries': { type: 'boolean' },
        'no-feeds': { type: 'boolean' },
        'no-github': { type: 'boolean' },
        out: { type: 'string' },
        json: { type: 'boolean' },
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  const opt = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);

  const config = loadConfig(opt('config') ? resolve(opt('config')!) : DEFAULT_CONFIG);
  const sinceDays = positiveInt('since-days', opt('since-days')) ?? config.since_days;
  const limit = positiveInt('limit', opt('limit'));
  const filter = opt('filter')?.toLowerCase();
  const outPath = opt('out') ? resolve(opt('out')!) : DEFAULT_OUT;
  const now = new Date();
  const since = new Date(now.getTime() - sinceDays * DAY_MS);
  const problems: string[] = [];

  const catalog = buildCatalog(problems);
  const deviceMatchers = buildDeviceMatchers(catalog.devices);
  const isIgnored = makeIgnore(config.ignore);
  progress(
    `Catalog: ${catalog.devices.length} devices, ${catalog.firmwareNames.length} firmwares, ${catalog.knownRepos.size} known repos, ${catalog.knownHosts.size} known hosts. Window: ${sinceDays} days.`,
  );

  // Network sources that were attempted / that answered at least once.
  let attempted = 0;
  let succeeded = 0;
  const stats: Report['stats'] = { feedsChecked: 0, feedItemsSeen: 0, searchQueries: 0, reposSeen: 0, reposKnown: 0, reposIgnored: 0 };

  // News.
  let news: NewsCandidate[] = [];
  if (!values['no-feeds'] && config.feeds.length) {
    progress(`Fetching ${config.feeds.length} feeds...`);
    const results = await gatherNews(config, since, catalog, deviceMatchers, problems);
    attempted += results.length;
    for (const r of results) {
      if (r.ok) {
        succeeded++;
        stats.feedsChecked++;
        stats.feedItemsSeen += r.seen;
      }
      news.push(...r.news);
    }
    const seenLinks = new Set<string>();
    news = news.filter((n) => {
      if (isIgnored(n.link)) return false;
      if (seenLinks.has(n.link)) return false;
      seenLinks.add(n.link);
      return true;
    });
    news.sort((a, b) => (b.date ? Date.parse(b.date) : -Infinity) - (a.date ? Date.parse(a.date) : -Infinity));
  }

  // GitHub.
  let github: RepoCandidate[] = [];
  let priorArt: CommitCandidate[] = [];
  if (!values['no-github']) {
    const queries = [...config.github_queries];
    if (!values['no-device-queries']) {
      for (const d of catalog.devices) {
        queries.push(
          config.device_query_template.replaceAll('{name}', d.name).replaceAll('{manufacturer}', d.manufacturer),
        );
      }
    }
    const unique = [...new Set(queries)];
    if (unique.length) {
      progress(`Running ${unique.length} GitHub searches (about ${Math.ceil((unique.length * SEARCH_DELAY_MS) / 1000)} s)...`);
      const found = await runSearches(unique, since, problems);
      attempted += found.queriesRun;
      succeeded += found.queriesOk;
      stats.searchQueries = found.queriesRun;
      stats.reposSeen = found.repos.size;
      // The prior-art lists are catalogs, not firmware; never offer them as candidates.
      const priorArtKeys = new Set(config.prior_art_repos.map((r) => r.toLowerCase()));
      for (const [key, repo] of found.repos) {
        if (catalog.knownRepos.has(key) || priorArtKeys.has(key)) {
          stats.reposKnown++;
          continue;
        }
        if (isIgnored(repo.url)) {
          stats.reposIgnored++;
          continue;
        }
        repo.deviceGuess = matchDevices(`${repo.repo} ${repo.description}`, deviceMatchers);
        github.push(repo);
      }
      github.sort((a, b) => Date.parse(b.pushed) - Date.parse(a.pushed));
    }

    if (config.prior_art_repos.length) {
      progress(`Reading commits of ${config.prior_art_repos.length} prior-art repos...`);
      const pa = gatherPriorArt(config.prior_art_repos, since, problems);
      attempted += config.prior_art_repos.length;
      succeeded += pa.ok;
      priorArt = pa.commits.filter((c) => !isIgnored(c.url));
      priorArt.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    }
  }

  // --filter, then --limit.
  if (filter) {
    const has = (...parts: string[]) => parts.some((p) => p.toLowerCase().includes(filter));
    news = news.filter((n) => has(n.title, n.summary, n.link));
    github = github.filter((g) => has(g.repo, g.description, g.url));
    priorArt = priorArt.filter((c) => has(c.subject, c.repo, c.url));
  }
  const omitted = { news: 0, github: 0, priorArt: 0 };
  if (limit !== undefined) {
    omitted.news = Math.max(0, news.length - limit);
    omitted.github = Math.max(0, github.length - limit);
    omitted.priorArt = Math.max(0, priorArt.length - limit);
    news = news.slice(0, limit);
    github = github.slice(0, limit);
    priorArt = priorArt.slice(0, limit);
  }

  const report: Report = {
    generatedAt: now.toISOString(),
    sinceDays,
    since: since.toISOString(),
    news,
    github,
    priorArt,
    problems,
    stats,
    omitted,
  };

  const json = JSON.stringify(report, null, 2) + '\n';
  try {
    writeFileSync(outPath, json);
  } catch (e) {
    problems.push(`could not write ${outPath}: ${(e as Error).message}`);
  }
  console.log(values.json ? json.trimEnd() : renderMarkdown(report, displayPath(outPath)));

  if (attempted > 0 && succeeded === 0) {
    console.error('Every network source failed.');
    process.exit(1);
  }
}

await main();
