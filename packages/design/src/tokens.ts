import { parseColor, toHex } from './color';
import { fontStack } from './fonts';
import { type TokenRef, isRef, refPath } from './schema';

export const TOKEN_TYPES = [
  'color',
  'dimension',
  'number',
  'fontFamily',
  'fontWeight',
  'duration',
  'cubicBezier',
  'shadow',
  'typography',
] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

/** A text style: family, size, weight, line height and letter spacing. Each part may be a token. */
export interface Typography {
  fontFamily: string;
  fontSize: number | TokenRef;
  fontWeight: number | TokenRef;
  lineHeight: number | TokenRef;
  letterSpacing?: number | TokenRef | undefined;
}

export interface Shadow {
  color: string;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  inset?: boolean | undefined;
}

/**
 * A token's value: a CSS colour, pixels, a plain number, a font family, a weight, milliseconds,
 * four easing numbers, shadows, a text style, or a reference to another token.
 */
export type TokenValue = string | number | number[] | Typography | Shadow[];

export interface Token {
  /** Its name, with dots between groups: `color.brand`. */
  path: string;
  type: TokenType;
  /** Its value in the first mode. */
  value: TokenValue;
  /** Its value in other modes, where it differs. */
  modes?: Record<string, TokenValue> | undefined;
  description?: string | undefined;
}

/** A project's design tokens. The first mode is the default one. */
export interface TokenSet {
  modes: string[];
  tokens: Token[];
}

export const DEFAULT_MODES = ['light', 'dark'];

/** Where the app keeps what the token format has no place for. */
const EXTENSION = 'si.clanks';

export function emptyTokens(): TokenSet {
  return { modes: [...DEFAULT_MODES], tokens: [] };
}

/** A token's name is lowercase words, digits and dashes, in groups joined by dots. */
export const TOKEN_PATH = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

export function findToken(set: TokenSet, path: string): Token | undefined {
  return set.tokens.find((t) => t.path === path);
}

/** A token's value in a mode: its own there, or the default mode's. */
export function valueIn(token: Token, mode: string): TokenValue {
  return token.modes?.[mode] ?? token.value;
}

/** A token followed through its aliases to a value that names no other token at the top. */
export function resolveToken(
  set: TokenSet,
  path: string,
  mode: string,
  seen: string[] = [],
): { token: Token; value: TokenValue } | null {
  const token = findToken(set, path);
  if (!token || seen.includes(path)) return null;
  const value = valueIn(token, mode);
  if (isRef(value)) return resolveToken(set, refPath(value), mode, [...seen, path]);
  return { token, value };
}

/** A colour token, or a colour as written, as a CSS colour in a mode. Null when it has none. */
export function resolveColor(set: TokenSet, value: string, mode: string): string | null {
  if (!isRef(value)) return value;
  const found = resolveToken(set, refPath(value), mode);
  return found && typeof found.value === 'string' ? found.value : null;
}

/** A number a property holds, through its token if it names one. */
export function resolveNumber(
  set: TokenSet,
  value: number | string | undefined,
  mode: string,
): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return value;
  if (!isRef(value)) return null;
  const found = resolveToken(set, refPath(value), mode);
  return found && typeof found.value === 'number' ? found.value : null;
}

/** A text style with every part followed to a plain value. */
export function resolveTypography(
  set: TokenSet,
  ref: string,
  mode: string,
): {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
} | null {
  const found = resolveToken(set, refPath(ref), mode);
  if (!found || !isTypography(found.value)) return null;
  const style = found.value;
  const family = isRef(style.fontFamily)
    ? resolveToken(set, refPath(style.fontFamily), mode)?.value
    : style.fontFamily;
  return {
    fontFamily: typeof family === 'string' ? family : 'system-ui',
    fontSize: resolveNumber(set, style.fontSize, mode) ?? 16,
    fontWeight: resolveNumber(set, style.fontWeight, mode) ?? 400,
    lineHeight: resolveNumber(set, style.lineHeight, mode) ?? 1.4,
    letterSpacing: resolveNumber(set, style.letterSpacing, mode) ?? 0,
  };
}

/**
 * A token's value in a mode with nothing left to look up: aliases followed, and the tokens named
 * inside a text style or a shadow replaced by their values. Null when a reference leads nowhere.
 */
export function concreteValue(set: TokenSet, path: string, mode: string): TokenValue | null {
  const found = resolveToken(set, path, mode);
  if (!found) return null;
  const { value } = found;
  const inner = (part: unknown): unknown => {
    if (!isRef(part)) return part;
    const target = concreteValue(set, refPath(part), mode);
    return target ?? part;
  };
  if (isShadows(value)) return value.map((s) => ({ ...s, color: String(inner(s.color)) }));
  if (isTypography(value)) {
    return {
      fontFamily: String(inner(value.fontFamily)),
      fontSize: inner(value.fontSize) as number,
      fontWeight: inner(value.fontWeight) as number,
      lineHeight: inner(value.lineHeight) as number,
      ...(value.letterSpacing === undefined
        ? {}
        : { letterSpacing: inner(value.letterSpacing) as number }),
    };
  }
  return value;
}

export function isTypography(value: unknown): value is Typography {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value as text, whatever it is: objects as JSON rather than `[object Object]`. */
function plain(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isShadows(value: unknown): value is Shadow[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null);
}

// Names in CSS

/** The CSS custom property a token becomes: `--color-brand` for `color.brand`. */
export function cssVar(path: string): string {
  return `--${path.replace(/\./g, '-')}`;
}

/** The parts of a text style, and the CSS property each sets. */
export const TYPOGRAPHY_PARTS = [
  ['fontFamily', 'font-family'],
  ['fontSize', 'font-size'],
  ['fontWeight', 'font-weight'],
  ['lineHeight', 'line-height'],
  ['letterSpacing', 'letter-spacing'],
] as const;

function shadowCss(shadows: Shadow[], colour: (value: string) => string): string {
  return shadows
    .map(
      (s) =>
        `${s.inset ? 'inset ' : ''}${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.spread}px ${colour(s.color)}`,
    )
    .join(', ');
}

/** A reference as CSS: `var(--color-brand)`. */
const varOf = (ref: string, suffix = '') => `var(${cssVar(refPath(ref))}${suffix})`;

/**
 * A token as CSS custom properties in one mode: one for most, five for a text style. A token that
 * names another becomes `var(--the-other)`, so it follows the other from mode to mode.
 */
export function tokenCss(token: Token, mode: string): [name: string, value: string][] {
  const name = cssVar(token.path);
  const value = valueIn(token, mode);
  if (token.type === 'typography') {
    if (isRef(value))
      return TYPOGRAPHY_PARTS.map(([, css]) => [`${name}-${css}`, varOf(value, `-${css}`)]);
    if (!isTypography(value)) return [];
    const part = (v: string | number | undefined, unit: string) =>
      v === undefined ? `0${unit}` : typeof v === 'number' ? `${v}${unit}` : varOf(v);
    return [
      [
        `${name}-font-family`,
        isRef(value.fontFamily) ? varOf(value.fontFamily) : fontStack(value.fontFamily),
      ],
      [`${name}-font-size`, part(value.fontSize, 'px')],
      [`${name}-font-weight`, part(value.fontWeight, '')],
      [`${name}-line-height`, part(value.lineHeight, '')],
      [`${name}-letter-spacing`, part(value.letterSpacing, 'px')],
    ];
  }
  if (isRef(value)) return [[name, varOf(value)]];
  switch (token.type) {
    case 'dimension':
      return [[name, `${Number(value)}px`]];
    case 'duration':
      return [[name, `${Number(value)}ms`]];
    case 'fontFamily':
      return [[name, fontStack(plain(value))]];
    case 'cubicBezier':
      return [[name, `cubic-bezier(${(value as number[]).join(', ')})`]];
    case 'shadow':
      return [
        [name, isShadows(value) ? shadowCss(value, (c) => (isRef(c) ? varOf(c) : c)) : 'none'],
      ];
    default:
      return [[name, plain(value)]];
  }
}

/** Every token as custom properties in one mode, for the element a design is drawn in. */
export function cssVariables(set: TokenSet, mode: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of set.tokens) {
    for (const [name, value] of tokenCss(token, mode)) vars[name] = value;
  }
  return vars;
}

// Reading values people and models write

/** A token problem worded for whoever wrote the value. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

/** The type a token's name suggests, for values that don't say. */
function typeFromPath(path: string): TokenType | null {
  const p = path.toLowerCase();
  if (/^(color|colour|wire)\b/.test(p)) return 'color';
  if (/^(type|typography|text)\b/.test(p)) return 'typography';
  if (/^shadow|^elevation/.test(p)) return 'shadow';
  if (/font\.?-?(family|families)|^font\.(sans|serif|mono|display|body|heading)/.test(p))
    return 'fontFamily';
  if (/font\.?-?weight|^weight\b/.test(p)) return 'fontWeight';
  if (/duration/.test(p)) return 'duration';
  if (/eas(e|ing)/.test(p)) return 'cubicBezier';
  if (/^(opacity|z|line-?height|leading)\b/.test(p)) return 'number';
  if (
    /^(space|spacing|size|sizing|radius|radii|border|width|breakpoint|font\.?-?size|gap)\b/.test(p)
  )
    return 'dimension';
  return null;
}

/** Works out a token's type from its name and the value given for it. */
export function inferType(path: string, given: unknown, set: TokenSet): TokenType {
  const raw = unquoted(given);
  if (isRef(raw)) {
    const target = findToken(set, refPath(raw));
    if (target) return target.type;
  }
  const named = typeFromPath(path);
  if (named) return named;
  if (typeof raw === 'number') return 'dimension';
  if (typeof raw === 'string') {
    if (parseColor(raw)) return 'color';
    if (/^-?[\d.]+(px|rem)$/.test(raw.trim())) return 'dimension';
    if (/^-?[\d.]+m?s$/.test(raw.trim())) return 'duration';
    return 'fontFamily';
  }
  if (Array.isArray(raw)) return raw.every((v) => typeof v === 'number') ? 'cubicBezier' : 'shadow';
  if (typeof raw === 'object' && raw !== null) {
    return 'fontSize' in raw || 'size' in raw || 'fontFamily' in raw || 'font' in raw
      ? 'typography'
      : 'shadow';
  }
  throw new TokenError(`Can't tell what kind of token ${path} is. Give it a type.`);
}

function numberOf(raw: unknown, what: string, units: Record<string, number>): number | TokenRef {
  if (isRef(raw)) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const match = /^(-?\d*\.?\d+)\s*([a-z%]*)$/i.exec(raw.trim());
    const factor = match ? units[match[2]!.toLowerCase()] : undefined;
    if (match && factor !== undefined) return Number(match[1]) * factor;
  }
  throw new TokenError(`${what} needs a number${units.px ? ' of pixels' : ''}, not ${show(raw)}.`);
}

const PX = { '': 1, px: 1, rem: 16, em: 16 };
const PLAIN = { '': 1 };
const WEIGHTS: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};

function show(raw: unknown): string {
  return typeof raw === 'string' ? `"${raw}"` : JSON.stringify(raw);
}

function pick(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (raw[name] !== undefined && raw[name] !== null) return raw[name];
  return undefined;
}

/** A shadow written as CSS: `0 4px 12px rgba(0,0,0,.2)`, several separated by commas. */
function parseShadowCss(text: string): Shadow[] {
  // Commas inside rgb() don't separate shadows.
  const parts = text.split(/,(?![^(]*\))/).map((p) => p.trim());
  return parts.filter(Boolean).map((part) => {
    const inset = /\binset\b/i.test(part);
    const rest = part.replace(/\binset\b/i, '').trim();
    const colour = /(#[0-9a-f]{3,8}|(?:rgba?|hsla?)\([^)]*\)|\{[\w.-]+\}|[a-z]+)\s*$/i.exec(rest);
    const lengths = (colour ? rest.slice(0, colour.index) : rest).trim().split(/\s+/);
    const numbers = lengths.filter(Boolean).map((l) => numberOf(l, 'A shadow', PX));
    if (numbers.length < 2 || numbers.some((n) => typeof n !== 'number')) {
      throw new TokenError(
        `A shadow is written like "0 4px 12px rgba(0,0,0,0.2)": x, y, blur, spread and a colour. Got ${show(text)}.`,
      );
    }
    const [offsetX, offsetY, blur = 0, spread = 0] = numbers as number[];
    return {
      color: colour?.[1] ?? '#00000033',
      offsetX: offsetX!,
      offsetY: offsetY!,
      blur,
      spread,
      ...(inset ? { inset: true } : {}),
    };
  });
}

/**
 * Turns a value as a person or a model writes it into the form a token of that type keeps:
 * `"16px"` to 16, `"bold"` to 700, a CSS shadow to its parts. Throws a `TokenError` saying what
 * the value should look like.
 */
export function coerceValue(type: TokenType, given: unknown, what = 'The value'): TokenValue {
  if (isRef(given)) return given;
  const raw = unquoted(given);
  switch (type) {
    case 'color': {
      if (typeof raw !== 'string' || !parseColor(raw)) {
        throw new TokenError(
          `${what} needs a colour such as "#0a84ff" or "rgb(10 132 255)", or a token such as {color.blue.500}, not ${show(raw)}.`,
        );
      }
      return raw.trim();
    }
    case 'dimension':
      return numberOf(raw, what, PX);
    case 'number':
      return numberOf(raw, what, { '': 1, '%': 0.01 });
    case 'duration':
      return numberOf(raw, what, { '': 1, ms: 1, s: 1000 });
    case 'fontWeight': {
      if (typeof raw === 'string' && WEIGHTS[raw.trim().toLowerCase()]) {
        return WEIGHTS[raw.trim().toLowerCase()]!;
      }
      return numberOf(raw, what, PLAIN);
    }
    case 'fontFamily': {
      const family = Array.isArray(raw) ? raw.join(', ') : raw;
      if (typeof family !== 'string' || !family.trim()) {
        throw new TokenError(`${what} needs a font family such as "Inter", not ${show(raw)}.`);
      }
      return family.trim();
    }
    case 'cubicBezier': {
      const numbers =
        typeof raw === 'string'
          ? raw
              .replace(/cubic-bezier|[()]/g, '')
              .split(/[\s,]+/)
              .filter(Boolean)
              .map(Number)
          : raw;
      if (
        !Array.isArray(numbers) ||
        numbers.length !== 4 ||
        numbers.some((n) => typeof n !== 'number' || Number.isNaN(n))
      ) {
        throw new TokenError(
          `${what} needs four numbers such as [0.2, 0, 0, 1], not ${show(raw)}.`,
        );
      }
      return numbers as number[];
    }
    case 'shadow': {
      if (typeof raw === 'string') return parseShadowCss(raw);
      const list = Array.isArray(raw) ? raw : [raw];
      return list.map((item) => {
        if (typeof item === 'string') return parseShadowCss(item)[0]!;
        if (typeof item !== 'object' || item === null) {
          throw new TokenError(`${what} needs a shadow such as "0 4px 12px rgba(0,0,0,0.2)".`);
        }
        const s = item as Record<string, unknown>;
        const n = (value: unknown) => {
          const number = value === undefined ? 0 : numberOf(dimensionOf(value), 'A shadow', PX);
          return typeof number === 'number' ? number : 0;
        };
        const colour = dtcgColor(pick(s, 'color')) ?? '#00000033';
        return {
          color: colour,
          offsetX: n(pick(s, 'offsetX', 'x')),
          offsetY: n(pick(s, 'offsetY', 'y')),
          blur: n(pick(s, 'blur')),
          spread: n(pick(s, 'spread')),
          ...(s.inset ? { inset: true } : {}),
        };
      });
    }
    case 'typography': {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new TokenError(
          `${what} needs a text style such as { "font": "{font.family.sans}", "size": 48, "weight": 700, "lineHeight": 1.1 }, not ${show(raw)}.`,
        );
      }
      const t = raw as Record<string, unknown>;
      const family = pick(t, 'fontFamily', 'font', 'family');
      const size = pick(t, 'fontSize', 'size');
      if (size === undefined) throw new TokenError(`${what} needs a size, such as "size": 16.`);
      const spacing = pick(t, 'letterSpacing', 'tracking');
      return {
        fontFamily: coerceValue('fontFamily', family ?? 'system-ui', 'Its font') as string,
        fontSize: numberOf(dimensionOf(size), 'Its size', PX),
        fontWeight: coerceValue(
          'fontWeight',
          pick(t, 'fontWeight', 'weight') ?? 400,
          'Its weight',
        ) as number | TokenRef,
        lineHeight: lineHeightOf(pick(t, 'lineHeight', 'line', 'leading') ?? 1.4),
        ...(spacing === undefined
          ? {}
          : { letterSpacing: numberOf(dimensionOf(spacing), 'Its letter spacing', PX) }),
      };
    }
  }
}

/**
 * A text style or a list a model wrote as JSON inside a string, which small models do when a value
 * may be anything: read as the object it spells. Anything else is left as it is.
 */
function unquoted(raw: unknown): unknown {
  // `{ "value": "#0a0a0a" }` for `"#0a0a0a"`. A length says its unit too, and is read as one.
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    if (keys.length === 1 && (keys[0] === 'value' || keys[0] === '$value')) {
      return unquoted((raw as Record<string, unknown>)[keys[0]]);
    }
  }
  if (typeof raw !== 'string' || !/^\s*[[{]/.test(raw) || isRef(raw.trim())) return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** A line height as a multiple of the size. Pixels over 4 are taken as a mistake for one. */
function lineHeightOf(raw: unknown): number | TokenRef {
  if (typeof raw === 'string' && raw.trim().endsWith('%')) return Number.parseFloat(raw) / 100;
  return numberOf(raw, 'Its line height', PLAIN);
}

/** The format's own way of writing a length: `{ "value": 16, "unit": "px" }`. */
function dimensionOf(raw: unknown): unknown {
  if (typeof raw === 'object' && raw !== null && 'value' in raw) {
    const { value, unit } = raw as { value: unknown; unit?: unknown };
    return typeof unit === 'string' ? `${String(value)}${unit}` : value;
  }
  return raw;
}

/** The format's own way of writing a colour: components in a colour space, with a hex fallback. */
function dtcgColor(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as { hex?: unknown; components?: unknown; alpha?: unknown; colorSpace?: unknown };
  const alpha = typeof c.alpha === 'number' ? c.alpha : 1;
  if (Array.isArray(c.components) && (c.colorSpace ?? 'srgb') === 'srgb') {
    const [r, g, b] = c.components.map((n) => (typeof n === 'number' ? n * 255 : 0));
    return toHex({ r: r ?? 0, g: g ?? 0, b: b ?? 0, a: alpha });
  }
  if (typeof c.hex === 'string') {
    const parsed = parseColor(c.hex);
    return parsed ? toHex({ ...parsed, a: alpha }) : c.hex;
  }
  return null;
}

// The Design Tokens Community Group format

type Json = Record<string, unknown>;

function writeColor(value: string): unknown {
  const parsed = parseColor(value);
  if (!parsed) return value;
  const round = (n: number) => Math.round((n / 255) * 10_000) / 10_000;
  return {
    colorSpace: 'srgb',
    components: [round(parsed.r), round(parsed.g), round(parsed.b)],
    ...(parsed.a < 1 ? { alpha: Math.round(parsed.a * 1000) / 1000 } : {}),
    hex: toHex({ ...parsed, a: 1 }),
  };
}

const px = (value: number | TokenRef) => (isRef(value) ? value : { value, unit: 'px' });

function writeValue(type: TokenType, value: TokenValue): unknown {
  if (isRef(value)) return value;
  switch (type) {
    case 'color':
      return writeColor(plain(value));
    case 'dimension':
      return px(value as number);
    case 'duration':
      return { value, unit: 'ms' };
    case 'shadow':
      return (value as Shadow[]).map((s) => ({
        color: isRef(s.color) ? s.color : writeColor(s.color),
        offsetX: px(s.offsetX),
        offsetY: px(s.offsetY),
        blur: px(s.blur),
        spread: px(s.spread),
        ...(s.inset ? { inset: true } : {}),
      }));
    case 'typography': {
      const t = value as Typography;
      return {
        fontFamily: t.fontFamily,
        fontSize: px(t.fontSize),
        fontWeight: t.fontWeight,
        lineHeight: t.lineHeight,
        ...(t.letterSpacing === undefined ? {} : { letterSpacing: px(t.letterSpacing) }),
      };
    }
    default:
      return value;
  }
}

/** Names in order, with numbers by size: `space.2` before `space.10`. */
function byName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

function sortKeys(group: Json): Json {
  const sorted: Json = {};
  const keys = Object.keys(group).sort((a, b) =>
    a.startsWith('$') === b.startsWith('$') ? byName(a, b) : a.startsWith('$') ? -1 : 1,
  );
  for (const key of keys) {
    const value = group[key];
    sorted[key] =
      !key.startsWith('$') && typeof value === 'object' && value !== null && !Array.isArray(value)
        ? sortKeys(value as Json)
        : value;
  }
  return sorted;
}

/** The tokens as a Design Tokens Community Group document, with sorted keys for readable diffs. */
export function serializeTokens(set: TokenSet): Json {
  const root: Json = { $extensions: { [EXTENSION]: { modes: set.modes } } };
  for (const token of set.tokens) {
    const parts = token.path.split('.');
    let group = root;
    for (const part of parts.slice(0, -1)) {
      if (typeof group[part] !== 'object' || group[part] === null) group[part] = {};
      group = group[part] as Json;
    }
    const modes = Object.entries(token.modes ?? {});
    group[parts.at(-1)!] = {
      $type: token.type,
      $value: writeValue(token.type, token.value),
      ...(token.description ? { $description: token.description } : {}),
      ...(modes.length > 0
        ? {
            $extensions: {
              [EXTENSION]: {
                modes: Object.fromEntries(
                  modes.map(([mode, value]) => [mode, writeValue(token.type, value)]),
                ),
              },
            },
          }
        : {}),
    };
  }
  return sortKeys(root);
}

/** A value from a token file, in the form a token of that type keeps. */
function readValue(type: TokenType, raw: unknown, what: string): TokenValue {
  if (type === 'color') return coerceValue(type, dtcgColor(raw) ?? raw, what);
  if (type === 'dimension' || type === 'duration') return coerceValue(type, dimensionOf(raw), what);
  return coerceValue(type, raw, what);
}

/**
 * Reads a Design Tokens Community Group document. Tokens that can't be read are left out and
 * named in `problems`, so one bad value never loses the rest.
 */
export function parseTokens(json: unknown): { set: TokenSet; problems: string[] } {
  const set = emptyTokens();
  const problems: string[] = [];
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { set, problems: ['The token file is not a JSON object.'] };
  }
  const root = json as Json;
  const declared = extension(root)?.modes;
  if (Array.isArray(declared) && declared.every((m) => typeof m === 'string') && declared.length) {
    set.modes = declared;
  }
  const walk = (group: Json, path: string[], inherited: TokenType | null) => {
    const own = group.$type;
    const type = isTokenType(own) ? own : inherited;
    for (const [key, value] of Object.entries(group)) {
      if (key.startsWith('$') || typeof value !== 'object' || value === null) continue;
      const node = value as Json;
      const at = [...path, key];
      // The format doesn't allow tokens inside a token, but a file may have them: keep them.
      if (Object.keys(node).some((inner) => !inner.startsWith('$'))) {
        walk(node, at, isTokenType(node.$type) && !('$value' in node) ? node.$type : type);
      }
      if (!('$value' in node)) continue;
      const name = at.join('.');
      try {
        const tokenType = isTokenType(node.$type)
          ? node.$type
          : (type ?? inferType(name, dtcgColor(node.$value) ?? dimensionOf(node.$value), set));
        const token: Token = {
          path: name,
          type: tokenType,
          value: readValue(tokenType, node.$value, name),
        };
        if (typeof node.$description === 'string') token.description = node.$description;
        const modes = extension(node)?.modes;
        if (typeof modes === 'object' && modes !== null && !Array.isArray(modes)) {
          for (const [mode, modeValue] of Object.entries(modes as Json)) {
            token.modes = { ...token.modes, [mode]: readValue(tokenType, modeValue, name) };
            if (!set.modes.includes(mode)) set.modes.push(mode);
          }
        }
        set.tokens.push(token);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
  };
  walk(root, [], null);
  return { set, problems };
}

function extension(node: Json): Json | null {
  const extensions = node.$extensions;
  if (typeof extensions !== 'object' || extensions === null) return null;
  const own = (extensions as Json)[EXTENSION];
  return typeof own === 'object' && own !== null ? (own as Json) : null;
}

function isTokenType(value: unknown): value is TokenType {
  return typeof value === 'string' && (TOKEN_TYPES as readonly string[]).includes(value);
}

// Changing tokens

/** A token as a tool or the tokens panel sets it. */
export interface TokenInput {
  name: string;
  value: unknown;
  type?: TokenType | undefined;
  /** Its value in other modes, by mode. */
  modes?: Record<string, unknown> | undefined;
  description?: string | undefined;
}

/**
 * Checks a token someone wants to set and returns it ready to store. Throws a `TokenError` for a
 * name or a value that won't do, or a reference to a token that doesn't exist.
 */
export function makeToken(set: TokenSet, input: TokenInput): Token {
  const path = input.name
    .trim()
    .replace(/^\{|\}$/g, '')
    .replace(/^--/, '')
    .replace(/\//g, '.');
  if (!TOKEN_PATH.test(path)) {
    throw new TokenError(
      `"${input.name}" isn't a token name. Use lowercase groups joined by dots, such as color.brand or space.4.`,
    );
  }
  const existing = findToken(set, path);
  if (!existing) {
    const parts = path.split('.');
    const above = set.tokens.find((t) => path.startsWith(`${t.path}.`));
    if (above) {
      const tail = parts.slice(above.path.split('.').length).join('-');
      throw new TokenError(
        `{${above.path}} is a token, so nothing can be named inside it. Name this one ${above.path}-${tail} instead.`,
      );
    }
    const below = set.tokens.find((t) => t.path.startsWith(`${path}.`));
    if (below) {
      throw new TokenError(
        `${path} is a group that holds {${below.path}}, so it can't be a token as well. Name this one ${path}.default, or another name inside the group.`,
      );
    }
  }
  const type = input.type ?? existing?.type ?? inferType(path, input.value, set);
  const token: Token = { path, type, value: coerceValue(type, input.value, path) };
  const description = input.description ?? existing?.description;
  if (description) token.description = description;
  for (const [mode, raw] of Object.entries(input.modes ?? {})) {
    if (raw === undefined || raw === null) continue;
    token.modes = { ...token.modes, [mode]: coerceValue(type, raw, `${path} in ${mode}`) };
  }
  for (const value of [token.value, ...Object.values(token.modes ?? {})]) {
    for (const ref of refsIn(value)) {
      const target = refPath(ref);
      if (target === path) throw new TokenError(`${path} can't refer to itself.`);
      if (!findToken(set, target)) {
        throw new TokenError(
          `${path} refers to ${ref}, which isn't a token${suggest(target, set)}. Create it first, in the same call or an earlier one.`,
        );
      }
    }
  }
  return token;
}

/** Every token a value names. */
export function refsIn(value: unknown): TokenRef[] {
  if (isRef(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(refsIn);
  return [];
}

/** " (did you mean {color.brand}?)", when a token's name is close to one that exists. */
export function suggest(path: string, set: TokenSet): string {
  const names = set.tokens.map((t) => t.path);
  const last = path.split('.').at(-1)!;
  const group = path.split('.').slice(0, -1).join('.');
  const close =
    names.find((n) => n.toLowerCase() === path.toLowerCase()) ??
    names.find((n) => n.startsWith(`${path}.`)) ??
    names.find((n) => n.startsWith(`${group}.`) && n.endsWith(`.${last}`)) ??
    names.find((n) => distance(n, path) <= 2) ??
    names.find((n) => group !== '' && n.startsWith(`${group}.`));
  if (close) return ` (did you mean {${close}}?)`;
  return names.length === 0 ? ' (there are no tokens yet)' : '';
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length]!;
}

/** A token's value in words: `#0a84ff`, `16px`, `{color.blue.500}`, `Inter 48/1.1 700`. */
export function valueText(type: TokenType, value: TokenValue): string {
  if (isRef(value)) return value;
  switch (type) {
    case 'dimension':
      return `${Number(value)}px`;
    case 'duration':
      return `${Number(value)}ms`;
    case 'cubicBezier':
      return `cubic-bezier(${(value as number[]).join(', ')})`;
    case 'shadow':
      return isShadows(value) ? shadowCss(value, (c) => c) : plain(value);
    case 'typography': {
      if (!isTypography(value)) return plain(value);
      const spacing =
        value.letterSpacing === undefined || value.letterSpacing === 0
          ? ''
          : ` tracking ${String(value.letterSpacing)}`;
      return `${value.fontFamily} ${String(value.fontSize)}/${String(value.lineHeight)} ${String(value.fontWeight)}${spacing}`;
    }
    default:
      return plain(value);
  }
}

/** The token types a layer's property takes. A reference to any other kind is a mistake. */
export const PROP_TOKEN_TYPES: Record<string, readonly TokenType[]> = {
  fill: ['color'],
  stroke: ['color'],
  color: ['color'],
  gap: ['dimension', 'number'],
  pad: ['dimension', 'number'],
  radius: ['dimension', 'number'],
  strokeWidth: ['dimension', 'number'],
  size: ['dimension', 'number'],
  letterSpacing: ['dimension', 'number'],
  w: ['dimension', 'number'],
  h: ['dimension', 'number'],
  opacity: ['number'],
  lineHeight: ['number'],
  weight: ['fontWeight', 'number'],
  font: ['fontFamily'],
  style: ['typography'],
  shadow: ['shadow'],
};

/** Greyscale tokens for wireframes. They're added to a project the first time one is used. */
export const WIRE_TOKENS: readonly Token[] = [
  { path: 'wire.bg', type: 'color', value: '#ffffff', description: 'Wireframe page background' },
  { path: 'wire.surface', type: 'color', value: '#f1f1f3', description: 'Wireframe panels' },
  { path: 'wire.fill', type: 'color', value: '#d9d9de', description: 'Wireframe blocks' },
  { path: 'wire.line', type: 'color', value: '#b4b4bc', description: 'Wireframe borders' },
  { path: 'wire.muted', type: 'color', value: '#6f6f78', description: 'Wireframe secondary text' },
  { path: 'wire.text', type: 'color', value: '#26262b', description: 'Wireframe text' },
];
