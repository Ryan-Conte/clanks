import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';

/** The user guides, read straight from docs/guide so the site and the repo never drift apart. */
const guide = defineCollection({
  loader: glob({ pattern: '*.md', base: '../../docs/guide' }),
});

export const collections = { guide };
