import type { APIContext } from 'astro';

// RFC 9727 API catalog, linked from the home page's Link header (public/_headers).
// Served without an extension, so public/_headers also sets its Content-Type.
export function GET(context: APIContext) {
  if (!import.meta.env.DEV && !context.site) {
    throw new Error('Set SITE_URL to the public base URL of the site to build the API catalog.');
  }
  const site = new URL(import.meta.env.BASE_URL, context.url);
  const abs = (path: string) => new URL(path, site).href;
  const doc = [{ href: abs('/about#api'), type: 'text/html' }];
  const apis = ['/api/catalog.json', '/api/stats.json'];

  const linkset = [
    { anchor: abs('/.well-known/api-catalog'), item: apis.map((p) => ({ href: abs(p), type: 'application/json' })) },
    ...apis.map((p) => ({ anchor: abs(p), 'service-doc': doc })),
  ];
  return new Response(JSON.stringify({ linkset }, null, 2), {
    headers: { 'Content-Type': 'application/linkset+json' },
  });
}
