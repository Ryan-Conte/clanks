import { icons } from 'lucide';

/** `shopping-cart` for `ShoppingCart`. */
function kebab(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])(\d)/g, '$1-$2')
    .replace(/(\d)([A-Za-z])/g, '$1-$2')
    .toLowerCase();
}

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

let cache: Map<string, string> | null = null;

/** Studio's built-in icons, from Lucide: each one's shapes, as the inside of an SVG. */
function all(): Map<string, string> {
  if (cache) return cache;
  cache = new Map();
  for (const [name, shapes] of Object.entries(icons)) {
    const inner = shapes
      .map(
        ([tag, attrs]) =>
          `<${tag}${Object.entries(attrs)
            .map(([key, value]) => ` ${key}="${escape(String(value))}"`)
            .join('')}/>`,
      )
      .join('');
    cache.set(kebab(name), inner);
  }
  return cache;
}

/** Every icon's name, such as `shopping-cart`, in order. */
export function iconNames(): string[] {
  return [...all().keys()].sort();
}

/** The shapes of an icon, to go inside an `<svg viewBox="0 0 24 24">`. Null for an unknown name. */
export function iconShapes(name: string): string | null {
  return all().get(name.trim().toLowerCase()) ?? null;
}

/** Names close to one that isn't an icon, for saying what was meant. */
export function iconsLike(name: string, limit = 6): string[] {
  const wanted = name.trim().toLowerCase();
  const words = wanted.split('-').filter(Boolean);
  const names = iconNames();
  const starts = names.filter((n) => n.startsWith(wanted) || wanted.startsWith(n));
  const shares = names.filter((n) => words.some((w) => w.length > 2 && n.split('-').includes(w)));
  return [...new Set([...starts, ...shares])].slice(0, limit);
}
