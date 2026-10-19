// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { isStale } from './src/lib/stale.ts';

/**
 * Paths of entries hidden by a device's hide_stale_after_years. Their pages are
 * still built (noindex), but they stay out of the sitemap. Reads the YAML
 * directly because content collections are not available here; the rule
 * itself is shared with src/lib/catalog.ts through src/lib/stale.ts.
 */
function hiddenFirmwarePaths() {
  const paths = new Set();
  const devicesDir = 'src/content/devices';
  for (const file of readdirSync(devicesDir).filter((f) => f.endsWith('.yaml'))) {
    const years = parse(readFileSync(`${devicesDir}/${file}`, 'utf8'))?.hide_stale_after_years;
    if (years === undefined) continue;
    const device = file.replace(/\.yaml$/, '');
    const dir = `src/content/firmwares/${device}`;
    if (!existsSync(dir)) continue;
    for (const fw of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
      const data = parse(readFileSync(`${dir}/${fw}`, 'utf8')) ?? {};
      if (isStale({ status: data.status ?? 'unknown', versions: data.versions ?? [] }, years)) {
        paths.add(`/firmware/${device}/${fw.replace(/\.yaml$/, '')}`);
      }
    }
  }
  return paths;
}
const hiddenPaths = hiddenFirmwarePaths();

// Static output only. Hosting adapter is intentionally left out;
// add one when deployment is configured.
// SITE_URL is the public base URL the build is deployed to; it makes
// canonical, social-image, RSS and sitemap links absolute.
export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL,
  trailingSlash: 'never',
  // Writes sitemap-index.xml + sitemap-0.xml; public/_redirects sends /sitemap.xml to the index.
  integrations: [sitemap({ filter: (page) => !hiddenPaths.has(new URL(page).pathname.replace(/\/$/, '')) })],
  vite: {
    plugins: [tailwindcss()],
  },
});
