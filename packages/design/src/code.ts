import { type RenderNode, cssName, renderNode } from './render';
import type { Component, Design } from './schema';

/** A component as code to start from: a React component and the stylesheet it imports. */
export interface ComponentCode {
  /** The component's name in code, such as `ProductCard`. */
  name: string;
  tsx: string;
  css: string;
}

/** `ProductCard` for "Product card". */
export function codeName(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const joined = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(joined) ? joined : `Component${joined}`;
}

const kebab = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'layer';

/** A property's name as an identifier: `showIcon` stays, "show icon" becomes `showIcon`. */
function identifier(name: string): string {
  const words = name
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const joined = words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join('');
  return /^[A-Za-z_]/.test(joined) ? joined : `prop${joined}`;
}

/** SVG markup's attribute names as JSX writes them: `stroke-width` is `strokeWidth`. */
const jsxAttrs = (markup: string) =>
  markup.replace(
    /\s([a-z]+(?:-[a-z]+)+)=/g,
    (_, name: string) => ` ${name.replace(/-([a-z])/g, (__, c: string) => c.toUpperCase())}=`,
  );

const attr = (text: string) => JSON.stringify(text);

interface Built {
  jsx: string[];
  css: string[];
  /** Other components it's made of. */
  uses: Set<string>;
}

/**
 * A component as a React component and its CSS, one branch per variant: layers become elements
 * with a class each, auto layout becomes flexbox and tokens stay custom properties, so it follows
 * the tokens' CSS export from mode to mode. It's a starting point to wire up, not finished code.
 */
export function componentCode(
  component: Component,
  design: Pick<Design, 'components'>,
): ComponentCode {
  const name = codeName(component.name);
  const block = kebab(component.name);
  const many = component.variants.length > 1;
  const props = component.props.map((p) => ({ ...p, id: identifier(p.name) }));
  // Every layer a boolean property can hide is drawn, so it's in the code to switch.
  const shown = Object.fromEntries(
    component.props.map((p) => [p.name, p.type === 'boolean' ? true : p.default]),
  );
  const uses = new Set<string>();

  const build = (variant: Component['variants'][number]): Built | null => {
    const { x: _x, y: _y, absolute: _absolute, ...root } = variant.root;
    const drawn = renderNode(
      root,
      'col',
      { design },
      {
        prefix: '',
        instance: null,
        props: shown,
        depth: 0,
      },
    );
    if (!drawn) return null;
    const modifier = many ? `${block}--${kebab(variant.name)}` : '';
    const scope = modifier ? `.${modifier} ` : '';
    const taken = new Set<string>();
    const css: string[] = [];
    const rule = (selector: string, style: Record<string, string>) => {
      const lines = Object.entries(style).map(([key, value]) => `  ${cssName(key)}: ${value};`);
      if (lines.length > 0) css.push(`${selector} {\n${lines.join('\n')}\n}`);
    };
    const element = (render: RenderNode, depth: number, top: boolean): string[] => {
      const pad = '  '.repeat(depth);
      const node = render.node;
      const wrap = (lines: string[]): string[] => {
        const prop = node.showIf ? props.find((p) => p.name === node.showIf) : undefined;
        if (!prop || top) return lines;
        return [`${pad}{${prop.id} && (`, ...lines.map((l) => `  ${l}`), `${pad})}`];
      };
      if (!top && node.type === 'instance') {
        const other = design.components.find((c) => c.id === node.component);
        if (other) {
          const otherName = codeName(other.name);
          if (otherName !== name) uses.add(otherName);
          const given = Object.entries(node.props ?? {})
            .map(([key, value]) =>
              typeof value === 'boolean'
                ? ` ${identifier(key)}={${String(value)}}`
                : ` ${identifier(key)}=${attr(value)}`,
            )
            .join('');
          const picked =
            node.variant && other.variants.length > 1 ? ` variant=${attr(node.variant)}` : '';
          return wrap([`${pad}<${otherName}${picked}${given} />`]);
        }
      }
      let cls = top ? block : `${block}__${kebab(node.name)}`;
      if (!top) {
        const base = cls;
        for (let i = 2; taken.has(cls); i++) cls = `${base}-${i}`;
        taken.add(cls);
      }
      const style = { ...render.style };
      if (top) {
        delete style.left;
        delete style.top;
        style.position = 'relative';
      }
      rule(top ? (modifier ? `.${block}.${modifier}` : `.${block}`) : `${scope}.${cls}`, style);
      const className = top && modifier ? `${block} ${modifier}` : cls;
      if (render.tag === 'img') {
        const src = node.type === 'image' && node.src ? node.src : '';
        const alt = node.type === 'image' ? (node.alt ?? '') : node.name;
        return wrap([
          `${pad}<img className=${attr(className)} src=${attr(src)} alt=${attr(alt)} />${src ? '' : ' {/* TODO: the image */}'}`,
        ]);
      }
      if (render.tag === 'svg') {
        return wrap([
          `${pad}<svg className=${attr(className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">`,
          `${pad}  ${jsxAttrs(render.inner ?? '')}`,
          `${pad}</svg>`,
        ]);
      }
      if (render.text !== undefined) {
        const bound =
          node.type === 'text' && node.bind ? props.find((p) => p.name === node.bind) : undefined;
        const content = bound ? `{${bound.id}}` : `{${JSON.stringify(render.text)}}`;
        return wrap([`${pad}<div className=${attr(className)}>${content}</div>`]);
      }
      if (render.children.length === 0) return wrap([`${pad}<div className=${attr(className)} />`]);
      return wrap([
        `${pad}<div className=${attr(className)}>`,
        ...render.children.flatMap((child) => element(child, depth + 1, false)),
        `${pad}</div>`,
      ]);
    };
    return { jsx: element(drawn, 0, true), css, uses };
  };

  const built = component.variants
    .map((variant) => ({ variant, code: build(variant) }))
    .filter((b): b is { variant: Component['variants'][number]; code: Built } => b.code !== null);
  const first = built[0];
  const variantType = built.map((b) => JSON.stringify(b.variant.name)).join(' | ');
  const fields = [
    ...(many ? [`  variant?: ${variantType};`] : []),
    ...props.map((p) => `  ${p.id}?: ${p.type === 'boolean' ? 'boolean' : 'string'};`),
  ];
  const defaults = [
    ...(many && first ? [`variant = ${JSON.stringify(first.variant.name)}`] : []),
    ...props.map((p) => `${p.id} = ${JSON.stringify(p.default)}`),
  ];
  const indent = (lines: string[], by: number) => lines.map((l) => `${'  '.repeat(by)}${l}`);
  const branches: string[] = [];
  for (const { variant, code } of built.slice(1)) {
    branches.push(
      `  if (variant === ${JSON.stringify(variant.name)}) {`,
      '    return (',
      ...indent(code.jsx, 3),
      '    );',
      '  }',
    );
  }
  const body = first
    ? [...branches, '  return (', ...indent(first.code.jsx, 2), '  );']
    : ['  return null;'];
  const signature = fields.length > 0 ? `{ ${defaults.join(', ')} }: ${name}Props` : '';
  const tsx = [
    `import './${name}.css';`,
    ...[...uses].sort().map((other) => `import { ${other} } from './${other}';`),
    '',
    ...(fields.length > 0 ? [`export interface ${name}Props {`, ...fields, '}', ''] : []),
    '/**',
    ` * ${component.name}, from the design${component.description ? `: ${component.description.replace(/\*\//g, '* /')}` : '.'}`,
    ' * A starting point made by clanks Studio: wire up what it does, and keep the tokens.',
    ' */',
    `export function ${name}(${signature}) {`,
    ...body,
    '}',
    '',
  ].join('\n');
  const css = [
    `/* ${component.name}, from the design. Values in var(--…) are design tokens: load the tokens' CSS export with it. */`,
    ...built.flatMap((b) => b.code.css),
    '',
  ].join('\n\n');
  return { name, tsx, css: css.replace(/\n\n$/, '\n') };
}
