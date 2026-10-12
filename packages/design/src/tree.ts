import type { Component, Design, FrameNode, Node, Page, Variant } from './schema';

/** A layer's children: a frame's, or none. */
export function childrenOf(node: Node): Node[] {
  return node.type === 'frame' ? node.children : [];
}

/** A layer and everything inside it, parents before children. */
export function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of childrenOf(node)) yield* walk(child);
}

/** Every layer in a design: on its pages, then in its components. */
export function* allNodes(design: Design): Generator<Node> {
  for (const page of design.pages) for (const node of page.children) yield* walk(node);
  for (const component of design.components) {
    for (const variant of component.variants) yield* walk(variant.root);
  }
}

/** What holds a layer: a page, a frame, or a component's variant, whose root it is. */
export type Holder =
  | { kind: 'page'; page: Page }
  | { kind: 'frame'; node: FrameNode }
  | { kind: 'variant'; component: Component; variant: Variant };

export interface Located {
  node: Node;
  holder: Holder;
  /** Its place among its holder's children. 0 for a variant's root. */
  index: number;
  /** The frames it's inside, outermost first. */
  ancestors: FrameNode[];
  /** The page it's on, or the component and variant it belongs to. */
  page: Page | null;
  component: Component | null;
  variant: Variant | null;
}

/** Finds a layer by id, with where it is. */
export function locate(design: Design, id: string): Located | null {
  const search = (
    nodes: Node[],
    holder: Holder,
    ancestors: FrameNode[],
    where: Pick<Located, 'page' | 'component' | 'variant'>,
  ): Located | null => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (node.id === id) return { node, holder, index, ancestors, ...where };
      if (node.type === 'frame') {
        const found = search(node.children, { kind: 'frame', node }, [...ancestors, node], where);
        if (found) return found;
      }
    }
    return null;
  };
  for (const page of design.pages) {
    const found = search(page.children, { kind: 'page', page }, [], {
      page,
      component: null,
      variant: null,
    });
    if (found) return found;
  }
  for (const component of design.components) {
    for (const variant of component.variants) {
      const found = search([variant.root], { kind: 'variant', component, variant }, [], {
        page: null,
        component,
        variant,
      });
      if (found) return found;
    }
  }
  return null;
}

export function findNode(design: Design, id: string): Node | null {
  return locate(design, id)?.node ?? null;
}

/** The children of a page or a frame, by its id. Null when it's neither. */
export function childrenIn(design: Design, containerId: string): Node[] | null {
  const page = design.pages.find((p) => p.id === containerId);
  if (page) return page.children;
  const node = findNode(design, containerId);
  return node?.type === 'frame' ? node.children : null;
}

/** The id of what holds a layer: a page's or a frame's. Null for a variant's root. */
export function holderId(located: Located): string | null {
  if (located.holder.kind === 'page') return located.holder.page.id;
  if (located.holder.kind === 'frame') return located.holder.node.id;
  return null;
}

/** The outermost layer a layer is in: a top-level frame on a page, or a variant's root. */
export function topOf(located: Located): Node {
  return located.ancestors[0] ?? located.node;
}

/** Every top-level frame on every page: the screens of a design. */
export function topFrames(design: Design): { page: Page; frame: FrameNode }[] {
  return design.pages.flatMap((page) =>
    page.children
      .filter((node): node is FrameNode => node.type === 'frame')
      .map((frame) => ({ page, frame })),
  );
}

export function findComponent(design: Design, idOrName: string): Component | undefined {
  const wanted = idOrName.trim().toLowerCase();
  return (
    design.components.find((c) => c.id === idOrName) ??
    design.components.find((c) => c.name.toLowerCase() === wanted)
  );
}

/** A component's variant by name, or its first when the name is missing or unknown. */
export function findVariant(component: Component, name: string | undefined): Variant {
  return component.variants.find((v) => v.name === name) ?? component.variants[0]!;
}

/** Hands out ids for new layers, pages and components, counting on from the design's own. */
export class Ids {
  private next: number;

  constructor(design: Pick<Design, 'nextId'>) {
    this.next = design.nextId;
  }

  node(): string {
    return `n${this.next++}`;
  }

  page(): string {
    return `p${this.next++}`;
  }

  component(): string {
    return `c${this.next++}`;
  }

  /** The number the next id would get. */
  get counter(): number {
    return this.next;
  }
}

/** The number in an id: 12 for `n12`. 0 when it has none. */
export function idNumber(id: string): number {
  const digits = /(\d+)$/.exec(id)?.[1];
  return digits ? Number(digits) : 0;
}

/** A copy of a layer and everything in it, with new ids. `map` gets each old id's new one. */
export function cloneWithIds(node: Node, ids: Ids, map = new Map<string, string>()): Node {
  const id = ids.node();
  map.set(node.id, id);
  if (node.type === 'frame') {
    return { ...node, id, children: node.children.map((child) => cloneWithIds(child, ids, map)) };
  }
  return { ...node, id };
}

/**
 * Finds a layer the way a person or a model names it: by id (`n12` or `[n12]`), or by name when
 * exactly one layer has it. Returns the matches, so callers can say when a name is ambiguous.
 */
export function nodesNamed(design: Design, ref: string): Node[] {
  const text = ref.trim();
  const id = /^\[?([a-z]\d+)\]?$/i.exec(text)?.[1]?.toLowerCase();
  if (id) {
    const node = findNode(design, id);
    if (node) return [node];
  }
  const wanted = text.replace(/^["']|["']$/g, '').toLowerCase();
  const matches: Node[] = [];
  for (const node of allNodes(design)) {
    if (node.name.toLowerCase() === wanted) matches.push(node);
  }
  return matches;
}

/** Where a layer is, in words: `Home / Desktop › Hero › Headline`. */
export function nodePath(located: Located): string {
  const start = located.component
    ? [`${located.component.name}${located.variant ? ` (${located.variant.name})` : ''}`]
    : [];
  const names = [...located.ancestors.map((a) => a.name), located.node.name];
  // A variant's root is the component itself.
  return [...start, ...(located.component ? names.slice(1) : names)].join(' › ');
}
