/**
 * A frame as a browser painted it: each layer's box with the colours, borders and type it ended up
 * with, every token looked up. The page frames are drawn on reads this off the laid-out frame, and
 * `paintSvg` draws it again as SVG, so an export is vectors and real text rather than a picture.
 */

/** One line of a text layer, as the browser broke it. */
export interface PaintedLine {
  text: string;
  x: number;
  /** Where the letters sit. */
  baseline: number;
  w: number;
}

export interface PaintedBorder {
  w: number;
  color: string;
}

export interface Painted {
  key: string;
  /** Its box, from the frame's top left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** A CSS colour as the browser computed it. Empty when there's none. */
  background: string;
  /** Top, right, bottom, left. */
  borders: [PaintedBorder, PaintedBorder, PaintedBorder, PaintedBorder];
  /** Corner radii across and down, in pixels, no bigger than half the box. */
  radius: [number, number];
  opacity: number;
  /** It cuts off what's inside it at its edge. */
  clip: boolean;
  /** `box-shadow` as computed, or empty. */
  shadow: string;
  /** A placeholder for an image that isn't there yet. */
  placeholder?: boolean;
  text?: {
    lines: PaintedLine[];
    color: string;
    family: string;
    size: number;
    weight: string;
    italic: boolean;
    /** Letter spacing in pixels. */
    spacing: number;
    underline: boolean;
  };
  image?: { src: string; fit: 'cover' | 'contain' | 'fill' };
  /** A built-in icon: its shapes, and how they're stroked. */
  icon?: { viewBox: string; inner: string; stroke: string; strokeWidth: string; fill: string };
  children: Painted[];
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const round = (n: number) => String(Math.round(n * 100) / 100);

/** A computed colour as SVG takes it everywhere: the colour, and its alpha apart. */
export function svgColor(color: string): { color: string; opacity: number } | null {
  const value = color.trim();
  if (!value || value === 'transparent' || value === 'none') return null;
  const rgb =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value);
  if (!rgb) return { color: value, opacity: 1 };
  const alpha =
    rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : Number(rgb[4]);
  if (alpha === 0) return null;
  const hex = [rgb[1], rgb[2], rgb[3]]
    .map((part) => Math.round(Number(part)).toString(16).padStart(2, '0'))
    .join('');
  return { color: `#${hex}`, opacity: alpha };
}

function paintAttrs(name: 'fill' | 'stroke', color: string): string {
  const parsed = svgColor(color);
  if (!parsed) return ` ${name}="none"`;
  return ` ${name}="${escapeXml(parsed.color)}"${parsed.opacity < 1 ? ` ${name}-opacity="${round(parsed.opacity)}"` : ''}`;
}

/**
 * A font stack for a file that's opened elsewhere: the app's bundled fonts are variable ones,
 * named "Inter Variable", where another computer has the family as plain "Inter".
 */
export function svgFontFamily(family: string): string {
  const names: string[] = [];
  for (const part of family.split(',')) {
    const name = part.trim().replace(/^["']|["']$/g, '');
    if (!name) continue;
    const plain = name.replace(/ Variable$/, '');
    for (const one of plain === name ? [name] : [plain, name]) {
      if (!names.includes(one)) names.push(one);
    }
  }
  return names.map((name) => (/^[a-z-]+$/.test(name) ? name : `'${name}'`)).join(', ');
}

/** The first shadow of a computed `box-shadow`, as a drop shadow. Inset shadows are left out. */
function shadowFilter(shadow: string, id: string): string | null {
  if (!shadow || shadow === 'none' || /\binset\b/.test(shadow)) return null;
  const first = shadow.split(/,(?![^(]*\))/)[0]!.trim();
  const colour =
    /(rgba?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+\([^)]*\))/i.exec(first)?.[0] ?? 'rgba(0,0,0,0.3)';
  const lengths = first
    .replace(colour, '')
    .trim()
    .split(/\s+/)
    .map((part) => parseFloat(part))
    .filter((n) => !Number.isNaN(n));
  const [dx = 0, dy = 0, blur = 0] = lengths;
  const parsed = svgColor(colour);
  if (!parsed) return null;
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${round(dx)}" dy="${round(dy)}" stdDeviation="${round(blur / 2)}" flood-color="${escapeXml(parsed.color)}" flood-opacity="${round(parsed.opacity)}"/></filter>`;
}

/**
 * A painted frame as an SVG document. Boxes are shapes, text is text set line by line as the
 * browser broke it, icons keep their strokes and images are embedded.
 */
export function paintSvg(root: Painted, options: { title?: string } = {}): string {
  const defs: string[] = [];
  let ids = 0;
  const draw = (node: Painted): string => {
    const parts: string[] = [];
    const [rx, ry] = node.radius;
    const corner = rx > 0 || ry > 0 ? ` rx="${round(rx)}" ry="${round(ry)}"` : '';
    const box = `x="${round(node.x)}" y="${round(node.y)}" width="${round(node.w)}" height="${round(node.h)}"`;
    const even =
      node.borders.every((b) => b.w === node.borders[0].w && b.color === node.borders[0].color) &&
      node.borders[0].w > 0;
    const filled = svgColor(node.background) !== null || node.placeholder === true;
    let filter = '';
    if (filled || even) {
      const made = shadowFilter(node.shadow, `s${ids + 1}`);
      if (made) {
        ids++;
        defs.push(made);
        filter = ` filter="url(#s${ids})"`;
      }
    }
    if (filled && node.w > 0 && node.h > 0) {
      const fill = node.placeholder
        ? ' fill="#808080" fill-opacity="0.14"'
        : paintAttrs('fill', node.background);
      parts.push(`<rect ${box}${corner}${fill}${filter}/>`);
      filter = '';
    }
    if (node.image && node.w > 0 && node.h > 0) {
      const aspect =
        node.image.fit === 'contain'
          ? 'xMidYMid meet'
          : node.image.fit === 'fill'
            ? 'none'
            : 'xMidYMid slice';
      let clip = '';
      if (corner) {
        ids++;
        defs.push(`<clipPath id="c${ids}"><rect ${box}${corner}/></clipPath>`);
        clip = ` clip-path="url(#c${ids})"`;
      }
      parts.push(
        `<image ${box} preserveAspectRatio="${aspect}" href="${escapeXml(node.image.src)}"${clip}/>`,
      );
    }
    if (node.icon && node.w > 0 && node.h > 0) {
      const stroke = svgColor(node.icon.stroke);
      const fill = svgColor(node.icon.fill);
      parts.push(
        `<svg ${box} viewBox="${escapeXml(node.icon.viewBox)}" fill="${fill ? escapeXml(fill.color) : 'none'}" stroke="${stroke ? escapeXml(stroke.color) : 'none'}"${stroke && stroke.opacity < 1 ? ` stroke-opacity="${round(stroke.opacity)}"` : ''} stroke-width="${escapeXml(node.icon.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round">${node.icon.inner}</svg>`,
      );
    }
    let inside = node.children.map(draw).join('');
    if (node.text) {
      const t = node.text;
      const style = [
        `font-family="${escapeXml(svgFontFamily(t.family))}"`,
        `font-size="${round(t.size)}"`,
        t.weight && t.weight !== '400' ? `font-weight="${escapeXml(t.weight)}"` : '',
        t.italic ? 'font-style="italic"' : '',
        t.spacing ? `letter-spacing="${round(t.spacing)}"` : '',
        t.underline ? 'text-decoration="underline"' : '',
      ]
        .filter(Boolean)
        .join(' ');
      inside += `<text ${style}${paintAttrs('fill', t.color)} xml:space="preserve">${t.lines
        .map(
          (line) =>
            `<tspan x="${round(line.x)}" y="${round(line.baseline)}">${escapeXml(line.text)}</tspan>`,
        )
        .join('')}</text>`;
    }
    if (inside && node.clip) {
      ids++;
      defs.push(`<clipPath id="c${ids}"><rect ${box}${corner}/></clipPath>`);
      inside = `<g clip-path="url(#c${ids})">${inside}</g>`;
    }
    parts.push(inside);
    if (even) {
      // A CSS border is inside its box; an SVG stroke straddles its path.
      const w = node.borders[0].w;
      const inset = w / 2;
      parts.push(
        `<rect x="${round(node.x + inset)}" y="${round(node.y + inset)}" width="${round(Math.max(0, node.w - w))}" height="${round(Math.max(0, node.h - w))}"${rx > 0 || ry > 0 ? ` rx="${round(Math.max(0, rx - inset))}" ry="${round(Math.max(0, ry - inset))}"` : ''} fill="none"${paintAttrs('stroke', node.borders[0].color)} stroke-width="${round(w)}"${filter}/>`,
      );
    } else {
      const [top, right, bottom, left] = node.borders;
      const side = (b: PaintedBorder, x1: number, y1: number, x2: number, y2: number) =>
        b.w > 0 && svgColor(b.color)
          ? `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}"${paintAttrs('stroke', b.color)} stroke-width="${round(b.w)}"/>`
          : '';
      const { x, y, w, h } = node;
      parts.push(
        side(top, x, y + top.w / 2, x + w, y + top.w / 2),
        side(bottom, x, y + h - bottom.w / 2, x + w, y + h - bottom.w / 2),
        side(left, x + left.w / 2, y, x + left.w / 2, y + h),
        side(right, x + w - right.w / 2, y, x + w - right.w / 2, y + h),
      );
    }
    const body = parts.join('');
    if (!body) return '';
    return node.opacity < 1 ? `<g opacity="${round(node.opacity)}">${body}</g>` : body;
  };
  const body = draw(root);
  const width = round(root.w);
  const height = round(root.h);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${round(root.x)} ${round(root.y)} ${width} ${height}">`,
    options.title ? `<title>${escapeXml(options.title)}</title>` : '',
    defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '',
    body,
    '</svg>',
    '',
  ]
    .filter((line, i, all) => line !== '' || i === all.length - 1)
    .join('\n');
}
