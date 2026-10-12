import {
  type Token,
  type TokenSet,
  concreteValue,
  cssVar,
  isTypography,
  tokenCss,
  valueIn,
} from './tokens';

export const TOKEN_EXPORTS = ['css', 'tailwind', 'json'] as const;

export type TokenExport = (typeof TOKEN_EXPORTS)[number];

const HEADER =
  'Design tokens, from design/tokens.tokens.json. Made by clanks Studio; edit the tokens there.';

/** Whether a token says something of its own in a mode, rather than following the default. */
function differsIn(token: Token, mode: string): boolean {
  return token.modes?.[mode] !== undefined;
}

function block(selector: string, lines: string[], indent = ''): string {
  return `${indent}${selector} {\n${lines.map((l) => `${indent}  ${l}`).join('\n')}\n${indent}}`;
}

/**
 * The tokens as CSS custom properties: the default mode on `:root`, each other mode under
 * `[data-theme="…"]`, and dark also when the system asks for it and no theme is set.
 */
export function tokensCss(set: TokenSet): string {
  const [first, ...others] = set.modes;
  const lines = (mode: string, only: (token: Token) => boolean) =>
    set.tokens
      .filter(only)
      .flatMap((token) => tokenCss(token, mode))
      .map(([name, value]) => `${name}: ${value};`);
  const parts = [
    `/* ${HEADER} */`,
    block(
      ':root',
      lines(first ?? 'light', () => true),
    ),
  ];
  for (const mode of others) {
    const own = lines(mode, (token) => differsIn(token, mode));
    if (own.length === 0) continue;
    parts.push(block(`[data-theme='${mode}']`, own));
    if (mode === 'dark') {
      parts.push(
        `@media (prefers-color-scheme: dark) {\n${block(':root:not([data-theme])', own, '  ')}\n}`,
      );
    }
  }
  return `${parts.join('\n\n')}\n`;
}

/** A token with everything it names looked up, as CSS values in one mode. */
function concreteCss(set: TokenSet, token: Token, mode: string): [string, string][] {
  const value = concreteValue(set, token.path, mode);
  if (value === null) return [];
  return tokenCss({ path: token.path, type: token.type, value }, mode);
}

/** Where a token goes in a Tailwind theme, so utilities such as `bg-brand` and `p-4` come out of it. */
function tailwindName(token: Token): string {
  const parts = token.path.split('.');
  const rest = (from: number) => parts.slice(from).join('-');
  const [group, second] = parts;
  if (token.type === 'color')
    return `--color-${group === 'color' || group === 'colour' ? rest(1) : rest(0)}`;
  if (token.type === 'typography')
    return `--text-${group === 'type' || group === 'text' ? rest(1) : rest(0)}`;
  if (token.type === 'shadow') return `--shadow-${group === 'shadow' ? rest(1) : rest(0)}`;
  if (token.type === 'fontFamily') {
    return `--font-${group === 'font' ? rest(second === 'family' ? 2 : 1) : rest(0)}`;
  }
  if (token.type === 'fontWeight') {
    return `--font-weight-${group === 'font' ? rest(second === 'weight' ? 2 : 1) : rest(0)}`;
  }
  if (token.type === 'cubicBezier')
    return `--ease-${rest(group === 'motion' ? 1 : 0).replace(/^eas(e|ing)-/, '')}`;
  if (token.type === 'dimension') {
    if (group === 'space' || group === 'spacing') return `--spacing-${rest(1)}`;
    if (group === 'radius' || group === 'radii') return `--radius-${rest(1)}`;
    if (group === 'breakpoint') return `--breakpoint-${rest(1)}`;
    if (group === 'font' && second === 'size') return `--text-${rest(2)}`;
  }
  return cssVar(token.path);
}

function tailwindLines(set: TokenSet, token: Token, mode: string): string[] {
  const name = tailwindName(token);
  if (token.type === 'typography') {
    const value = concreteValue(set, token.path, mode);
    if (!isTypography(value)) return [];
    return [
      `${name}: ${Number(value.fontSize)}px;`,
      `${name}--line-height: ${String(value.lineHeight)};`,
      `${name}--font-weight: ${String(value.fontWeight)};`,
      ...(value.letterSpacing
        ? [`${name}--letter-spacing: ${Number(value.letterSpacing)}px;`]
        : []),
    ];
  }
  return concreteCss(set, token, mode).map(([, value]) => `${name}: ${value};`);
}

/**
 * The tokens as a Tailwind CSS v4 theme. Theme variables are ordinary custom properties, so each
 * other mode overrides them under `[data-theme="…"]`.
 */
export function tokensTailwind(set: TokenSet): string {
  const [first, ...others] = set.modes;
  const base = set.tokens.flatMap((token) => tailwindLines(set, token, first ?? 'light'));
  const parts = [`/* ${HEADER} */`, "@import 'tailwindcss';", block('@theme', base)];
  for (const mode of others) {
    // A token changes in a mode when it, or anything it follows, does.
    const own = set.tokens
      .filter(
        (token) =>
          JSON.stringify(concreteValue(set, token.path, mode)) !==
          JSON.stringify(concreteValue(set, token.path, first ?? 'light')),
      )
      .flatMap((token) => tailwindLines(set, token, mode));
    if (own.length > 0) parts.push(block(`[data-theme='${mode}']`, own));
  }
  return `${parts.join('\n\n')}\n`;
}

/** The tokens as plain JSON: each mode's values, looked up and ready to use as CSS. */
export function tokensJson(set: TokenSet): string {
  const result: Record<string, Record<string, unknown>> = {};
  for (const mode of set.modes) {
    const tree: Record<string, unknown> = {};
    for (const token of set.tokens) {
      const value = concreteValue(set, token.path, mode);
      if (value === null) continue;
      const parts = token.path.split('.');
      let group = tree;
      for (const part of parts.slice(0, -1)) {
        if (typeof group[part] !== 'object' || group[part] === null) group[part] = {};
        group = group[part] as Record<string, unknown>;
      }
      const leaf = parts.at(-1)!;
      if (token.type === 'typography' && isTypography(value)) {
        group[leaf] = {
          fontFamily: value.fontFamily,
          fontSize: `${Number(value.fontSize)}px`,
          fontWeight: value.fontWeight,
          lineHeight: value.lineHeight,
          ...(value.letterSpacing ? { letterSpacing: `${Number(value.letterSpacing)}px` } : {}),
        };
      } else {
        group[leaf] = concreteCss(set, token, mode)[0]?.[1] ?? null;
      }
    }
    result[mode] = tree;
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function exportTokens(set: TokenSet, format: TokenExport): string {
  if (format === 'tailwind') return tokensTailwind(set);
  if (format === 'json') return tokensJson(set);
  return tokensCss(set);
}

/** The file an export is saved as, beside the tokens. */
export const EXPORT_FILES: Record<TokenExport, string> = {
  css: 'tokens.css',
  tailwind: 'tokens.tailwind.css',
  json: 'tokens.json',
};

/** One line per token for a prompt: its name, and its value in each mode where they differ. */
export function tokenLines(set: TokenSet): string[] {
  const [first, ...others] = set.modes;
  return set.tokens.map((token) => {
    const show = (mode: string) => {
      const value = valueIn(token, mode);
      const css = tokenCss({ path: token.path, type: token.type, value }, mode);
      if (token.type === 'typography') {
        const concrete = concreteValue(set, token.path, mode);
        return isTypography(concrete)
          ? `${concrete.fontFamily} ${String(concrete.fontSize)}px/${String(concrete.lineHeight)} ${String(concrete.fontWeight)}`
          : '';
      }
      if (typeof value === 'string' && (value.startsWith('{') || token.type === 'fontFamily')) {
        return value;
      }
      return css[0]?.[1] ?? '';
    };
    const modes = others
      .filter((mode) => differsIn(token, mode))
      .map((mode) => `, ${mode} ${show(mode)}`)
      .join('');
    return `{${token.path}} ${show(first ?? 'light')}${modes}`;
  });
}
