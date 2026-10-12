import {
  ALIGNS,
  FONTS,
  JUSTIFIES,
  type Located,
  MarkupError,
  type Node,
  type Op,
  PROP_TOKEN_TYPES,
  type Studio,
  iconNames,
  isRef,
  locate,
  renderNode,
  resolveColor,
  styleText,
  topFrames,
  updateProps,
} from '@clanks/design';
import type { DesignSnapshot } from '@clanks/orchestrator';
import { useMemo, useState } from 'react';
import { type DesignStore, placementOf } from '../../lib/studio';
import { Button } from '../ui';
import { Check, Input, Mini, Row, Section, Segments, Select, fieldClass } from './fields';

/** A property's value as it's typed: `16`, `{space.4}`, `8 16 8 16`. */
function shown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(' ');
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Properties whose values should be tokens, which lint says when they aren't. */
const TOKEN_PROPS = new Set(['fill', 'stroke', 'color', 'gap', 'pad', 'radius', 'shadow', 'style']);

const ICONS = iconNames();

const ALIGN_LABELS = { start: 'Start', center: 'Mid', end: 'End', stretch: 'Fill' };
const JUSTIFY_LABELS = { start: 'Start', center: 'Mid', end: 'End', between: 'Apart' };

/**
 * What the selected layer is: its place and size, its layout, how it looks, its text, and what
 * clicking it does in the prototype. Every value takes a token, written in braces.
 */
export function Properties(props: {
  state: Studio;
  snapshot: DesignSnapshot;
  selection: string[];
  store: DesignStore;
  editable: boolean;
  mode: string;
  /** A layer's drawn size, read from the canvas. */
  measure: (id: string) => { x: number; y: number; w: number; h: number } | null;
  onOpenComponent: (id: string) => void;
  onMakeComponent: (id: string) => void;
}) {
  const { state, selection, store, editable } = props;
  const { design, tokens } = state;
  const located = selection.map((id) => locate(design, id)).filter((l) => l !== null);
  const [inspect, setInspect] = useState(false);
  const lists = useMemo(() => {
    const byType = new Map<string, string[]>();
    for (const token of tokens.tokens) {
      byType.set(token.type, [...(byType.get(token.type) ?? []), `{${token.path}}`]);
    }
    return byType;
  }, [tokens]);

  if (located.length === 0) {
    return (
      <p className="p-4 text-[12px] leading-relaxed text-dim">
        Select a layer to see what it is. Press F for a frame, R for a rectangle, O for an ellipse,
        L for a line, T for text. Values take tokens in braces, such as{' '}
        <span className="font-mono text-white/70">{'{color.brand}'}</span>.
      </p>
    );
  }

  const set = (node: Node, values: Record<string, unknown>) => {
    try {
      const update = updateProps(node, values, design);
      if (Object.keys(update).length > 0) store.apply([{ op: 'update', id: node.id, set: update }]);
    } catch (error) {
      // What was typed doesn't fit the property: nothing changes, and the reason shows.
      if (!(error instanceof MarkupError)) throw error;
      store.report(error.message);
    }
  };

  if (located.length > 1) {
    return (
      <Arrange located={located} measure={props.measure} apply={store.apply} editable={editable} />
    );
  }

  const { node } = located[0]!;
  const place = placementOf(located[0]!);
  const record = node as unknown as Record<string, unknown>;
  const field = (prop: string, label: string, placeholder = '', short = false) => {
    const value = record[prop];
    const types = PROP_TOKEN_TYPES[prop];
    const raw =
      TOKEN_PROPS.has(prop) &&
      value !== undefined &&
      !(Array.isArray(value)
        ? value.every((v) => isRef(v) || v === 0)
        : isRef(value) || value === 0);
    const colour =
      types?.[0] === 'color' && typeof value === 'string'
        ? resolveColor(tokens, value, props.mode)
        : null;
    return (
      <Row label={label} short={short}>
        {colour && (
          <span
            className="size-4 shrink-0 rounded border border-white/20"
            style={{ background: colour }}
          />
        )}
        <Input
          label={label}
          value={shown(value)}
          placeholder={placeholder}
          disabled={!editable}
          mono
          {...(prop === 'w' || prop === 'h'
            ? { list: 'studio-sizes' }
            : types
              ? { list: `studio-tokens-${types[0]}` }
              : {})}
          onCommit={(text) => set(node, { [prop]: text === '' ? null : text })}
        />
        {raw && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-amber-300"
            title="Not a token. Lint flags values that aren't tokens."
          />
        )}
      </Row>
    );
  };

  const link = design.links.find((l) => l.from === node.id);
  const frames = topFrames(design);
  const component =
    node.type === 'instance' ? design.components.find((c) => c.id === node.component) : undefined;
  const owner = located[0]!.component;

  return (
    <div className="flex flex-col">
      {['color', 'dimension', 'typography', 'fontFamily', 'fontWeight', 'shadow', 'number'].map(
        (type) => (
          <datalist key={type} id={`studio-tokens-${type}`}>
            {[
              ...(lists.get(type) ?? []),
              ...(type === 'dimension' ? (lists.get('number') ?? []) : []),
            ].map((ref) => (
              <option key={ref} value={ref} />
            ))}
          </datalist>
        ),
      )}
      <datalist id="studio-sizes">
        <option value="hug" label="Fit what it holds" />
        <option value="fill" label="Take the room left in its frame" />
        {[...(lists.get('dimension') ?? []), ...(lists.get('number') ?? [])].map((ref) => (
          <option key={ref} value={ref} />
        ))}
      </datalist>
      <Section
        title={node.type === 'instance' ? 'Instance' : node.type}
        actions={
          <span className="flex items-center gap-0.5">
            <Mini
              title={node.hidden ? 'Show' : 'Hide'}
              active={node.hidden === true}
              disabled={!editable}
              onClick={() => set(node, { hidden: !node.hidden })}
            >
              {node.hidden ? '◌' : '●'}
            </Mini>
            <Mini
              title={node.locked ? 'Unlock' : 'Lock'}
              active={node.locked === true}
              disabled={!editable}
              onClick={() => set(node, { locked: !node.locked })}
            >
              {node.locked ? '▣' : '▢'}
            </Mini>
            <span className="pl-1 font-mono text-[10px] text-dim">{node.id}</span>
          </span>
        }
      >
        {field('name', 'Name')}
      </Section>

      <Section title="Place and size">
        {place === 'free' && (
          <div className="grid grid-cols-2 gap-2">
            {field('x', 'X', '0', true)}
            {field('y', 'Y', '0', true)}
          </div>
        )}
        {node.type !== 'icon' && (
          <div className="grid grid-cols-2 gap-2">
            {field('w', 'W', 'hug', true)}
            {field('h', 'H', 'hug', true)}
          </div>
        )}
        {located[0]!.holder.kind === 'frame' &&
          (located[0]!.holder.node.layout ?? 'none') !== 'none' && (
            <Check
              checked={node.absolute === true}
              disabled={!editable}
              onChange={(absolute) => set(node, { absolute })}
            >
              Out of the auto layout, placed by X and Y
            </Check>
          )}
      </Section>

      {node.type === 'frame' && (
        <Section title="Auto layout">
          <Row label="Direction">
            <Segments
              value={node.layout ?? 'none'}
              disabled={!editable}
              options={[
                ['none', 'None'],
                ['row', 'Row'],
                ['col', 'Column'],
              ]}
              onChange={(layout) => set(node, { layout })}
            />
          </Row>
          {(node.layout ?? 'none') !== 'none' && (
            <>
              {field('gap', 'Gap', '0')}
              {field('pad', 'Padding', '0')}
              <Row label="Align">
                <Segments
                  value={node.align ?? 'start'}
                  disabled={!editable}
                  options={ALIGNS.map((a) => [a, ALIGN_LABELS[a], `Across: ${a}`] as const)}
                  onChange={(align) => set(node, { align })}
                />
              </Row>
              <Row label="Justify">
                <Segments
                  value={node.justify ?? 'start'}
                  disabled={!editable}
                  options={JUSTIFIES.map((j) => [j, JUSTIFY_LABELS[j], `Along: ${j}`] as const)}
                  onChange={(justify) => set(node, { justify })}
                />
              </Row>
              <Check
                checked={node.wrap === true}
                disabled={!editable}
                onChange={(wrap) => set(node, { wrap })}
              >
                Wrap onto more lines
              </Check>
            </>
          )}
          <Check
            checked={node.clip === true}
            disabled={!editable}
            onChange={(clip) => set(node, { clip })}
          >
            Clip what goes past its edges
          </Check>
        </Section>
      )}

      {node.type === 'text' && (
        <Section title="Text">
          {node.bind ? (
            <p className="text-[12px] text-dim">
              Filled by the property <span className="font-mono text-white/80">{node.bind}</span>.
              Its default is the text below.
            </p>
          ) : null}
          <textarea
            key={node.text}
            defaultValue={node.text}
            disabled={!editable}
            rows={3}
            aria-label="Text"
            className={`${fieldClass} h-auto resize-y py-1.5 leading-snug`}
            onKeyDown={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (event.target.value !== node.text) set(node, { text: event.target.value });
            }}
          />
          {field('style', 'Style', '{type.body}')}
          {field('color', 'Colour')}
          <Row label="Align">
            <Segments
              value={node.textAlign ?? 'left'}
              disabled={!editable}
              options={[
                ['left', 'Left'],
                ['center', 'Centre'],
                ['right', 'Right'],
              ]}
              onChange={(textAlign) => set(node, { textAlign })}
            />
          </Row>
          <details className="text-[12px]">
            <summary className="cursor-pointer text-dim hover:text-white">
              Set by hand, over the style
            </summary>
            <div className="flex flex-col gap-2 pt-2">
              <Row label="Font">
                <Select
                  value={node.font ?? ''}
                  disabled={!editable}
                  options={[
                    ['', 'From the style'],
                    ...FONTS.map((f) => [f.family, f.family] as const),
                    ...(node.font && !FONTS.some((f) => f.family === node.font)
                      ? [[node.font, node.font] as const]
                      : []),
                  ]}
                  onChange={(font) => set(node, { font: font || null })}
                />
              </Row>
              {field('size', 'Size')}
              {field('weight', 'Weight')}
              {field('lineHeight', 'Line height')}
              {field('letterSpacing', 'Spacing')}
            </div>
          </details>
        </Section>
      )}

      {node.type === 'icon' && (
        <Section title="Icon">
          <datalist id="studio-icons">
            {ICONS.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <Row label="Icon">
            <Input
              value={node.icon}
              list="studio-icons"
              disabled={!editable}
              mono
              onCommit={(icon) => icon && set(node, { icon })}
            />
          </Row>
          {field('color', 'Colour')}
          {field('size', 'Size', '24')}
        </Section>
      )}

      {node.type === 'image' && (
        <Section title="Image">
          <Row label="File">
            <Select
              value={node.src ?? ''}
              disabled={!editable}
              options={[
                ['', 'Placeholder'],
                ...props.snapshot.assets.map((a) => [a.path, a.name] as const),
                ...(node.src && !props.snapshot.assets.some((a) => a.path === node.src)
                  ? [[node.src, node.src] as const]
                  : []),
              ]}
              onChange={(src) => set(node, { src: src || null })}
            />
          </Row>
          {field('alt', 'Shows')}
          <Row label="Fit">
            <Segments
              value={node.fit ?? 'cover'}
              disabled={!editable}
              options={[
                ['cover', 'Cover'],
                ['contain', 'Contain'],
              ]}
              onChange={(fit) => set(node, { fit })}
            />
          </Row>
          {field('radius', 'Radius')}
        </Section>
      )}

      {node.type === 'instance' && (
        <Section
          title={component ? component.name : 'Missing component'}
          actions={
            component && (
              <Mini title="Edit the component" onClick={() => props.onOpenComponent(component.id)}>
                Edit
              </Mini>
            )
          }
        >
          {component ? (
            <>
              <Row label="Variant">
                <Select
                  value={node.variant ?? component.variants[0]!.name}
                  disabled={!editable}
                  options={component.variants.map((v) => [v.name, v.name] as const)}
                  onChange={(variant) => set(node, { variant })}
                />
              </Row>
              {component.props.map((prop) => (
                <Row key={prop.name} label={prop.name}>
                  {prop.type === 'boolean' ? (
                    <Check
                      checked={(node.props?.[prop.name] ?? prop.default) === true}
                      disabled={!editable}
                      onChange={(value) => set(node, { props: { [prop.name]: value } })}
                    >
                      Shown
                    </Check>
                  ) : (
                    <Input
                      value={String(node.props?.[prop.name] ?? prop.default)}
                      disabled={!editable}
                      onCommit={(value) => set(node, { props: { [prop.name]: value } })}
                    />
                  )}
                </Row>
              ))}
            </>
          ) : (
            <p className="text-[12px] text-rose-300">
              Its component was deleted. Replace it or delete it.
            </p>
          )}
        </Section>
      )}

      {['frame', 'rect', 'ellipse', 'line'].includes(node.type) && (
        <Section title="Look">
          {node.type !== 'line' && field('fill', 'Fill')}
          {field('stroke', 'Stroke')}
          {field('strokeWidth', 'Stroke width', '1')}
          {node.type !== 'line' && node.type !== 'ellipse' && field('radius', 'Radius', '0')}
          {node.type !== 'line' && field('shadow', 'Shadow')}
        </Section>
      )}
      <Section title="Layer">
        {field('opacity', 'Opacity', '1')}
        {owner && node.type === 'text' && (
          <Row label="Property">
            <Select
              value={node.bind ?? ''}
              disabled={!editable}
              options={[
                ['', 'None'],
                ...owner.props
                  .filter((p) => p.type === 'text')
                  .map((p) => [p.name, p.name] as const),
              ]}
              onChange={(bind) => set(node, { bind: bind || null })}
            />
          </Row>
        )}
        {node.type !== 'instance' && located[0]!.holder.kind !== 'variant' && editable && (
          <Button size="sm" onClick={() => props.onMakeComponent(node.id)}>
            Make a component
          </Button>
        )}
      </Section>

      {located[0]!.page && (
        <Section title="Prototype">
          <Row label="On click">
            <Select
              value={link?.to ?? ''}
              disabled={!editable}
              options={[
                ['', 'Nothing'],
                ...frames
                  .filter((f) => f.frame.id !== node.id)
                  .map((f) => [f.frame.id, `Go to ${f.frame.name}`] as const),
              ]}
              onChange={(to) => store.apply([{ op: 'link', from: node.id, to: to || null }])}
            />
          </Row>
        </Section>
      )}

      <Section
        title="Inspect"
        actions={
          <Mini title="Show its CSS" active={inspect} onClick={() => setInspect((s) => !s)}>
            CSS
          </Mini>
        }
      >
        {inspect && <Css node={node} located={located[0]!} state={state} />}
      </Section>
    </div>
  );
}

/** The CSS a layer is drawn with, tokens as custom properties, for building it in code. */
function Css({ node, located, state }: { node: Node; located: Located; state: Studio }) {
  const place = placementOf(located);
  const flow =
    place !== 'flow' || located.holder.kind !== 'frame'
      ? 'free'
      : located.holder.node.layout === 'row'
        ? 'row'
        : 'col';
  const drawn = renderNode(node, flow, { design: state.design });
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-black/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-white/80 select-text">
      {drawn ? styleText(drawn.style, '\n') : 'Hidden'}
    </pre>
  );
}

type Box = { x: number; y: number; w: number; h: number };

/** Several layers at once: line them up, or space them out. */
function Arrange(props: {
  located: Located[];
  measure: (id: string) => Box | null;
  apply: (ops: Op[]) => boolean;
  editable: boolean;
}) {
  const free = props.located.filter((l) => placementOf(l) === 'free');
  const run = (plan: (boxes: { id: string; node: Node; box: Box }[]) => Op[]) => {
    const boxes = free
      .map((l) => ({ id: l.node.id, node: l.node, box: props.measure(l.node.id) }))
      .filter((b): b is { id: string; node: Node; box: Box } => b.box !== null);
    if (boxes.length > 1) props.apply(plan(boxes));
  };
  /** Moves each layer by how far its box is from where it should be. */
  const align = (axis: 'x' | 'y', at: 'start' | 'center' | 'end') =>
    run((boxes) => {
      const size = axis === 'x' ? 'w' : 'h';
      const min = Math.min(...boxes.map((b) => b.box[axis]));
      const max = Math.max(...boxes.map((b) => b.box[axis] + b.box[size]));
      return boxes.map(({ id, node, box }) => {
        const target =
          at === 'start' ? min : at === 'end' ? max - box[size] : (min + max) / 2 - box[size] / 2;
        return {
          op: 'update',
          id,
          set: { [axis]: Math.round((node[axis] ?? 0) + target - box[axis]) },
        };
      });
    });
  const distribute = (axis: 'x' | 'y') =>
    run((boxes) => {
      const size = axis === 'x' ? 'w' : 'h';
      const sorted = [...boxes].sort((a, b) => a.box[axis] - b.box[axis]);
      const first = sorted[0]!.box;
      const last = sorted.at(-1)!.box;
      const total = sorted.reduce((sum, b) => sum + b.box[size], 0);
      const gap = (last[axis] + last[size] - first[axis] - total) / (sorted.length - 1);
      let at = first[axis];
      return sorted.map(({ id, node, box }) => {
        const op: Op = {
          op: 'update',
          id,
          set: { [axis]: Math.round((node[axis] ?? 0) + at - box[axis]) },
        };
        at += box[size] + gap;
        return op;
      });
    });
  const disabled = !props.editable || free.length < 2;
  return (
    <div className="flex flex-col">
      <Section title={`${props.located.length} layers`}>
        <p className="text-[12px] text-dim">
          {free.length < 2
            ? 'Layers in auto layout line up by their frame. Select layers placed by X and Y to arrange them.'
            : 'Line them up, or space them evenly.'}
        </p>
        <div className="grid grid-cols-3 gap-1">
          {(
            [
              ['x', 'start', 'Left'],
              ['x', 'center', 'Centre'],
              ['x', 'end', 'Right'],
              ['y', 'start', 'Top'],
              ['y', 'center', 'Middle'],
              ['y', 'end', 'Bottom'],
            ] as const
          ).map(([axis, at, label]) => (
            <Button key={label} size="sm" disabled={disabled} onClick={() => align(axis, at)}>
              {label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Button size="sm" disabled={disabled || free.length < 3} onClick={() => distribute('x')}>
            Space across
          </Button>
          <Button size="sm" disabled={disabled || free.length < 3} onClick={() => distribute('y')}>
            Space down
          </Button>
        </div>
      </Section>
    </div>
  );
}
