/** A typeface that ships with Studio, under an open licence, so designs look the same offline. */
export interface BundledFont {
  /** The name designs and tokens use. */
  family: string;
  kind: 'sans' | 'serif' | 'mono';
  /** The CSS font stack it's drawn with. The bundled files are variable fonts. */
  stack: string;
  /** The npm package a build installs to match the design. */
  package: string;
}

const GENERIC = {
  sans: 'system-ui, sans-serif',
  serif: 'Georgia, serif',
  mono: 'ui-monospace, monospace',
};

export const FONTS: readonly BundledFont[] = [
  font('Geist', 'sans', 'geist'),
  font('Inter', 'sans', 'inter'),
  font('DM Sans', 'sans', 'dm-sans'),
  font('Space Grotesk', 'sans', 'space-grotesk'),
  font('Fraunces', 'serif', 'fraunces'),
  font('Playfair Display', 'serif', 'playfair-display'),
  font('Lora', 'serif', 'lora'),
  font('Geist Mono', 'mono', 'geist-mono'),
  font('JetBrains Mono', 'mono', 'jetbrains-mono'),
];

function font(family: string, kind: BundledFont['kind'], slug: string): BundledFont {
  return {
    family,
    kind,
    stack: `"${family} Variable", "${family}", ${GENERIC[kind]}`,
    package: `@fontsource-variable/${slug}`,
  };
}

/** A bundled font by name, however it's capitalised. */
export function bundledFont(family: string): BundledFont | undefined {
  const wanted = family
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
  return FONTS.find((f) => f.family.toLowerCase() === wanted);
}

const GENERIC_FAMILY = /^(system-ui|sans-serif|serif|monospace|ui-[a-z-]+|cursive|fantasy)$/i;

/**
 * The CSS font-family for what a design names: one family, or a list as CSS writes it. Each
 * bundled font in it is drawn from the bundled files; a generic family is kept; anything else is
 * tried by name. A list that ends without a generic family gets one, so text never falls back to
 * the browser's serif.
 */
export function fontStack(family: string): string {
  const stack: string[] = [];
  let generic: string | null = null;
  for (const part of family.split(',')) {
    const name = part.trim().replace(/^["']|["']$/g, '');
    if (!name) continue;
    const bundled = bundledFont(name);
    if (bundled) {
      stack.push(`"${bundled.family} Variable"`, `"${bundled.family}"`);
      generic ??= GENERIC[bundled.kind];
    } else if (GENERIC_FAMILY.test(name)) {
      stack.push(name.toLowerCase());
    } else {
      stack.push(`"${name.replace(/"/g, '')}"`);
    }
  }
  if (!stack.some((name) => GENERIC_FAMILY.test(name))) {
    for (const name of (generic ?? GENERIC.sans).split(', ')) {
      if (!stack.includes(`"${name}"`)) stack.push(name);
    }
  }
  return [...new Set(stack)].join(', ');
}

/** The first family a font value names, which is the one a design means. */
export function firstFamily(family: string): string {
  return (family.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}
