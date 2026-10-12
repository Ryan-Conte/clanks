import { type Op, OpError } from './ops';
import type { ComponentProp, Design, Node } from './schema';
import { Ids, findComponent, holderId, locate, walk } from './tree';

/** A name for a component's property from the layer it fills: `title` for "Card title". */
function propName(node: Node, taken: string[], only: boolean): string {
  if (only && !taken.includes('text')) return 'text';
  const words = node.name
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  const base =
    words.length > 0 && /^[A-Za-z]/.test(words[0]!)
      ? words
          .map((w, i) =>
            i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
          )
          .join('')
      : 'text';
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}${i}`;
  return name;
}

export interface MadeComponent {
  ops: Op[];
  /** The component the layer became, or the one it's now a variant of. */
  component: { id: string; name: string };
  variant: string;
  /** The instance left where the layer was. */
  instance: string;
  /** Every property the component has now. */
  props: ComponentProp[];
  /** Whether the component was there already, and this added a variant to it. */
  added: boolean;
}

/**
 * The changes that turn a layer into a component and leave an instance in its place. Its text
 * layers become properties, so each instance can say something else. With the name of a component
 * that exists, the layer becomes another variant of it. Throws an `OpError` when it can't be done.
 */
export function makeComponent(
  design: Design,
  nodeId: string,
  name: string,
  variant?: string,
): MadeComponent {
  const located = locate(design, nodeId);
  if (!located) throw new OpError(`There's no layer ${nodeId}.`);
  const { node } = located;
  if (node.type === 'instance') {
    throw new OpError(`[${node.id}] is already an instance of a component.`);
  }
  const parent = holderId(located);
  if (!parent) throw new OpError(`[${node.id}] is already the root of ${located.component!.name}.`);
  if (!name.trim()) throw new OpError('A component needs a name.');
  const existing = findComponent(design, name);
  const variantName =
    variant?.trim() || (existing ? `variant-${existing.variants.length + 1}` : 'default');
  if (existing?.variants.some((v) => v.name === variantName)) {
    throw new OpError(
      `${existing.name} already has a variant "${variantName}". Its variants: ${existing.variants.map((v) => v.name).join(', ')}. Give another name.`,
    );
  }
  const ids = new Ids(design);
  const props: ComponentProp[] = existing ? [...existing.props] : [];
  const texts = [...walk(node)].filter((n) => n.type === 'text');
  const bindings = new Map<string, string>();
  let fresh = false;
  for (const text of texts) {
    if (text.type !== 'text') continue;
    let prop = text.bind ?? propName(text, [...bindings.values()], texts.length === 1);
    const textProps = props.filter((p) => p.type === 'text');
    // Another variant's only text fills the component's only text property.
    if (existing && texts.length === 1 && textProps.length === 1) prop = textProps[0]!.name;
    if (!props.some((p) => p.name === prop)) {
      props.push({ name: prop, type: 'text', default: text.text });
      fresh = true;
    }
    bindings.set(text.id, prop);
  }
  const bind = (n: Node): Node => {
    if (n.type === 'frame') return { ...n, children: n.children.map(bind) };
    const prop = bindings.get(n.id);
    return prop && n.type === 'text' ? { ...n, bind: prop } : n;
  };
  // Where it sits belongs to the instance; what it is belongs to the component.
  const { x, y, absolute, ...root } = bind(node);
  const componentId = existing?.id ?? ids.component();
  const instance: Node = {
    id: ids.node(),
    type: 'instance',
    name: node.name,
    component: componentId,
    variant: variantName,
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(absolute ? { absolute } : {}),
  };
  const link = design.links.find((l) => l.from === node.id);
  const ops: Op[] = [{ op: 'remove', id: node.id }];
  if (existing) {
    if (fresh) ops.push({ op: 'component.update', id: existing.id, set: { props } });
    ops.push({
      op: 'variant.add',
      component: existing.id,
      variant: { name: variantName, root: root },
    });
  } else {
    ops.push({
      op: 'component.add',
      component: {
        id: componentId,
        name: name.trim(),
        props,
        variants: [{ name: variantName, root: root }],
      },
    });
  }
  ops.push({ op: 'insert', parent, index: located.index, node: instance });
  if (link) ops.push({ op: 'link', from: instance.id, to: link.to });
  return {
    ops,
    component: { id: componentId, name: existing?.name ?? name.trim() },
    variant: variantName,
    instance: instance.id,
    props,
    added: existing !== undefined,
  };
}
