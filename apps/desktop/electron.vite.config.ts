import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const migrations = join(import.meta.dirname, '../../packages/orchestrator/drizzle');
const crew = join(import.meta.dirname, '../../crew');

/**
 * Ships the orchestrator's SQL migrations and the crew's priming docs next to the main bundle,
 * where the orchestrator reads them.
 */
function copyResources(): Plugin {
  return {
    name: 'clanks:copy-resources',
    writeBundle(options) {
      if (!options.dir) return;
      cpSync(migrations, join(options.dir, 'migrations'), { recursive: true });
      cpSync(crew, join(options.dir, 'crew'), { recursive: true });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [copyResources()],
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
