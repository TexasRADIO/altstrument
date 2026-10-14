// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Static output only. Hosting adapter is intentionally left out;
// add one when deployment is configured.
// SITE_URL is the public base URL the build is deployed to; it makes
// canonical, social-image and RSS links absolute.
export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL,
  trailingSlash: 'never',
  vite: {
    plugins: [tailwindcss()],
  },
});
