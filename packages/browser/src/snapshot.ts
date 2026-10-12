import type { AXNode, AXValue } from './cdp';

/**
 * Numbers for the elements a clank can act on, such as `[12]`. A number stays with its element
 * for as long as the page lives, so a ref from one read still works after the next. A new page
 * starts again from 1.
 */
export class RefTable {
  private readonly byNode = new Map<number, number>();
  private readonly byRef = new Map<number, number>();
  private next = 1;

  ref(backendNodeId: number): number {
    let ref = this.byNode.get(backendNodeId);
    if (ref === undefined) {
      ref = this.next++;
      this.byNode.set(backendNodeId, ref);
      this.byRef.set(ref, backendNodeId);
    }
    return ref;
  }

  /** The DOM node a ref stands for, if it was ever handed out on this page. */
  node(ref: number): number | undefined {
    return this.byRef.get(ref);
  }

  reset(): void {
    this.byNode.clear();
    this.byRef.clear();
    this.next = 1;
  }
}

/** Roles a clank can click, type into or pick from. They get a ref. */
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem',
  'listbox',
  'MenuListOption',
  'DisclosureTriangle',
  'ToggleButton',
  'PopUpButton',
]);

/** Roles that start a block of their own: a line, or lines, in the snapshot. */
const BLOCKS = new Set([
  'paragraph',
  'article',
  'region',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'form',
  'search',
  'list',
  'table',
  'grid',
  'rowgroup',
  'blockquote',
  'figure',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'group',
  'DescriptionList',
  'term',
  'definition',
  'Section',
  'Pre',
  'Details',
  'Figcaption',
  'caption',
  'Legend',
  'tabpanel',
  'menu',
  'menubar',
  'toolbar',
  'tablist',
  'tree',
  'radiogroup',
  'feed',
  'log',
  'note',
  'math',
]);

/** Roles whose text a clank never needs: decoration, or already in the parent's name. */
const SKIPPED = new Set(['InlineTextBox', 'ListMarker', 'LineBreak']);

const CELLS = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);

/** Blocks of running text: elements inside them stay in the sentence, as a person reads it. */
const TEXT_BLOCKS = new Set([
  'paragraph',
  'heading',
  'listitem',
  'LabelText',
  'caption',
  'Figcaption',
  'Legend',
  'term',
  'definition',
  ...CELLS,
]);

/** Roles shown with a friendlier word. */
const ROLE_LABELS: Record<string, string> = {
  MenuListOption: 'option',
  DisclosureTriangle: 'button',
  ToggleButton: 'button',
  PopUpButton: 'button',
  searchbox: 'search box',
  textbox: 'text box',
  combobox: 'combo box',
  spinbutton: 'number box',
  listbox: 'list box',
  menuitem: 'menu item',
  menuitemcheckbox: 'menu item',
  menuitemradio: 'menu item',
  treeitem: 'tree item',
  generic: 'clickable',
};

const MAX_NAME = 120;
const MAX_VALUE = 100;
const MAX_URL = 100;
const MAX_OPTIONS = 15;

function text(value: AXValue | undefined): string {
  const raw = value?.value;
  const plain =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'number' || typeof raw === 'boolean'
        ? String(raw)
        : '';
  return plain.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function quoted(value: string, max: number): string {
  return `"${truncate(value, max).replace(/"/g, '\\"')}"`;
}

function property(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

/** A link's address as a clank needs it: a path on the same site, the full address elsewhere. */
export function shortUrl(url: string, base: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, base || undefined);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  let origin = '';
  try {
    origin = new URL(base).origin;
  } catch {
    // No base: show the whole address.
  }
  const shown =
    parsed.origin === origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.href;
  return truncate(shown, MAX_URL);
}

/** Lines being written: whole blocks, and the inline pieces of the one in progress. */
class Writer {
  readonly lines: string[] = [];
  private pieces: string[] = [];
  private prefix = '';

  add(piece: string): void {
    if (piece) this.pieces.push(piece);
  }

  /** Inline pieces waiting for the block to end. */
  get pending(): number {
    return this.pieces.length;
  }

  /** Starts the current block's line with this, such as `## ` or `- `. */
  startWith(prefix: string): void {
    this.flush();
    this.prefix = prefix;
  }

  flush(): void {
    if (this.pieces.length > 0) {
      const line = this.pieces
        .join(' ')
        .replace(/\s+([,.;:!?)\]])/g, '$1')
        .replace(/([([])\s+/g, '$1')
        .trim();
      if (line) this.lines.push(`${this.prefix}${line}`);
    }
    this.pieces = [];
    this.prefix = '';
  }

  /** The inline text written so far in this block, for a row's cells. */
  takeInline(): string {
    const inline = this.pieces.join(' ').trim();
    this.pieces = [];
    return inline;
  }
}

/**
 * A page's accessibility tree as text a small model can read: headings, paragraphs, lists and
 * tables as lines, with every element it can act on numbered, such as `[12] button "Book now"`.
 */
export function formatSnapshot(
  nodes: AXNode[],
  refs: RefTable,
  options: { url: string } = { url: '' },
): string[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => !node.parentId) ?? nodes[0];
  if (!root) return [];
  const out = new Writer();

  const children = (node: AXNode) =>
    (node.childIds ?? []).map((id) => byId.get(id)).filter((n): n is AXNode => n !== undefined);

  /** Option labels under a combo box or list box, for picking with browser_type. */
  const options_ = (node: AXNode): string[] => {
    const found: string[] = [];
    const walk = (n: AXNode) => {
      for (const child of children(n)) {
        const role = text(child.role);
        if (role === 'option' || role === 'MenuListOption') {
          const label = text(child.name);
          if (label) found.push(label);
        } else walk(child);
      }
    };
    walk(node);
    return found;
  };

  const element = (node: AXNode, role: string, name: string): string => {
    const label = ROLE_LABELS[role] ?? role;
    const ref = node.backendDOMNodeId !== undefined ? refs.ref(node.backendDOMNodeId) : null;
    let line = `${ref !== null ? `[${ref}] ` : ''}${label}${name ? ` ${quoted(name, MAX_NAME)}` : ''}`;
    if (role === 'link') {
      const url = property(node, 'url');
      const short = typeof url === 'string' ? shortUrl(url, options.url) : null;
      if (short) line += ` (${short})`;
    }
    const value = text(node.value);
    if (
      value &&
      value !== name &&
      ['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'PopUpButton'].includes(role)
    ) {
      line += ` value=${quoted(value, MAX_VALUE)}`;
    }
    const states: string[] = [];
    const checked = property(node, 'checked');
    if (checked !== undefined) {
      if (role === 'switch') states.push(checked === 'true' ? 'on' : 'off');
      else
        states.push(checked === 'true' ? 'checked' : checked === 'mixed' ? 'mixed' : 'not checked');
    }
    const pressed = property(node, 'pressed');
    if (pressed === 'true' || pressed === true) states.push('pressed');
    const expanded = property(node, 'expanded');
    if (expanded === true) states.push('expanded');
    if (expanded === false) states.push('collapsed');
    if (property(node, 'selected') === true) states.push('selected');
    if (property(node, 'disabled') === true) states.push('disabled');
    if (property(node, 'required') === true) states.push('required');
    const invalid = property(node, 'invalid');
    if (invalid && invalid !== 'false') states.push('invalid');
    if (property(node, 'focused') === true) states.push('focused');
    if (states.length > 0) line += ` (${states.join(', ')})`;
    if (role === 'combobox' || role === 'listbox' || role === 'PopUpButton') {
      const choices = options_(node);
      if (choices.length > 0) {
        const shown = choices.slice(0, MAX_OPTIONS).map((c) => truncate(c, 40));
        line += ` options: ${shown.join(' | ')}${choices.length > MAX_OPTIONS ? ` | … ${choices.length - MAX_OPTIONS} more` : ''}`;
      }
    }
    return line;
  };

  const renderChildren = (node: AXNode, inText: boolean) => {
    for (const child of children(node)) render(child, inText);
  };

  /**
   * Adds something that stands on its own, such as a button or an image: inside running text it
   * stays in the sentence; anywhere else it gets a line of its own.
   */
  const item = (piece: string, inText: boolean) => {
    if (inText) {
      out.add(piece);
      return;
    }
    out.flush();
    out.add(piece);
    out.flush();
  };

  const render = (node: AXNode, inText: boolean): void => {
    if (node.ignored) {
      renderChildren(node, inText);
      return;
    }
    const role = text(node.role);
    const name = text(node.name);
    if (SKIPPED.has(role)) {
      if (role === 'LineBreak') out.flush();
      return;
    }
    if (role === 'StaticText') {
      out.add(name);
      return;
    }
    if (role === 'image' || role === 'img' || role === 'Canvas' || role === 'graphics-document') {
      if (name) item(`[image: ${truncate(name, MAX_NAME)}]`, inText);
      return;
    }
    if (role === 'Iframe' || role === 'IframePresentational') {
      item(`[frame${name ? ` ${quoted(name, 60)}` : ''}: not read]`, inText);
      return;
    }
    const focusable = property(node, 'focusable') === true;
    const clickableGeneric = role === 'generic' && focusable && name !== '';
    if (INTERACTIVE.has(role) || clickableGeneric) {
      item(element(node, role, name), inText);
      return;
    }
    if (role === 'heading') {
      const level = Number(property(node, 'level') ?? 2);
      out.startWith(`${'#'.repeat(Math.min(6, Math.max(1, level)))} `);
      const before = out.lines.length;
      renderChildren(node, true);
      // A heading named by aria-label has no text of its own.
      if (out.pending === 0 && out.lines.length === before && name) out.add(name);
      out.flush();
      return;
    }
    if (role === 'listitem') {
      out.startWith('- ');
      renderChildren(node, true);
      out.flush();
      return;
    }
    if (role === 'row') {
      out.flush();
      const cells: string[] = [];
      for (const child of children(node)) {
        render(child, true);
        const cell = out.takeInline();
        if (cell) cells.push(cell);
      }
      if (cells.length > 0) {
        out.add(cells.join(' | '));
        out.flush();
      }
      return;
    }
    if (role === 'separator') {
      item('---', false);
      return;
    }
    if (TEXT_BLOCKS.has(role)) {
      if (!inText) out.flush();
      renderChildren(node, true);
      if (!inText) out.flush();
      return;
    }
    if (BLOCKS.has(role)) {
      out.flush();
      renderChildren(node, false);
      out.flush();
      return;
    }
    renderChildren(node, inText);
  };

  if (text(root.role) === 'RootWebArea' || root.ignored) renderChildren(root, false);
  else render(root, false);
  out.flush();
  return out.lines;
}
