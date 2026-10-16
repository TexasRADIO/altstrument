// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Static output only. Hosting adapter is intentionally left out;
// add one when deployment is configured.
// SITE_URL is the public base URL the build is deployed to; it makes
// canonical, social-image, RSS and sitemap links absolute.
export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL,
  trailingSlash: 'never',
  // Writes sitemap-index.xml + sitemap-0.xml; public/_redirects sends /sitemap.xml to the index.
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
