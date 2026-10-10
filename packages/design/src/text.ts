import { tokenLines } from './exports';
import { type Component, DEFAULT_NAMES, type Design, type Node, type Page } from './schema';
import type { TokenSet } from './tokens';
import { childrenOf, findNode, walk } from './tree';

/** A value as markup writes it: a bare number or word, a token in braces, or a quoted string. */
function attr(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `"${value.map((v) => String(v)).join(' ')}"`;
  const text = String(value);
  if (/^\{[\w.-]+\}$/.test(text) || /^[\w#.%/-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '&quot;')}"`;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\n/g, '\\n');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The order properties are listed in, so every layer reads the same way. */
const ORDER = [
  'x',
  'y',
  'w',
  'h',
  'absolute',
  'layout',
  'gap',
  'pad',
  'align',
  'justify',
  'wrap',
  'clip',
  'fill',
  'stroke',
  'strokeWidth',
  'radius',
  'shadow',
  'opacity',
  'style',
  'font',
  'size',
  'weight',
  'lineHeight',
  'letterSpacing',
  'color',
  'textAlign',
  'icon',
  'src',
  'alt',
  'fit',
  'vertical',
  'bind',
  'showIf',
  'hidden',
  'locked',
];

const TAG: Record<Node['type'], string> = {
  frame: 'Frame',
  text: 'Text',
  rect: 'Rect',
  ellipse: 'Ellipse',
  line: 'Line',
  image: 'Image',
  vector: 'Vector',
  icon: 'Icon',
  instance: 'Instance',
};

/**
 * One layer on one line: its id, its type, its name and its properties, written as markup
 * attributes so they can be copied straight into `design_create` or `design_update`.
 */
export function nodeLine(node: Node, design: Design, maxText = 160): string {
  const parts = [`[${node.id}]`, TAG[node.type]];
  const auto =
    node.name === DEFAULT_NAMES[node.type] ||
    (node.type === 'text' && node.text.startsWith(node.name.replace(/…$/, ''))) ||
    (node.type === 'icon' && node.name === node.icon);
  if (!auto) parts.push(`"${clip(node.name, 60)}"`);
  if (node.type === 'instance') {
    const component = design.components.find((c) => c.id === node.component);
    parts.push(`of=${attr(component?.name ?? `${node.component} (missing)`)}`);
    if (node.variant) parts.push(`variant=${attr(node.variant)}`);
    for (const [name, value] of Object.entries(node.props ?? {})) {
      parts.push(`${name}=${typeof value === 'string' ? `"${clip(value, 80)}"` : String(value)}`);
    }
  }
  const record = node as unknown as Record<string, unknown>;
  for (const key of ORDER) {
    const value = record[key];
    if (value === undefined || value === false) continue;
    parts.push(value === true ? key : `${key}=${attr(value)}`);
  }
  const link = design.links.find((l) => l.from === node.id);
  if (link) {
    const target = findNode(design, link.to);
    parts.push(`→ links to "${target?.name ?? link.to}"`);
  }
  let line = parts.join(' ');
  if (node.type === 'text') line += `: "${clip(node.text, maxText)}"`;
  if (node.type === 'vector') line += ` (svg, ${node.svg.length} characters)`;
  return line;
}

/**
 * Layers as an indented tree, one per line. Below `depth` levels a frame only says how much is
 * inside it, so a big file reads in parts.
 */
export function treeText(nodes: Node[], design: Design, depth: number, indent = ''): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${indent}${nodeLine(node, design)}`);
    const children = childrenOf(node);
    if (children.length === 0) continue;
    if (depth <= 1) {
      const count = [...walk(node)].length - 1;
      lines.push(
        `${indent}  … ${count} ${count === 1 ? 'layer' : 'layers'} inside. Read them with node: "${node.id}".`,
      );
    } else {
      lines.push(...treeText(children, design, depth - 1, `${indent}  `));
    }
  }
  return lines;
}

/** A component in a few lines: its variants and properties, and what each variant is made of. */
export function componentText(component: Component, design: Design, depth: number): string[] {
  const props = component.props.map(
    (p) => `${p.name} (${p.type}, default ${JSON.stringify(p.default)})`,
  );
  const lines = [
    `Component ${component.name} (${component.id})${component.description ? `: ${component.description}` : ''}`,
    `  Properties: ${props.length > 0 ? props.join(', ') : 'none'}`,
  ];
  for (const variant of component.variants) {
    lines.push(`  Variant ${variant.name}:`);
    lines.push(...treeText([variant.root], design, depth, '    '));
  }
  return lines;
}

/** How many tokens each group has: `color 18, space 8, type 6`. */
export function tokenGroups(tokens: TokenSet): string {
  const counts = new Map<string, number>();
  for (const token of tokens.tokens) {
    const group = token.path.split('.')[0]!;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts].map(([group, count]) => `${group} ${count}`).join(', ');
}

/** Every token with its values, one per line. */
export function tokensText(tokens: TokenSet): string {
  if (tokens.tokens.length === 0)
    return 'There are no tokens yet. Create them with design_tokens_set.';
  return [
    `${tokens.tokens.length} tokens. Modes: ${tokens.modes.join(', ')} (${tokens.modes[0]} is the default).`,
    '',
    ...tokenLines(tokens),
  ].join('\n');
}

export function pageText(page: Page, design: Design, depth: number): string[] {
  const lines = [`Page "${page.name}" (${page.id})`];
  if (page.children.length === 0) lines.push('  (empty)');
  else lines.push(...treeText(page.children, design, depth, '  '));
  return lines;
}

/** A whole design file as text: its pages, its components and a count of its tokens. */
export function designText(file: string, design: Design, tokens: TokenSet, depth: number): string {
  const lines = [
    `${file}: ${design.pages.length} ${design.pages.length === 1 ? 'page' : 'pages'}, ${design.components.length} ${design.components.length === 1 ? 'component' : 'components'}, ${tokens.tokens.length} tokens${tokens.tokens.length > 0 ? ` (${tokenGroups(tokens)})` : ''}.`,
    '',
  ];
  for (const page of design.pages) lines.push(...pageText(page, design, depth), '');
  if (design.components.length > 0) {
    lines.push('Components:');
    for (const component of design.components) {
      const props = component.props.map((p) => p.name).join(', ');
      lines.push(
        `  ${component.name} (${component.id}): variants ${component.variants.map((v) => v.name).join(', ')}${props ? `; properties ${props}` : ''}`,
      );
    }
    lines.push('');
  }
  lines.push(
    'Layers are listed as [id] Type "name" and their properties. Read one in full with node, a component with its name, and the tokens with tokens: true.',
  );
  return lines.join('\n');
}

/** The components a set of layers uses, however deep, in the design's order. */
export function componentsUsed(nodes: Node[], design: Design): Component[] {
  const used = new Set<string>();
  const visit = (node: Node) => {
    for (const inner of walk(node)) {
      if (inner.type !== 'instance' || used.has(inner.component)) continue;
      used.add(inner.component);
      const component = design.components.find((c) => c.id === inner.component);
      for (const variant of component?.variants ?? []) visit(variant.root);
    }
  };
  nodes.forEach(visit);
  return design.components.filter((c) => used.has(c.id));
}

/** Cuts lines to a budget of characters, saying how to read what was left out. */
export function fitText(lines: string[], maxChars: number, more: string): string {
  let size = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (size + line.length + 1 > maxChars && kept.length > 0) {
      kept.push(`… ${lines.length - kept.length} more lines. ${more}`);
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join('\n');
}
