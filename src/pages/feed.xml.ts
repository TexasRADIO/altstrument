import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getDevicesWithFirmwares, recentVersions, versionAnchor } from '@/lib/catalog';

export async function GET(context: APIContext) {
  const site = context.site ?? new URL('https://firmware.world');
  const rows = recentVersions(await getDevicesWithFirmwares(), 50);
  return rss({
    title: 'Firmware World: recent versions',
    description: 'The most recent dated versions of custom and third-party firmware for music hardware.',
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
