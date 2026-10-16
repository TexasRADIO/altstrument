import type { APIContext } from 'astro';

// Content-Signal (contentsignals.org): the catalog is CC-BY-4.0, so training,
// search and AI answers are all welcome.
export function GET(context: APIContext) {
  // The Sitemap line must be absolute; see feed.xml.ts for why a build needs SITE_URL.
  if (!import.meta.env.DEV && !context.site) {
    throw new Error('Set SITE_URL to the public base URL of the site to build robots.txt.');
  }
  const site = new URL(import.meta.env.BASE_URL, context.url);
  const body = [
    'User-agent: *',
    'Content-Signal: ai-train=yes, search=yes, ai-input=yes',
    'Allow: /',
    '',
    `Sitemap: ${new URL('sitemap-index.xml', site).href}`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
