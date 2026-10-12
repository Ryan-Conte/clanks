/** A colour as red, green, blue (0 to 255) and alpha (0 to 1). */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The named colours designs actually use. Anything else is written as hex or rgb(). */
const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  transparent: '#00000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  pink: '#ffc0cb',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  navy: '#000080',
  teal: '#008080',
};

/** Reads a CSS colour: hex, rgb(), hsl() or a common name. Null for anything else. */
export function parseColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase();
  const named = NAMED[text];
  if (named) return parseColor(named);
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = [...hex].map((c) => parseInt(c + c, 16));
      return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : a / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^)]+)\)$/.exec(text);
  if (!fn) return null;
  const parts = fn[2]!
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  const alpha = parts[3] === undefined ? 1 : unit(parts[3], 1);
  if (fn[1]!.startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map((p) => unit(p, 255));
    if ([r, g, b, alpha].some((v) => v === null)) return null;
    return { r: clamp(r!, 255), g: clamp(g!, 255), b: clamp(b!, 255), a: clamp(alpha!, 1) };
  }
  const h = Number.parseFloat(parts[0]!);
  const s = unit(parts[1]!, 1);
  const l = unit(parts[2]!, 1);
  if (Number.isNaN(h) || s === null || l === null || alpha === null) return null;
  return { ...hslToRgb(h, clamp(s, 1), clamp(l, 1)), a: clamp(alpha, 1) };
}

/** `50%` of `full`, or a plain number. */
function unit(text: string, full: number): number | null {
  const value = Number.parseFloat(text);
  if (Number.isNaN(value)) return null;
  return text.endsWith('%') ? (value / 100) * full : value;
}

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    r: Math.round(channel(hue + 1 / 3) * 255),
    g: Math.round(channel(hue) * 255),
    b: Math.round(channel(hue - 1 / 3) * 255),
  };
}

/** A colour as `#rrggbb`, or `#rrggbbaa` when it isn't opaque. */
export function toHex(color: Rgba): string {
  const part = (value: number) => Math.round(value).toString(16).padStart(2, '0');
  const alpha = color.a < 1 ? part(color.a * 255) : '';
  return `#${part(color.r)}${part(color.g)}${part(color.b)}${alpha}`;
}

/** One colour laid over another, as it looks. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/** Relative luminance, as WCAG defines it. */
export function luminance(color: Rgba): number {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** The WCAG contrast ratio between two opaque colours, from 1 to 21. */
export function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
