import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getDevicesWithFirmwares, recentVersions, versionAnchor } from '@/lib/catalog';

export async function GET(context: APIContext) {
  // Base URL of wherever the site is being served or built for: the request
  // origin in dev, SITE_URL (Astro's `site`) in a static build. Feed links
  // must be absolute, so a build without one would point readers at localhost.
  if (!import.meta.env.DEV && !context.site) {
    throw new Error('Set SITE_URL to the public base URL of the site to build the RSS feed.');
  }
  const site = new URL(import.meta.env.BASE_URL, context.url);
  const rows = recentVersions(await getDevicesWithFirmwares(), 50);
  return rss({
    title: 'altstrument: recent versions',
    description: 'The most recent dated versions of custom and third-party firmware and tools for music hardware.',
    site,
    trailingSlash: false,
    items: rows.map((r) => ({
      title: `${r.firmware.data.name} ${r.version.version} (${r.device.data.name})`,
      link: new URL(`${r.firmware.url}#${versionAnchor(r.version.version)}`, site).href,
      pubDate: r.date,
      description: r.version.notes ?? r.firmware.data.summary,
    })),
  });
}
