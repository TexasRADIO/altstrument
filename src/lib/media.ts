/**
 * YouTube URL helpers for firmware demo videos. No astro imports, so the
 * schema (and through it scripts/validate.ts) can use them, like slug.ts.
 */

const ID = /^[A-Za-z0-9_-]{11}$/;

/** Video id from a watch / youtu.be / shorts / live / embed URL, or undefined. */
export function youtubeId(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null | undefined;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname);
      id = m?.[1];
    }
  }
  return id && ID.test(id) ? id : undefined;
}

/** Start offset in seconds from `t=` / `start=` ("1331", "1331s", "22m11s", "1h2m3s"). */
export function youtubeStart(url: string): number | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const raw = u.searchParams.get('t') ?? u.searchParams.get('start') ?? /(?:^|&)t=([^&]+)/.exec(u.hash.slice(1))?.[1];
  if (!raw) return undefined;
  if (/^\d+s?$/.test(raw)) return parseInt(raw, 10) || undefined;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m) return undefined;
  const secs = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0);
  return secs || undefined;
}

export function youtubeWatchUrl(id: string, start?: number): string {
  return `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ''}`;
}

export function youtubeEmbedUrl(id: string, start?: number): string {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1${start ? `&start=${start}` : ''}`;
}

export function youtubeThumb(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** oEmbed endpoint: 200 for a public, embeddable video; 401/403/404 otherwise. */
export function youtubeOembedUrl(url: string): string {
  return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
}
