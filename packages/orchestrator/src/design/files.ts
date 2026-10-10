import {
  ASSETS_DIR,
  DESIGN_DIR,
  type Design,
  DesignFileError,
  LANGUAGE_FILE,
  TOKENS_FILE,
  type TokenSet,
  emptyTokens,
  parseDesign,
  parseTokens,
  serializeDesign,
  serializeTokens,
  stableJson,
} from '@clanks/design';
import { PathError, resolveInside } from '@clanks/workspace';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';

/** Images a design may show, by extension. */
export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/** Bigger than this isn't an image for a design; it would swamp the canvas. */
const MAX_ASSET_BYTES = 12 * 1024 * 1024;

/** The design files in a folder: every `design/<name>.design`, in name order. */
export function listDesigns(dir: string): string[] {
  const folder = join(dir, DESIGN_DIR);
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.design'))
    .filter((entry) => existsSync(join(folder, entry.name, 'document.json')))
    .map((entry) => `${DESIGN_DIR}/${entry.name}`)
    .sort();
}

/** Every file of a `.design` folder, by its path inside it. */
function readFolder(folder: string): Record<string, string> {
  const files: Record<string, string> = {};
  const read = (sub: string) => {
    const full = join(folder, sub);
    if (!existsSync(full)) return;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        files[sub ? `${sub}/${entry.name}` : entry.name] = readFileSync(
          join(full, entry.name),
          'utf8',
        );
      }
    }
  };
  read('');
  read('pages');
  read('components');
  return files;
}

/** Reads a design file. Null when it isn't there; throws a `DesignFileError` when it's broken. */
export function readDesign(dir: string, file: string): Design | null {
  const folder = join(dir, file);
  if (!existsSync(join(folder, 'document.json'))) return null;
  return parseDesign(readFolder(folder));
}

/**
 * Writes a design file: only the files that changed, and pages and components that are gone are
 * deleted, so git and the checkpoints see exactly what an edit touched.
 */
export function writeDesign(dir: string, file: string, design: Design): void {
  const folder = join(dir, file);
  const next = serializeDesign(design);
  const current = existsSync(folder) ? readFolder(folder) : {};
  for (const [path, text] of Object.entries(next)) {
    if (current[path] === text) continue;
    const full = join(folder, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  for (const path of Object.keys(current)) {
    if (!(path in next)) rmSync(join(folder, path), { force: true });
  }
}

/** The project's tokens. A file that can't be read gives none, and says why. */
export function readTokens(dir: string): { tokens: TokenSet; problems: string[] } {
  const path = join(dir, TOKENS_FILE);
  if (!existsSync(path)) return { tokens: emptyTokens(), problems: [] };
  try {
    const { set, problems } = parseTokens(JSON.parse(readFileSync(path, 'utf8')));
    return { tokens: set, problems };
  } catch (error) {
    return {
      tokens: emptyTokens(),
      problems: [
        `${TOKENS_FILE} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export function writeTokens(dir: string, tokens: TokenSet): void {
  const path = join(dir, TOKENS_FILE);
  const text = stableJson(serializeTokens(tokens));
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** `design/DESIGN.md`, the written half of the design language. Null when there isn't one. */
export function readLanguage(dir: string): string | null {
  const path = join(dir, LANGUAGE_FILE);
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** A path inside a folder, however it was written. Null when it leads outside, or nowhere. */
function inside(dir: string, path: string): string | null {
  try {
    const full = resolveInside(dir, dir, path.replace(/\\/g, '/').replace(/^\.?\//, ''));
    return existsSync(full) && statSync(full).isFile() ? full : null;
  } catch (error) {
    if (error instanceof PathError) return null;
    throw error;
  }
}

/** Whether an image a design names is a file in the project. */
export function hasAsset(dir: string, src: string): boolean {
  const full = inside(dir, src);
  return full !== null && extname(full).toLowerCase() in IMAGE_TYPES;
}

/** An image as a data URL the canvas can show. Null when it isn't an image in the project. */
export function assetUrl(dir: string, src: string): string | null {
  const full = inside(dir, src);
  if (!full) return null;
  const type = IMAGE_TYPES[extname(full).toLowerCase()];
  if (!type || statSync(full).size > MAX_ASSET_BYTES) return null;
  return `data:${type};base64,${readFileSync(full).toString('base64')}`;
}

export interface AssetInfo {
  /** From the project's top folder: `design/assets/hero.jpg`. */
  path: string;
  name: string;
  size: number;
}

/** The images in `design/assets`. */
export function listAssets(dir: string): AssetInfo[] {
  const folder = join(dir, ASSETS_DIR);
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() in IMAGE_TYPES)
    .map((entry) => ({
      path: `${ASSETS_DIR}/${entry.name}`,
      name: entry.name,
      size: statSync(join(folder, entry.name)).size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Saves an image the user brought in to `design/assets`, under a name that's free. */
export function writeAsset(dir: string, name: string, data: Uint8Array): AssetInfo {
  const extension = extname(name).toLowerCase();
  if (!(extension in IMAGE_TYPES)) {
    throw new DesignFileError(
      `${name} isn't an image Studio can show. Use PNG, JPEG, GIF, WebP, AVIF or SVG.`,
    );
  }
  if (data.length > MAX_ASSET_BYTES) {
    throw new DesignFileError(`${name} is bigger than 12 MB. Use a smaller image.`);
  }
  const base =
    name
      .slice(0, -extension.length)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'image';
  const folder = join(dir, ASSETS_DIR);
  mkdirSync(folder, { recursive: true });
  let file = `${base}${extension}`;
  for (let i = 2; existsSync(join(folder, file)); i++) file = `${base}-${i}${extension}`;
  writeFileSync(join(folder, file), data);
  return { path: `${ASSETS_DIR}/${file}`, name: file, size: data.length };
}
