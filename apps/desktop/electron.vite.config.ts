import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const migrations = join(import.meta.dirname, '../../packages/orchestrator/drizzle');

/** Ships the orchestrator's SQL migrations next to the main bundle, where it opens the database. */
function copyMigrations(): Plugin {
  return {
    name: 'clanks:copy-migrations',
    writeBundle(options) {
      if (options.dir) cpSync(migrations, join(options.dir, 'migrations'), { recursive: true });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [copyMigrations()],
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
