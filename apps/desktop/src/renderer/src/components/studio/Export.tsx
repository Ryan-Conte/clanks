import { type Design, locate, topFrames, topOf } from '@clanks/design';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { DesignSource, View } from '../../lib/studio';
import { useTRPC } from '../../lib/trpc';
import { CopyButton } from '../chat/Markdown';
import { Button, ErrorText, IconButton, XIcon } from '../ui';
import { Select } from './fields';

/**
 * Takes a design out of Studio: a frame as a PNG, an SVG of shapes and real text, or a PDF, and a
 * component as a React component with its CSS to start building from.
 */
export function ExportPanel(props: {
  source: DesignSource;
  file: string;
  design: Design;
  view: View | null;
  selection: string[];
  mode: string;
  onClose: () => void;
}) {
  const { design, source, file } = props;
  const trpc = useTRPC();
  const frames = topFrames(design).map((t) => t.frame);
  // The frame the selection is in, else the first on the page being looked at.
  const selected = props.selection
    .map((id) => locate(design, id))
    .map((located) => (located && !located.component ? topOf(located) : null))
    .find((node) => node !== null);
  const onPage =
    props.view?.kind === 'page'
      ? design.pages.find((p) => p.id === props.view!.id)?.children.find((n) => n.type === 'frame')
      : undefined;
  const [frameId, setFrame] = useState<string | null>(null);
  const frame =
    frames.find((f) => f.id === frameId) ??
    frames.find((f) => f.id === selected?.id) ??
    frames.find((f) => f.id === onPage?.id) ??
    frames[0];
  const [componentId, setComponent] = useState<string | null>(null);
  const component =
    design.components.find((c) => c.id === componentId) ??
    (props.view?.kind === 'component'
      ? design.components.find((c) => c.id === props.view!.id)
      : undefined) ??
    design.components[0];
  const [saved, setSaved] = useState<string | null>(null);
  const exportFrame = useMutation(
    trpc.design.exportFrame.mutationOptions({ onSuccess: (path) => setSaved(path) }),
  );
  const saveComponent = useMutation(
    trpc.design.saveComponent.mutationOptions({ onSuccess: (path) => setSaved(path) }),
  );
  const code = useQuery(
    trpc.design.componentCode.queryOptions(
      { source, file, component: component?.id ?? '' },
      { enabled: component !== undefined },
    ),
  );
  const busy = exportFrame.isPending || saveComponent.isPending;
  const send = (format: 'png' | 'svg' | 'pdf', scale = 1) =>
    frame && exportFrame.mutate({ source, file, frame: frame.id, format, mode: props.mode, scale });

  return (
    <div
      className="absolute top-2 right-2 z-30 flex w-80 flex-col gap-4 rounded-2xl border border-line bg-panel p-4 shadow-2xl"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium tracking-[0.15em] text-dim uppercase">Export</h3>
        <IconButton label="Close" onClick={props.onClose}>
          <XIcon />
        </IconButton>
      </header>

      <section className="flex flex-col gap-2">
        <span className="text-[12px] text-dim">A frame, in {props.mode} mode</span>
        {frame ? (
          <>
            <Select
              label="Frame"
              value={frame.id}
              options={frames.map((f) => [f.id, f.name] as const)}
              onChange={setFrame}
            />
            <span className="flex flex-wrap gap-1.5">
              <Button size="sm" disabled={busy} onClick={() => send('png')}>
                PNG
              </Button>
              <Button size="sm" disabled={busy} onClick={() => send('png', 2)}>
                PNG @2x
              </Button>
              <Button
                size="sm"
                disabled={busy}
                title="Shapes and real text, for a vector editor"
                onClick={() => send('svg')}
              >
                SVG
              </Button>
              <Button size="sm" disabled={busy} onClick={() => send('pdf')}>
                PDF
              </Button>
            </span>
          </>
        ) : (
          <p className="text-[12px] text-dim">There are no frames yet.</p>
        )}
      </section>

      {component && (
        <section className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="text-[12px] text-dim">A component, as code to start from</span>
          <Select
            label="Component"
            value={component.id}
            options={design.components.map((c) => [c.id, c.name] as const)}
            onChange={setComponent}
          />
          {code.data && (
            <span className="flex flex-wrap items-center gap-1.5">
              <CopyButton text={code.data.tsx} label={`${code.data.name}.tsx`} />
              <CopyButton text={code.data.css} label={`${code.data.name}.css`} />
              <Button
                size="sm"
                disabled={busy}
                onClick={() => saveComponent.mutate({ source, file, component: component.id })}
              >
                Save both…
              </Button>
            </span>
          )}
          <p className="text-[11px] leading-snug text-dim">
            React and CSS that keep the tokens as custom properties. Export the tokens as CSS from
            the tokens panel to go with it.
          </p>
        </section>
      )}

      {busy && <p className="text-[12px] text-dim">Drawing it…</p>}
      {saved && !busy && (
        <p className="truncate font-mono text-[11px] text-accent-2" title={saved}>
          Saved to {saved}
        </p>
      )}
      {(exportFrame.error ?? saveComponent.error ?? code.error) && (
        <ErrorText>{(exportFrame.error ?? saveComponent.error ?? code.error)!.message}</ErrorText>
      )}
    </div>
  );
}
