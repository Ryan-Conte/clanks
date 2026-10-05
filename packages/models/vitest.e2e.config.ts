import { defineConfig } from 'vitest/config';

// Runs a real llama-server on a real model pulled from Hugging Face. Needs the network and a
// fetched llama.cpp build: `pnpm fetch-llama`, or CLANKS_LLAMA_DIR pointing at one.
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.ts'],
    testTimeout: 10 * 60_000,
    hookTimeout: 60_000,
  },
});
