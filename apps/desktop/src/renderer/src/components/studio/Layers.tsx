import { type Design, Ids, type Node, type Op, locate, walk } from '@clanks/design';
import { type DragEvent, type ReactNode, useState } from 'react';
import { type DesignStore, type View, viewRoots } from '../../lib/studio';
import { Input, Mini, Section } from './fields';

const GLYPHS: Record<Node['type'], string> = {
  frame: '▢',
  text: 'T',
  rect: '■',
  ellipse: '●',
  line: '─',
  image: '▨',
  vector: '◇',
  icon: '✦',
  instance: '◈',
};

/** Where a dragged layer would go, relative to the row it's over. */
type Drop = { id: string; at: 'before' | 'inside' | 'after' };

/**
 * The design's pages and components, and the layers of the one on the canvas as a tree: select,
 * rename, hide and lock them, and drag them to reorder or to move them into another frame.
 */
export function Layers(props: {
  design: Design;
  view: View;
  setView: (view: View) => void;
  selection: string[];
  setSelection: (ids: string[]) => void;
  store: DesignStore;
  editable: boolean;
}) {
  const { design, view, selection, store, editable } = props;
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const roots = viewRoots(design, view);

  const addPage = () => {
    const ids = new Ids(design);
    const page = { id: ids.page(), name: `Page ${design.pages.length + 1}`, children: [] };
    if (store.apply([{ op: 'page.add', page }])) props.setView({ kind: 'page', id: page.id });
  };

  const onDrop = (event: DragEvent, target: Drop) => {
    event.preventDefault();
    setDrop(null);
    const id = event.dataTransfer.getData('application/x-clanks-layer');
    const dragged = id ? locate(design, id) : null;
    const over = locate(design, target.id);
    if (!dragged || !over || id === target.id) return;
    if ([...walk(dragged.node)].some((n) => n.id === target.id)) return;
    let parent: string | null;
    let index: number;
    if (target.at === 'inside' && over.node.type === 'frame') {
      parent = over.node.id;
      index = over.node.children.filter((c) => c.id !== id).length;
    } else {
      const holder = over.holder;
      parent =
        holder.kind === 'page' ? holder.page.id : holder.kind === 'frame' ? holder.node.id : null;
      const siblings =
        holder.kind === 'page'
          ? holder.page.children
          : holder.kind === 'frame'
            ? holder.node.children
            : [];
      // Its place counts the layers as they'll be once it's taken out of where it was.
      const without = siblings.filter((c) => c.id !== id);
      index = without.findIndex((c) => c.id === target.id) + (target.at === 'after' ? 1 : 0);
    }
    if (!parent) return;
    const ops: Op[] = [{ op: 'move', id, parent, index }];
    store.apply(ops);
  };

  const row = (node: Node, depth: number, inInstance = false): ReactNode => {
    const children = node.type === 'frame' ? node.children : [];
    const open = !closed.has(node.id);
    const selected = selection.includes(node.id);
    const marker = drop?.id === node.id ? drop.at : null;
    return (
      <li key={node.id}>
        <div
          draggable={editable && !inInstance && renaming !== node.id}
          onDragStart={(event) => {
            event.dataTransfer.setData('application/x-clanks-layer', node.id);
            event.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(event) => {
            if (!editable) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const part = (event.clientY - rect.top) / rect.height;
            const at =
              node.type === 'frame' && part > 0.3 && part < 0.7
                ? 'inside'
                : part < 0.5
                  ? 'before'
                  : 'after';
            if (drop?.id !== node.id || drop.at !== at) setDrop({ id: node.id, at });
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={(event) => onDrop(event, drop ?? { id: node.id, at: 'after' })}
          onClick={(event) => {
            if (event.shiftKey) {
              props.setSelection(
                selected ? selection.filter((id) => id !== node.id) : [...selection, node.id],
              );
            } else props.setSelection([node.id]);
          }}
          onDoubleClick={() => editable && setRenaming(node.id)}
          className={`group relative flex h-7 cursor-default items-center gap-1.5 pr-2 text-[12px] ${selected ? 'bg-accent/20 text-white' : 'text-white/80 hover:bg-white/[0.05]'} ${marker === 'inside' ? 'ring-1 ring-accent-2 ring-inset' : ''} ${node.hidden ? 'opacity-45' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {marker && marker !== 'inside' && (
            <span
              className={`absolute right-0 left-0 h-0.5 bg-accent-2 ${marker === 'before' ? 'top-0' : 'bottom-0'}`}
            />
          )}
          {children.length > 0 ? (
            <button
              type="button"
              aria-label={open ? 'Collapse' : 'Expand'}
              className="w-3 shrink-0 text-[9px] text-dim hover:text-white"
              onClick={(event) => {
                event.stopPropagation();
                setClosed((c) => {
                  const next = new Set(c);
                  if (open) next.add(node.id);
                  else next.delete(node.id);
                  return next;
                });
              }}
            >
              {open ? '▾' : '▸'}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span
            className={`w-3.5 shrink-0 text-center text-[11px] ${node.type === 'instance' ? 'text-accent' : 'text-dim'}`}
          >
            {GLYPHS[node.type]}
          </span>
          {renaming === node.id ? (
            <input
              autoFocus
              defaultValue={node.name}
              className="h-5 min-w-0 flex-1 rounded border border-accent/60 bg-black/50 px-1 text-[12px] text-white outline-none"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') setRenaming(null);
              }}
              onBlur={(event) => {
                const name = event.target.value.trim();
                setRenaming(null);
                if (name && name !== node.name) {
                  store.apply([{ op: 'update', id: node.id, set: { name } }]);
                }
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          )}
          {node.locked && <span className="text-[10px] text-dim">▣</span>}
          {design.links.some((l) => l.from === node.id) && (
            <span className="text-[10px] text-accent-2" title="Links to a frame">
              →
            </span>
          )}
        </div>
        {open && children.length > 0 && (
          <ul>{children.map((child) => row(child, depth + 1, inInstance))}</ul>
        )}
      </li>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Section
        title="Pages"
        actions={
          editable && (
            <Mini title="Add a page" onClick={addPage}>
              +
            </Mini>
          )
        }
      >
        <ul className="-mx-1 flex flex-col">
          {design.pages.map((page) => {
            const current = view.kind === 'page' && view.id === page.id;
            return (
              <li key={page.id} className="group flex items-center gap-1">
                {renaming === page.id ? (
                  <Input
                    value={page.name}
                    onCommit={(name) => {
                      setRenaming(null);
                      if (name) store.apply([{ op: 'page.update', id: page.id, name }]);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    aria-current={current ? 'page' : undefined}
                    onClick={() => props.setView({ kind: 'page', id: page.id })}
                    onDoubleClick={() => editable && setRenaming(page.id)}
                    className={`h-7 min-w-0 flex-1 truncate rounded-md px-2 text-left text-[12px] ${current ? 'bg-white/[0.08] text-white' : 'text-white/75 hover:bg-white/[0.05]'}`}
                  >
                    {page.name}
                    <span className="ml-1.5 text-[10px] text-dim">{page.children.length}</span>
                  </button>
                )}
                {editable && design.pages.length > 1 && (
                  <span className="opacity-0 group-hover:opacity-100">
                    <Mini
                      title={`Delete ${page.name}`}
                      onClick={() => {
                        if (store.apply([{ op: 'page.remove', id: page.id }]) && current) {
                          const next = design.pages.find((p) => p.id !== page.id)!;
                          props.setView({ kind: 'page', id: next.id });
                        }
                      }}
                    >
                      ×
                    </Mini>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </Section>
      {design.components.length > 0 && (
        <Section title="Components">
          <ul className="-mx-1 flex flex-col">
            {design.components.map((component) => {
              const current = view.kind === 'component' && view.id === component.id;
              return (
                <li key={component.id}>
                  <button
                    type="button"
                    aria-current={current ? 'page' : undefined}
                    onClick={() => props.setView({ kind: 'component', id: component.id })}
                    className={`flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] ${current ? 'bg-white/[0.08] text-white' : 'text-white/75 hover:bg-white/[0.05]'}`}
                  >
                    <span className="text-accent">◈</span>
                    <span className="min-w-0 flex-1 truncate">{component.name}</span>
                    <span className="text-[10px] text-dim">{component.variants.length}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      <div className="flex h-9 shrink-0 items-center px-3">
        <h3 className="text-[11px] font-medium tracking-[0.12em] text-dim uppercase">Layers</h3>
      </div>
      <ul data-testid="studio-layers" className="min-h-0 flex-1 overflow-y-auto pb-4">
        {roots.length === 0 && <li className="px-3 text-[12px] text-dim">Nothing here yet.</li>}
        {roots.map(({ node }) => row(node, 0))}
      </ul>
    </div>
  );
}
