/**
 * `cacheKey` values for Astro's incremental build (experimental.incrementalBuild).
 * A route's getStaticPaths returns one per path; Astro reuses the previous build's
 * output when the key and the route's code are unchanged. The key must therefore
 * cover everything the path renders that is not code: its props, plus any file it
 * reads from disk (Astro's code hash does not see those).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Maps and Sets stringify to {} by default, which would hide changes inside them.
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return [...value];
  if (value instanceof Set) return [...value];
  return value;
}

/** sha1 of each part: strings as-is, anything else as JSON. */
export function cacheKeyOf(...parts: unknown[]): string {
  const hash = createHash('sha1');
  for (const part of parts) {
    hash.update(typeof part === 'string' ? part : (JSON.stringify(part, replacer) ?? 'undefined'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// Many OG cards share one device photo; hash each file once per build.
const fileHashes = new Map<string, string>();

/** sha1 of a file under public/, by its site-relative path. */
export function publicFileHash(src: string): string {
  let hash = fileHashes.get(src);
  if (!hash) {
    hash = createHash('sha1').update(readFileSync(join(process.cwd(), 'public', src))).digest('hex');
    fileHashes.set(src, hash);
  }
  return hash;
}
