// @ts-check
import { unified } from '@astrojs/markdown-remark';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { guideLinks } from './src/lib/guide-links.mjs';

export default defineConfig({
  site: 'https://clanks.si',
  // The same folder every other package builds into, so Turborepo caches it.
  outDir: 'out',
  trailingSlash: 'always',
  markdown: {
    processor: unified({ rehypePlugins: [guideLinks] }),
    shikiConfig: { theme: 'github-dark-default' },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
