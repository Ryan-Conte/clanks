import {
  type Node,
  type RenderNode,
  type Studio,
  renderFrame,
  renderNode,
  rootStyle,
} from '@clanks/design';
import { type CSSProperties, type ReactElement, memo, useMemo } from 'react';

/** `strokeWidth` for `stroke-width`: React's names for SVG's attributes. */
function reactAttrs(attrs: Record<string, string> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (name === 'draggable') result.draggable = false;
    else result[name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value;
  }
  return result;
}

/**
 * A drawn layer as React elements. Text is a text node and images are `<img>`, so nothing a design
 * holds can run; the only markup set as HTML is a built-in icon's shapes.
 */
function element(render: RenderNode, editing: string | null): ReactElement {
  const common = {
    'data-key': render.key,
    'data-id': render.id,
    style: render.style as CSSProperties,
  };
  if (render.tag === 'img') {
    return <img key={render.key} {...common} {...reactAttrs(render.attrs)} />;
  }
  if (render.tag === 'svg') {
    return (
      <svg
        key={render.key}
        {...common}
        {...reactAttrs(render.attrs)}
        dangerouslySetInnerHTML={{ __html: render.inner ?? '' }}
      />
    );
  }
  if (render.text !== undefined) {
    // The text being edited is the user's until they're done with it.
    if (editing === render.key) {
      return (
        <div
          key={`${render.key}:editing`}
          {...common}
          data-editing="true"
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          style={{ ...common.style, outline: 'none', cursor: 'text', userSelect: 'text' }}
        >
          {render.text}
        </div>
      );
    }
    return (
      <div key={render.key} {...common}>
        {render.text}
      </div>
    );
  }
  return (
    <div key={render.key} {...common}>
      {render.children.map((child) => element(child, editing))}
    </div>
  );
}

/** Whether a layer, or anything in it, is the one being edited. */
function holds(render: RenderNode, key: string | null): boolean {
  return key !== null && (render.key === key || render.children.some((c) => holds(c, key)));
}

/**
 * One top-level layer on the canvas with everything in it. A layer that didn't change keeps its
 * elements, so a clank restyling one frame doesn't redraw the rest.
 */
export const Layer = memo(function Layer(props: {
  node: Node;
  /** Placed by its own x and y, as on a page. Otherwise it flows, as a component's variants do. */
  free: boolean;
  components: Studio['design']['components'];
  asset: (src: string) => string | null;
  /** The key of the text layer being edited, if it's in here. */
  editing: string | null;
}) {
  const { node, free, components, asset, editing } = props;
  const drawn = useMemo(
    () => renderNode(node, free ? 'free' : 'col', { design: { components }, asset }),
    [node, free, components, asset],
  );
  if (!drawn) return null;
  return element(drawn, holds(drawn, editing) ? editing : null);
});

/**
 * A frame on its own, drawn at a scale: for the prototype, for comparing two versions, and for
 * components' previews.
 */
export function FrameView(props: {
  state: Studio;
  frame: Node;
  mode: string;
  scale: number;
  asset: (src: string) => string | null;
}) {
  const { state, frame, mode, scale, asset } = props;
  const drawn = useMemo(
    () => renderFrame(frame, { design: state.design, asset }),
    [frame, state.design, asset],
  );
  const vars = useMemo(() => rootStyle(state.tokens, mode), [state.tokens, mode]);
  // `zoom` scales the layout too, so what's around the frame makes room for its scaled size.
  return (
    <div
      style={{
        ...(vars as CSSProperties),
        display: 'inline-block',
        position: 'relative',
        verticalAlign: 'top',
        zoom: scale,
        userSelect: 'none',
      }}
    >
      {drawn ? element(drawn, null) : null}
    </div>
  );
}
