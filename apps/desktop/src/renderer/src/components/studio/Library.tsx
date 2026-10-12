import {
  FRAME_PRESETS,
  Ids,
  type Node,
  type Studio,
  findToken,
  iconNames,
  iconShapes,
  parseMarkup,
} from '@clanks/design';
import type { DesignSnapshot, DesignSource } from '@clanks/orchestrator';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useTRPC } from '../../lib/trpc';
import { ErrorText } from '../ui';
import { FrameView } from './Layer';
import { Mini, Section, fieldClass } from './fields';

/** Greyscale blocks for wireframes, as markup. They use the `wire.*` tokens. */
const WIRE_KIT: [name: string, markup: string][] = [
  ['Heading', '<Rect name="Heading" w=240 h=28 fill={wire.text} radius=4 />'],
  [
    'Text lines',
    '<Frame name="Text lines" layout=col gap=8 w=320><Rect name="Line" w=fill h=10 fill={wire.fill} radius=4 /><Rect name="Line" w=fill h=10 fill={wire.fill} radius=4 /><Rect name="Line" w=200 h=10 fill={wire.fill} radius=4 /></Frame>',
  ],
  [
    'Image',
    '<Frame name="Image" w=320 h=200 layout=col align=center justify=center fill={wire.surface} stroke={wire.line}><Icon icon="image" color={wire.muted} size=32 /></Frame>',
  ],
  [
    'Button',
    '<Frame name="Button" layout=row padX=20 padY=12 align=center justify=center fill={wire.text} radius=6><Text name="Label" color={wire.bg} size=14 weight=600>Button</Text></Frame>',
  ],
  [
    'Input',
    '<Frame name="Input" w=320 h=44 layout=row padX=12 align=center fill={wire.bg} stroke={wire.line} radius=6><Text name="Placeholder" color={wire.muted} size=14>Placeholder</Text></Frame>',
  ],
  [
    'Card',
    '<Frame name="Card" w=320 layout=col gap=12 pad=16 fill={wire.bg} stroke={wire.line} radius=8><Rect name="Picture" w=fill h=140 fill={wire.surface} radius=4 /><Rect name="Title" w=180 h=16 fill={wire.text} radius=4 /><Rect name="Line" w=fill h=10 fill={wire.fill} radius=4 /></Frame>',
  ],
  [
    'Nav bar',
    '<Frame name="Nav bar" w=fill h=64 layout=row padX=24 align=center justify=between fill={wire.bg} stroke={wire.line}><Rect name="Logo" w=96 h=20 fill={wire.text} radius=4 /><Frame name="Links" layout=row gap=24><Rect name="Link" w=56 h=10 fill={wire.fill} radius=4 /><Rect name="Link" w=56 h=10 fill={wire.fill} radius=4 /><Rect name="Link" w=56 h=10 fill={wire.fill} radius=4 /></Frame></Frame>',
  ],
];

const ICONS = iconNames();

/**
 * Things to put on the canvas: frames at preset sizes, the design's components, wireframe blocks,
 * the built-in icons and the project's images.
 */
export function Library(props: {
  state: Studio;
  snapshot: DesignSnapshot;
  source: DesignSource;
  mode: string;
  asset: (src: string) => string | null;
  /** Puts new layers on the canvas: in the selected frame, or on the page. */
  insert: (nodes: Node[], options?: { page?: boolean }) => void;
  report: (message: string) => void;
}) {
  const { state, snapshot } = props;
  const trpc = useTRPC();
  const [query, setQuery] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const addAsset = useMutation(trpc.design.addAsset.mutationOptions());
  const icons = useMemo(() => {
    const wanted = query.trim().toLowerCase().replace(/\s+/g, '-');
    return (wanted ? ICONS.filter((name) => name.includes(wanted)) : ICONS).slice(0, 60);
  }, [query]);
  const ids = () => new Ids(state.design);

  const fromMarkup = (markup: string) => {
    try {
      props.insert(parseMarkup(markup, { ids: ids(), design: state.design }));
    } catch (error) {
      props.report(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <Section title="Frames">
        <div className="grid grid-cols-2 gap-1">
          {FRAME_PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              title={`${preset.w} × ${preset.h}`}
              onClick={() =>
                props.insert(
                  [
                    {
                      id: ids().node(),
                      type: 'frame',
                      name: preset.group === 'Screens' ? `Page / ${preset.name}` : preset.name,
                      w: preset.w,
                      h: preset.h,
                      layout: 'col',
                      fill: findToken(state.tokens, 'color.bg') ? '{color.bg}' : '#ffffff',
                      children: [],
                    },
                  ],
                  { page: true },
                )
              }
              className="flex h-9 flex-col justify-center rounded-md border border-line bg-white/[0.03] px-2 text-left hover:bg-white/[0.07]"
            >
              <span className="truncate text-[12px] text-white/90">{preset.name}</span>
              <span className="font-mono text-[10px] text-dim">
                {preset.w}×{preset.h}
              </span>
            </button>
          ))}
        </div>
      </Section>

      {state.design.components.length > 0 && (
        <Section title="Components">
          <div className="flex flex-col gap-1.5">
            {state.design.components.map((component) => {
              const root = component.variants[0]!.root;
              return (
                <button
                  key={component.id}
                  type="button"
                  title={`Insert ${component.name}`}
                  onClick={() =>
                    props.insert([
                      {
                        id: ids().node(),
                        type: 'instance',
                        name: component.name,
                        component: component.id,
                        variant: component.variants[0]!.name,
                      },
                    ])
                  }
                  className="flex flex-col gap-1.5 overflow-hidden rounded-md border border-line bg-white/[0.03] p-2 text-left hover:bg-white/[0.07]"
                >
                  <span className="pointer-events-none flex max-h-20 items-center justify-center overflow-hidden rounded bg-white/90 p-2">
                    <FrameView
                      state={state}
                      frame={root}
                      mode={props.mode}
                      scale={0.5}
                      asset={props.asset}
                    />
                  </span>
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12px] text-white/90">{component.name}</span>
                    <span className="shrink-0 text-[10px] text-dim">
                      {component.variants.length}{' '}
                      {component.variants.length === 1 ? 'variant' : 'variants'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="Wireframe kit">
        <div className="grid grid-cols-2 gap-1">
          {WIRE_KIT.map(([name, markup]) => (
            <button
              key={name}
              type="button"
              onClick={() => fromMarkup(markup)}
              className="h-7 truncate rounded-md border border-line bg-white/[0.03] px-2 text-left text-[12px] text-white/90 hover:bg-white/[0.07]"
            >
              {name}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Icons">
        <input
          value={query}
          placeholder="Search Lucide icons"
          aria-label="Search icons"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          className={fieldClass}
        />
        <div className="grid grid-cols-6 gap-1">
          {icons.map((name) => (
            <button
              key={name}
              type="button"
              title={name}
              aria-label={`Insert the ${name} icon`}
              onClick={() =>
                props.insert([
                  {
                    id: ids().node(),
                    type: 'icon',
                    name,
                    icon: name,
                    ...(findToken(state.tokens, 'color.text') ? { color: '{color.text}' } : {}),
                  },
                ])
              }
              className="grid aspect-square place-items-center rounded-md text-white/80 hover:bg-white/[0.08] hover:text-white"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                dangerouslySetInnerHTML={{ __html: iconShapes(name) ?? '' }}
              />
            </button>
          ))}
        </div>
        {icons.length === 0 && <p className="text-[12px] text-dim">No icon has that name.</p>}
      </Section>

      <Section
        title="Images"
        actions={
          <Mini title="Add an image from your computer" onClick={() => picker.current?.click()}>
            +
          </Mini>
        }
      >
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            for (const file of files) {
              void file
                .arrayBuffer()
                .then((buffer) =>
                  addAsset.mutateAsync({
                    source: props.source,
                    name: file.name,
                    data: new Uint8Array(buffer),
                  }),
                )
                .catch(() => {});
            }
          }}
        />
        {addAsset.error && <ErrorText>{addAsset.error.message}</ErrorText>}
        {snapshot.assets.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-dim">
            Images live in <span className="font-mono">design/assets</span>. Without one, an image
            layer is a placeholder that says what's needed.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {snapshot.assets.map((asset) => (
              <li key={asset.path}>
                <button
                  type="button"
                  title={`Insert ${asset.path}`}
                  onClick={() =>
                    props.insert([
                      {
                        id: ids().node(),
                        type: 'image',
                        name: asset.name,
                        src: asset.path,
                        alt: asset.name.replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' '),
                      },
                    ])
                  }
                  className="flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-[12px] text-white/85 hover:bg-white/[0.06]"
                >
                  <span className="truncate">{asset.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-dim">
                    {Math.max(1, Math.round(asset.size / 1024))} KB
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() =>
            props.insert([{ id: ids().node(), type: 'image', name: 'Image', alt: '' }])
          }
          className="h-7 rounded-md border border-line bg-white/[0.03] px-2 text-left text-[12px] text-white/90 hover:bg-white/[0.07]"
        >
          Image placeholder
        </button>
      </Section>
    </div>
  );
}
