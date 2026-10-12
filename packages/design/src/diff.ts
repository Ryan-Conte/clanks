import type { Studio } from './ops';
import type { Design, Node } from './schema';
import { valueText } from './tokens';
import { type Located, childrenOf, holderId, locate, nodePath, topOf, walk } from './tree';

/** One difference between two versions of a design, down to the property. */
export interface Change {
  kind:
    | 'added'
    | 'removed'
    | 'changed'
    | 'moved'
    | 'reordered'
    | 'token'
    | 'component'
    | 'link'
    | 'page';
  /** The layer, token or component it's about. */
  id: string;
  /** Where it is, in words: `Home / Desktop › Hero › Button`. */
  where: string;
  /** The top-level frame it's in, for showing it on the canvas. */
  frame: string | null;
  prop?: string;
  from?: string;
  to?: string;
}

function show(value: unknown): string {
  if (value === undefined || value === null) return 'none';
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  if (Array.isArray(value)) return value.map((v) => String(v)).join(' ');
  return JSON.stringify(value);
}

function index(design: Design): Map<string, Located> {
  const found = new Map<string, Located>();
  const add = (node: Node) => {
    for (const inner of walk(node)) {
      const located = locate(design, inner.id);
      if (located) found.set(inner.id, located);
    }
  };
  for (const page of design.pages) page.children.forEach(add);
  for (const component of design.components) component.variants.forEach((v) => add(v.root));
  return found;
}

const frameOf = (located: Located) => (located.page ? topOf(located).id : null);

/**
 * What changed between two versions of a design: layers added, removed, moved and restyled,
 * property by property, and tokens, components, pages and prototype links.
 */
export function diffDesigns(before: Studio, after: Studio): Change[] {
  const changes: Change[] = [];
  const was = index(before.design);
  const now = index(after.design);

  for (const [id, located] of now) {
    const old = was.get(id);
    if (!old) {
      // A new frame's layers are new too; saying so once is enough.
      const parent = located.ancestors.at(-1);
      if (parent && !was.has(parent.id)) continue;
      const inside = [...walk(located.node)].length - 1;
      changes.push({
        kind: 'added',
        id,
        where: nodePath(located),
        frame: frameOf(located),
        to: inside > 0 ? `${located.node.type} with ${inside} layers` : located.node.type,
      });
      continue;
    }
    const a = old.node as unknown as Record<string, unknown>;
    const b = located.node as unknown as Record<string, unknown>;
    for (const prop of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (prop === 'children' || prop === 'id' || prop === 'type') continue;
      if (JSON.stringify(a[prop]) === JSON.stringify(b[prop])) continue;
      changes.push({
        kind: 'changed',
        id,
        where: nodePath(located),
        frame: frameOf(located),
        prop,
        from: show(a[prop]),
        to: show(b[prop]),
      });
    }
    if (holderId(old) !== holderId(located)) {
      changes.push({
        kind: 'moved',
        id,
        where: nodePath(located),
        frame: frameOf(located),
        from: nodePath(old).split(' › ').slice(0, -1).join(' › ') || (old.page?.name ?? ''),
        to: nodePath(located).split(' › ').slice(0, -1).join(' › ') || (located.page?.name ?? ''),
      });
    } else {
      // The order of the children it had before and still has.
      const staying = (node: Node, other: Map<string, Located>) =>
        childrenOf(node)
          .map((c) => c.id)
          .filter((child) => {
            const there = other.get(child);
            return there !== undefined && holderId(there) === id;
          })
          .join(',');
      if (staying(old.node, now) !== staying(located.node, was)) {
        changes.push({
          kind: 'reordered',
          id,
          where: nodePath(located),
          frame: frameOf(located),
        });
      }
    }
  }
  for (const [id, located] of was) {
    if (now.has(id)) continue;
    const parent = located.ancestors.at(-1);
    if (parent && !now.has(parent.id)) continue;
    changes.push({ kind: 'removed', id, where: nodePath(located), frame: null });
  }

  for (const page of after.design.pages) {
    const old = before.design.pages.find((p) => p.id === page.id);
    if (!old)
      changes.push({ kind: 'page', id: page.id, where: page.name, frame: null, to: 'added' });
    else if (old.name !== page.name) {
      changes.push({
        kind: 'page',
        id: page.id,
        where: page.name,
        frame: null,
        prop: 'name',
        from: old.name,
        to: page.name,
      });
    }
  }
  for (const page of before.design.pages) {
    if (!after.design.pages.some((p) => p.id === page.id)) {
      changes.push({ kind: 'page', id: page.id, where: page.name, frame: null, to: 'removed' });
    }
  }

  for (const component of after.design.components) {
    const old = before.design.components.find((c) => c.id === component.id);
    if (!old) {
      changes.push({
        kind: 'component',
        id: component.id,
        where: component.name,
        frame: null,
        to: `added, with ${component.variants.map((v) => v.name).join(', ')}`,
      });
      continue;
    }
    if (old.name !== component.name) {
      changes.push({
        kind: 'component',
        id: component.id,
        where: component.name,
        frame: null,
        prop: 'name',
        from: old.name,
        to: component.name,
      });
    }
    const names = (list: { name: string }[]) => list.map((v) => v.name);
    const added = names(component.variants).filter((n) => !names(old.variants).includes(n));
    const removed = names(old.variants).filter((n) => !names(component.variants).includes(n));
    if (added.length)
      changes.push({
        kind: 'component',
        id: component.id,
        where: component.name,
        frame: null,
        prop: 'variants',
        to: `added ${added.join(', ')}`,
      });
    if (removed.length)
      changes.push({
        kind: 'component',
        id: component.id,
        where: component.name,
        frame: null,
        prop: 'variants',
        to: `removed ${removed.join(', ')}`,
      });
    if (JSON.stringify(old.props) !== JSON.stringify(component.props)) {
      changes.push({
        kind: 'component',
        id: component.id,
        where: component.name,
        frame: null,
        prop: 'properties',
        from: names(old.props).join(', ') || 'none',
        to: names(component.props).join(', ') || 'none',
      });
    }
  }
  for (const component of before.design.components) {
    if (!after.design.components.some((c) => c.id === component.id)) {
      changes.push({
        kind: 'component',
        id: component.id,
        where: component.name,
        frame: null,
        to: 'removed',
      });
    }
  }

  const linkKey = (design: Design) => new Map(design.links.map((l) => [l.from, l.to] as const));
  const oldLinks = linkKey(before.design);
  const newLinks = linkKey(after.design);
  for (const [from, to] of newLinks) {
    if (oldLinks.get(from) === to) continue;
    const located = now.get(from);
    const target = now.get(to);
    changes.push({
      kind: 'link',
      id: from,
      where: located ? nodePath(located) : from,
      frame: located ? frameOf(located) : null,
      from: oldLinks.has(from) ? (was.get(oldLinks.get(from)!)?.node.name ?? 'a frame') : 'none',
      to: target?.node.name ?? to,
    });
  }
  for (const [from] of oldLinks) {
    if (newLinks.has(from) || !now.has(from)) continue;
    const located = now.get(from)!;
    changes.push({
      kind: 'link',
      id: from,
      where: nodePath(located),
      frame: frameOf(located),
      from: 'linked',
      to: 'none',
    });
  }

  const modes = [...new Set([...before.tokens.modes, ...after.tokens.modes])];
  for (const token of after.tokens.tokens) {
    const old = before.tokens.tokens.find((t) => t.path === token.path);
    if (!old) {
      changes.push({
        kind: 'token',
        id: token.path,
        where: `{${token.path}}`,
        frame: null,
        from: 'none',
        to: valueText(token.type, token.value),
      });
      continue;
    }
    for (const [i, mode] of modes.entries()) {
      const a = i === 0 ? old.value : old.modes?.[mode];
      const b = i === 0 ? token.value : token.modes?.[mode];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      changes.push({
        kind: 'token',
        id: token.path,
        where: `{${token.path}}`,
        frame: null,
        ...(i === 0 ? {} : { prop: mode }),
        from: a === undefined ? 'follows the default' : valueText(old.type, a),
        to: b === undefined ? 'follows the default' : valueText(token.type, b),
      });
    }
  }
  for (const token of before.tokens.tokens) {
    if (!after.tokens.tokens.some((t) => t.path === token.path)) {
      changes.push({
        kind: 'token',
        id: token.path,
        where: `{${token.path}}`,
        frame: null,
        from: valueText(token.type, token.value),
        to: 'removed',
      });
    }
  }
  return changes;
}

/** A change on one line: `Home › Button fill {color.brand} → {color.brand-strong}`. */
export function changeText(change: Change): string {
  switch (change.kind) {
    case 'added':
      return `${change.where}: added (${change.to ?? 'layer'})`;
    case 'removed':
      return `${change.where}: removed`;
    case 'moved':
      return `${change.where}: moved from ${change.from || 'the page'} to ${change.to || 'the page'}`;
    case 'reordered':
      return `${change.where}: layers reordered`;
    case 'link':
      return `${change.where}: links to ${change.to} (was ${change.from})`;
    case 'page':
    case 'component':
      return change.prop
        ? `${change.where} ${change.prop}: ${change.from ? `${change.from} → ` : ''}${change.to}`
        : `${change.where}: ${change.to}`;
    default:
      return `${change.where} ${change.prop ? `${change.prop} ` : ''}${change.from} → ${change.to}`;
  }
}
