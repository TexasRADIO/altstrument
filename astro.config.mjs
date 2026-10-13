// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Static output only. Hosting adapter is intentionally left out;
// add one when deployment is configured.
export default defineConfig({
  output: 'static',
  site: 'https://firmware.world',
  trailingSlash: 'never',
  vite: {
    plugins: [tailwindcss()],
  },
});
