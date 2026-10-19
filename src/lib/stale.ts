/**
 * The device-level `hide_stale_after_years` rule, kept free of Astro imports so
 * the site (src/lib/catalog.ts), the validator (scripts/validate.ts) and the
 * sitemap filter (astro.config.mjs) all apply the same test.
 *
 * An entry is hidden when its status is dormant or archived and its newest
 * dated version is older than the cutoff. Entries without a dated version are
 * never hidden; the validator warns about them instead. Entries in the device's
 * `pinned` list are never hidden either; callers skip them before calling isStale.
 */

/** Statuses the rule may hide. Active, maintained, announced and unknown entries always show. */
export const STALE_STATUSES: readonly string[] = ['dormant', 'archived'];

/** `years` calendar years (UTC) before `now`. */
export function staleCutoff(years: number, now: Date = new Date()): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return cutoff;
}

/** Newest date among versions, if any version is dated. */
export function newestDate(versions: { date?: Date | string }[]): Date | undefined {
  let best: Date | undefined;
  for (const v of versions) {
    if (!v.date) continue;
    const d = v.date instanceof Date ? v.date : new Date(v.date);
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  return best;
}

export function isStale(
  entry: { status: string; versions: { date?: Date | string }[] },
  years: number | undefined,
  now: Date = new Date(),
): boolean {
  if (years === undefined || !STALE_STATUSES.includes(entry.status)) return false;
  const newest = newestDate(entry.versions);
  return newest !== undefined && newest.getTime() < staleCutoff(years, now).getTime();
}
