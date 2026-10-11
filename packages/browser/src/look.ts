/** A colour a page uses, and how much of its kind it accounts for, from 0 to 1. */
export interface LookColour {
  hex: string;
  share: number;
}

/** A colour that carries the brand: saturated, and on the things people act on. */
export interface LookAccent extends LookColour {
  /** Where it's used, most first: buttons, links, text, backgrounds, borders, logo. */
  uses: string[];
}

export interface LookFont {
  family: string;
  /** The page loaded it, so it isn't just whatever the visitor's computer has. */
  web: boolean;
  /** Where it's used, most first: headings, body, buttons, code. */
  roles: string[];
}

/** How one kind of text is set. */
export interface LookType {
  /** `h1`, `h2`, `h3` or `body`. */
  tag: string;
  family: string;
  size: number;
  weight: number;
  /** As a multiple of the size. Null when the page leaves it to the browser. */
  lineHeight: number | null;
  colour: string;
  /** A few of its words, to recognise it by. */
  sample: string;
}

export interface LookButton {
  text: string;
  background: string | null;
  colour: string;
  /** Such as `1px #2a2b30`. Null without one. */
  border: string | null;
  radius: string;
  padding: string;
  /** Family, weight and size, such as `Manrope 600 16px`. */
  font: string;
}

/** A picture on the page a design might use. */
export interface LookImage {
  kind: 'logo' | 'icon' | 'card' | 'image';
  /** Where it is or what it's for, such as "in the header" or "social card". */
  note: string;
  /** Its address. Null for a drawing that's part of the page itself. */
  url: string | null;
  /** The drawing as an SVG document that stands on its own, when it's part of the page. */
  svg: string | null;
  width: number;
  height: number;
}

/** How a page looks, as the browser drew it: what a designer would note down to match it. */
export interface PageLook {
  url: string;
  title: string;
  /** What the site calls itself. */
  name: string;
  description: string;
  dark: boolean;
  background: string;
  text: string;
  backgrounds: LookColour[];
  texts: LookColour[];
  accents: LookAccent[];
  borders: LookColour[];
  gradients: string[];
  fonts: LookFont[];
  type: LookType[];
  buttons: LookButton[];
  /** Boxes that hold content: cards, panels. Null when the page has none to speak of. */
  cards: { radius: string; border: string | null; shadow: string | null } | null;
  images: LookImage[];
}

/**
 * Reads the page's look off what the browser computed, so it holds for any stylesheet or
 * framework: every visible element's colours and type, weighed by how much of the page they
 * cover. Colours come back as hex whatever the page wrote them in.
 */
export const PAGE_LOOK = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const pen = canvas.getContext('2d', { willReadFrequently: true });
  const seen = new Map();
  const rgba = (value) => {
    if (!value || value === 'transparent' || value === 'none') return null;
    if (seen.has(value)) return seen.get(value);
    let out = null;
    try {
      pen.clearRect(0, 0, 1, 1);
      pen.fillStyle = value;
      pen.fillRect(0, 0, 1, 1);
      const d = pen.getImageData(0, 0, 1, 1).data;
      if (d[3] > 0) out = [d[0], d[1], d[2], d[3] / 255];
    } catch (e) {}
    seen.set(value, out);
    return out;
  };
  const hex = (c) => '#' + [c[0], c[1], c[2]].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
  const over = (c, base) => c[3] >= 0.99 ? c : [0, 1, 2].map((i) => c[i] * c[3] + base[i] * (1 - c[3])).concat(1);
  const light = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const vivid = (c) => {
    const max = Math.max(c[0], c[1], c[2]) / 255;
    const min = Math.min(c[0], c[1], c[2]) / 255;
    const l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    return s >= 0.3 && l > 0.12 && l < 0.92;
  };
  const family = (value) => (value.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
  const px = (value) => Math.round(parseFloat(value) * 10) / 10 || 0;
  const add = (map, key, amount) => map.set(key, (map.get(key) || 0) + amount);
  const top = (map, n) => {
    const all = [...map.entries()].sort((a, b) => b[1] - a[1]);
    const total = all.reduce((sum, e) => sum + e[1], 0) || 1;
    return all.slice(0, n).map((e) => ({ hex: e[0], share: Math.round((e[1] / total) * 100) / 100 }));
  };
  const most = (map) => ([...map.entries()].sort((a, b) => b[1] - a[1])[0] || [null])[0];
  const words = (text, n) => (text || '').replace(/\\s+/g, ' ').trim().slice(0, n);

  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const page = rgba(getComputedStyle(document.body).backgroundColor) ||
    rgba(getComputedStyle(document.documentElement).backgroundColor) || [255, 255, 255, 1];
  const pageHex = hex(page);

  const backgrounds = new Map();
  const texts = new Map();
  const borders = new Map();
  const accents = new Map();
  const gradients = new Map();
  const fonts = new Map();
  const bodyType = new Map();
  const buttonRadius = new Map();
  const cardRadius = new Map();
  const cardBorder = new Map();
  const cardShadow = new Map();
  const buttons = [];
  const accent = (c, use, amount) => {
    if (!vivid(c)) return;
    const key = hex(c);
    const entry = accents.get(key) || { score: 0, uses: new Map() };
    entry.score += amount;
    add(entry.uses, use, amount);
    accents.set(key, entry);
  };
  const pressable = 'button, [role="button"], input[type="submit"], input[type="button"], a[class*="btn" i], a[class*="button" i]';

  const all = document.body.querySelectorAll('*');
  for (let i = 0; i < all.length && i < 6000; i++) {
    const el = all[i];
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
    if (el.closest('svg') && tag !== 'svg') continue;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const area = Math.min(box.width, vw) * Math.min(box.height, vh);
    const isButton = el.matches(pressable);

    const bg = rgba(cs.backgroundColor);
    const fill = bg && bg[3] >= 0.04 ? over(bg, page) : null;
    if (fill) {
      add(backgrounds, hex(fill), area);
      accent(fill, isButton ? 'buttons' : 'backgrounds', isButton ? 40 : Math.min(20, area / (vw * vh) * 40));
    }
    if (cs.backgroundImage && cs.backgroundImage.indexOf('gradient(') !== -1) {
      add(gradients, cs.backgroundImage.slice(0, 220), area);
    }
    const edge = cs.borderTopStyle !== 'none' && px(cs.borderTopWidth) > 0 ? rgba(cs.borderTopColor) : null;
    if (edge) {
      add(borders, hex(over(edge, page)), 1);
      accent(over(edge, page), 'borders', 2);
    }

    let own = 0;
    for (const node of el.childNodes) {
      if (node.nodeType === 3) own += node.textContent.trim().length;
    }
    if (own > 0 && tag !== 'svg') {
      const colour = rgba(cs.color);
      const name = family(cs.fontFamily);
      const role = el.closest('h1, h2, h3, h4, h5, h6') ? 'headings'
        : el.closest(pressable) ? 'buttons'
        : el.closest('code, pre, kbd, samp') ? 'code'
        : 'body';
      if (colour) {
        add(texts, hex(over(colour, page)), own);
        accent(over(colour, page), el.closest('a') && role !== 'buttons' ? 'links' : 'text', Math.min(15, own / 8));
      }
      if (name) {
        const entry = fonts.get(name) || { chars: 0, roles: new Map() };
        entry.chars += own;
        add(entry.roles, role, own);
        fonts.set(name, entry);
      }
      if (role === 'body' && own >= 40) {
        const lh = parseFloat(cs.lineHeight);
        add(bodyType, [name, px(cs.fontSize), cs.fontWeight, lh ? Math.round((lh / parseFloat(cs.fontSize)) * 100) / 100 : '', colour ? hex(over(colour, page)) : ''].join('|'), own);
      }
    }

    if (isButton && box.width >= 40 && box.height >= 20) {
      add(buttonRadius, cs.borderTopLeftRadius, 1);
      const label = words(el.innerText || el.value, 40);
      const colour = rgba(cs.color);
      const key = [fill ? hex(fill) : '', edge ? hex(over(edge, page)) : ''].join('|');
      if (label && (fill || edge) && buttons.length < 4 && !buttons.some((b) => b.key === key)) {
        buttons.push({
          key,
          text: label,
          background: fill ? hex(fill) : null,
          colour: colour ? hex(over(colour, fill || page)) : '',
          border: edge ? px(cs.borderTopWidth) + 'px ' + hex(over(edge, page)) : null,
          radius: cs.borderTopLeftRadius,
          padding: cs.paddingTop + ' ' + cs.paddingRight,
          font: family(cs.fontFamily) + ' ' + cs.fontWeight + ' ' + cs.fontSize,
        });
      }
    } else if (!isButton && box.width >= 200 && box.height >= 90 && box.width < vw * 0.96 && ((fill && hex(fill) !== pageHex) || edge)) {
      add(cardRadius, cs.borderTopLeftRadius, 1);
      add(cardBorder, edge ? px(cs.borderTopWidth) + 'px ' + hex(over(edge, page)) : 'none', 1);
      add(cardShadow, cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 120), 1);
    }
  }

  const loaded = new Set();
  try {
    for (const face of document.fonts) {
      if (face.status === 'loaded') loaded.add(family(face.family).toLowerCase());
    }
  } catch (e) {}
  const fontList = [...fonts.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 5).map((e) => ({
    family: e[0],
    web: loaded.has(e[0].toLowerCase()),
    roles: [...e[1].roles.entries()].sort((a, b) => b[1] - a[1]).map((r) => r[0]),
  }));

  const type = [];
  for (const tag of ['h1', 'h2', 'h3']) {
    const el = [...document.querySelectorAll(tag)].find((h) => h.getBoundingClientRect().height > 0 && words(h.innerText, 10));
    if (!el) continue;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight);
    const colour = rgba(cs.color);
    type.push({
      tag,
      family: family(cs.fontFamily),
      size: px(cs.fontSize),
      weight: Number(cs.fontWeight) || 400,
      lineHeight: lh ? Math.round((lh / parseFloat(cs.fontSize)) * 100) / 100 : null,
      colour: colour ? hex(over(colour, page)) : '',
      sample: words(el.innerText, 60),
    });
  }
  const body = most(bodyType);
  if (body) {
    const parts = body.split('|');
    type.push({ tag: 'body', family: parts[0], size: Number(parts[1]), weight: Number(parts[2]) || 400, lineHeight: parts[3] ? Number(parts[3]) : null, colour: parts[4], sample: '' });
  }

  const absolute = (url) => {
    try { return new URL(url, document.baseURI).href; } catch (e) { return null; }
  };
  const images = [];
  const taken = new Set();
  const take = (image) => {
    const key = image.url || image.svg;
    if (!key || taken.has(key) || images.length >= 14) return;
    taken.add(key);
    images.push(image);
  };
  const drawing = (svg) => {
    const box = svg.getBoundingClientRect();
    const copy = svg.cloneNode(true);
    const from = [svg, ...svg.querySelectorAll('*')];
    const to = [copy, ...copy.querySelectorAll('*')];
    if (from.length > 600) return null;
    for (let i = 0; i < from.length; i++) {
      const cs = getComputedStyle(from[i]);
      for (const prop of ['fill', 'stroke']) {
        const value = cs[prop];
        if (!value) continue;
        const c = value === 'none' ? null : rgba(value);
        if (value === 'none') to[i].setAttribute(prop, 'none');
        else if (c) to[i].setAttribute(prop, hex(c));
      }
      to[i].removeAttribute('class');
      to[i].removeAttribute('style');
    }
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!copy.getAttribute('viewBox')) copy.setAttribute('viewBox', '0 0 ' + Math.round(box.width) + ' ' + Math.round(box.height));
    copy.setAttribute('width', String(Math.round(box.width)));
    copy.setAttribute('height', String(Math.round(box.height)));
    const text = new XMLSerializer().serializeToString(copy);
    return text.length <= 200000 ? text : null;
  };
  // A logo's own colours: on a page that's otherwise grey, they are the brand's.
  const inks = (el) => {
    const found = new Map();
    try {
      if (el.tagName.toLowerCase() === 'svg') {
        for (const node of el.querySelectorAll('*')) {
          const c = rgba(getComputedStyle(node).fill);
          if (c && c[3] > 0.5) add(found, hex(c), 1);
        }
      } else {
        const side = 48;
        const sheet = document.createElement('canvas');
        sheet.width = sheet.height = side;
        const ink = sheet.getContext('2d');
        ink.drawImage(el, 0, 0, side, side);
        const data = ink.getImageData(0, 0, side, side).data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] >= 200) add(found, hex([data[i], data[i + 1], data[i + 2]]), 1);
        }
      }
    } catch (e) {}
    const total = [...found.values()].reduce((sum, n) => sum + n, 0) || 1;
    for (const entry of [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      const c = rgba(entry[0]);
      if (c && entry[1] / total >= 0.04) accent(c, 'logo', 30 * (entry[1] / total));
    }
  };
  const picture = (el, kind, note) => {
    const box = el.getBoundingClientRect();
    if (box.width < 8 || box.height < 8) return;
    if (kind === 'logo') inks(el);
    if (el.tagName.toLowerCase() === 'svg') {
      const svg = drawing(el);
      if (svg) take({ kind, note: note + ', drawn in the page', url: null, svg, width: Math.round(box.width), height: Math.round(box.height) });
    } else {
      const url = absolute(el.currentSrc || el.src || '');
      if (!url) return;
      take({ kind, note: el.alt ? note + ', "' + words(el.alt, 50) + '"' : note, url: url.indexOf('data:') === 0 ? url.slice(0, 400000) : url, svg: null, width: Math.round(el.naturalWidth || box.width), height: Math.round(el.naturalHeight || box.height) });
    }
  };
  const marks = '[class*="logo" i] img, [class*="logo" i] svg, img[class*="logo" i], svg[class*="logo" i], img[alt*="logo" i], img[src*="logo" i], [class*="brand" i] > img, [class*="brand" i] > svg';
  const home = 'a[href="/"] img, a[href="/"] svg, a[href="' + location.origin + '/"] img, a[href="' + location.origin + '/"] svg';
  const header = document.querySelector('header, [role="banner"], nav');
  const notIcon = (el) => !el.closest('button') && !el.matches('[data-icon], [class*="icon" i], [class*="fa-"], [class*="lucide"]');
  for (const el of [...(header ? header.querySelectorAll(marks + ', ' + home) : []), ...(header ? [...header.querySelectorAll('img, svg')].filter(notIcon).slice(0, 2) : [])]) {
    if (images.filter((i) => i.kind === 'logo').length < 3) picture(el, 'logo', 'in the header');
  }
  for (const el of document.querySelectorAll(marks)) {
    if (images.filter((i) => i.kind === 'logo').length < 4 && notIcon(el)) picture(el, 'logo', 'on the page');
  }
  for (const link of document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')) {
    const url = absolute(link.getAttribute('href') || '');
    if (url && images.filter((i) => i.kind === 'icon').length < 2) {
      take({ kind: 'icon', note: 'the site icon' + (link.getAttribute('sizes') ? ', ' + link.getAttribute('sizes') : ''), url, svg: null, width: 0, height: 0 });
    }
  }
  const meta = (query) => {
    const el = document.querySelector(query);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };
  const card = absolute(meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'));
  if (card) take({ kind: 'card', note: 'the picture shown when the site is shared', url: card, svg: null, width: Number(meta('meta[property="og:image:width"]')) || 0, height: Number(meta('meta[property="og:image:height"]')) || 0 });
  for (const img of document.querySelectorAll('img')) {
    const box = img.getBoundingClientRect();
    if (box.width >= 240 && box.height >= 120 && images.filter((i) => i.kind === 'image').length < 6) picture(img, 'image', 'on the page');
  }

  const homeLink = header ? header.querySelector('a[href="/"], a[href="' + location.origin + '/"]') : null;
  const cards = cardRadius.size > 0 ? {
    radius: most(cardRadius),
    border: most(cardBorder) === 'none' ? null : most(cardBorder),
    shadow: most(cardShadow) === 'none' ? null : most(cardShadow),
  } : null;
  return {
    url: location.href,
    title: document.title,
    name: meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]') || words(homeLink ? homeLink.innerText.split('\\n')[0] : '', 40),
    description: words(meta('meta[name="description"]') || meta('meta[property="og:description"]'), 300),
    dark: light(page) < 0.4,
    background: pageHex,
    text: (top(texts, 1)[0] || { hex: '' }).hex,
    backgrounds: top(backgrounds, 6),
    texts: top(texts, 5),
    accents: [...accents.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 5).map((e) => ({
      hex: e[0],
      share: Math.round(e[1].score),
      uses: [...e[1].uses.entries()].sort((a, b) => b[1] - a[1]).map((u) => u[0]),
    })),
    borders: top(borders, 3),
    gradients: [...gradients.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0]),
    fonts: fontList,
    type,
    buttons: buttons.map((b) => ({ text: b.text, background: b.background, colour: b.colour, border: b.border, radius: b.radius, padding: b.padding, font: b.font })),
    cards,
    images,
  };
})()`;

/**
 * The pictures on the page that didn't load, by what they're of and where they point. A page read
 * as text shows a picture by its description whether it loaded or not, so a clank building or
 * checking a page would never know.
 */
export const BROKEN_IMAGES = `(() => [...document.images]
  .filter((img) => img.complete && img.naturalWidth === 0 && (img.getAttribute('src') || img.currentSrc))
  .slice(0, 12)
  .map((img) => ({ alt: (img.alt || '').slice(0, 60), src: (img.getAttribute('src') || img.currentSrc || '').slice(0, 160) })))()`;

/** The line a page's text opens with when pictures on it didn't load. Null when they all did. */
export function brokenImagesText(broken: unknown): string | null {
  if (!Array.isArray(broken) || broken.length === 0) return null;
  const named = (broken as { alt?: string; src?: string }[]).map((img) =>
    img.alt ? `"${img.alt}" (${img.src ?? ''})` : (img.src ?? ''),
  );
  return `${broken.length === 1 ? "A picture on this page didn't load" : `${broken.length} pictures on this page didn't load`}: ${named.join(', ')}.`;
}

/** A page's look as a clank reads it. Pictures are numbered, for saving one into the project. */
export function lookText(look: PageLook): string {
  const lines: string[] = [];
  const head = [look.name || look.title, look.url].filter(Boolean).join(', ');
  lines.push(`How ${head} looks, as the browser drew it.`);
  if (look.description) lines.push(look.description);
  lines.push(
    '',
    `Theme: ${look.dark ? 'dark' : 'light'}. Page background ${look.background}${look.text ? `, main text ${look.text}` : ''}.`,
  );

  if (look.fonts.length > 0) {
    lines.push('', 'Fonts');
    for (const font of look.fonts) {
      const set = look.type
        .filter((t) => t.family === font.family)
        .map(
          (t) =>
            `${t.tag} ${t.size}px/${t.weight}${t.lineHeight ? `, line height ${t.lineHeight}` : ''}`,
        );
      lines.push(
        `- ${font.family}${font.web ? ' (a web font the page loads)' : ''}: ${font.roles.join(', ')}${set.length > 0 ? `. ${set.join('; ')}` : ''}`,
      );
    }
  }

  const hexes = (colours: LookColour[]) => colours.map((c) => c.hex).join(', ');
  lines.push('', 'Colours, most used first');
  if (look.backgrounds.length > 0) lines.push(`- Backgrounds: ${hexes(look.backgrounds)}`);
  if (look.texts.length > 0) lines.push(`- Text: ${hexes(look.texts)}`);
  if (look.accents.length > 0) {
    lines.push(
      `- Accents: ${look.accents.map((a) => `${a.hex} (${a.uses.slice(0, 2).join(', ')})`).join(', ')}`,
    );
  }
  if (look.borders.length > 0) lines.push(`- Borders: ${hexes(look.borders)}`);
  for (const gradient of look.gradients) lines.push(`- Gradient: ${gradient}`);

  if (look.buttons.length > 0) {
    lines.push('', 'Buttons');
    for (const b of look.buttons) {
      lines.push(
        `- "${b.text}": ${b.background ? `background ${b.background}` : 'no background'}, text ${b.colour}${b.border ? `, border ${b.border}` : ''}, radius ${b.radius}, padding ${b.padding}, ${b.font}`,
      );
    }
  }
  if (look.cards) {
    lines.push(
      '',
      `Cards and panels: radius ${look.cards.radius}, ${look.cards.border ? `border ${look.cards.border}` : 'no border'}, ${look.cards.shadow ? `shadow ${look.cards.shadow}` : 'no shadow'}.`,
    );
  }

  if (look.images.length > 0) {
    lines.push('', 'Logo and pictures. Save one into the project with browser_save_image.');
    look.images.forEach((image, i) => {
      const size = image.width && image.height ? `, ${image.width}×${image.height}` : '';
      const where = image.url
        ? image.url.startsWith('data:')
          ? 'embedded in the page'
          : image.url
        : 'an SVG';
      lines.push(`[${i + 1}] ${image.kind} ${image.note}${size}: ${where}`);
    });
  } else {
    lines.push('', 'No logo or pictures were found on the page.');
  }
  return lines.join('\n');
}
