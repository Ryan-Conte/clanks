import {
  EXPORT_FILES,
  type Op,
  type Studio,
  TOKEN_EXPORTS,
  type Token,
  type TokenExport,
  TokenError,
  type TokenType,
  exportTokens,
  isRef,
  makeToken,
  resolveColor,
  valueIn,
  valueText,
} from '@clanks/design';
import type { DesignSource } from '@clanks/orchestrator';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { DesignStore } from '../../lib/studio';
import { useTRPC } from '../../lib/trpc';
import { Button, ErrorText } from '../ui';
import { Input, Mini, Section, Segments, fieldClass } from './fields';

/** A value as the panel shows it, read back into what a token of that type takes. */
function parseValue(type: TokenType, text: string): unknown {
  const trimmed = text.trim();
  if (isRef(trimmed) || type !== 'typography') return trimmed;
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as unknown;
  // "Inter 48/1.1 700 tracking -0.5", as the panel writes a text style.
  const match =
    /^(.+?)\s+([\d.]+|\{[\w.-]+\})(?:px)?\/([\d.]+|\{[\w.-]+\})\s+(\S+)(?:\s+tracking\s+(\S+))?$/.exec(
      trimmed,
    );
  if (!match) {
    throw new TokenError(
      'Write a text style as family size/line-height weight, such as "Inter 16/1.5 400".',
    );
  }
  const number = (value: string) => (isRef(value) ? value : Number(value));
  return {
    font: match[1],
    size: number(match[2]!),
    lineHeight: number(match[3]!),
    weight: isRef(match[4]!) || Number.isNaN(Number(match[4])) ? match[4] : Number(match[4]),
    ...(match[5] ? { letterSpacing: number(match[5]) } : {}),
  };
}

/**
 * The project's design tokens, by group, with a value per mode: colours, type, spacing, radii,
 * shadows and motion. They're saved in the Design Tokens format and exported as CSS custom
 * properties, a Tailwind theme or JSON.
 */
export function TokensPanel(props: {
  state: Studio;
  store: DesignStore;
  source: DesignSource;
  editable: boolean;
  mode: string;
  setMode: (mode: string) => void;
}) {
  const { state, store, editable, mode } = props;
  const { tokens } = state;
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState<TokenExport | null>(null);
  const [draft, setDraft] = useState({ name: '', value: '' });
  const [renaming, setRenaming] = useState<string | null>(null);
  const first = tokens.modes[0] ?? 'light';
  const groups = new Map<string, Token[]>();
  for (const token of tokens.tokens) {
    const group = token.path.split('.')[0]!;
    groups.set(group, [...(groups.get(group) ?? []), token]);
  }

  /** Makes a change that may not fit, saying why when it doesn't. */
  const attempt = (work: () => Op[]) => {
    try {
      return store.apply(work());
    } catch (error) {
      store.report(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const setValue = (token: Token, text: string) =>
    attempt(() => {
      const modes: Record<string, unknown> = { ...token.modes };
      let value: unknown = token.value;
      if (mode === first) value = parseValue(token.type, text);
      else if (text.trim() === '') delete modes[mode];
      else modes[mode] = parseValue(token.type, text);
      const next = makeToken(tokens, {
        name: token.path,
        value,
        type: token.type,
        modes,
        ...(token.description ? { description: token.description } : {}),
      });
      // makeToken keeps the modes it's given; a mode that was cleared is gone.
      if (Object.keys(modes).length === 0) delete next.modes;
      return [{ op: 'token.set', token: next }];
    });

  const add = () => {
    if (!draft.name.trim() || !draft.value.trim()) return;
    const made = attempt(() => {
      const raw = draft.value.trim();
      const value: unknown =
        raw.startsWith('{') && !isRef(raw)
          ? (JSON.parse(raw) as unknown)
          : /^-?\d*\.?\d+$/.test(raw)
            ? Number(raw)
            : raw;
      return [{ op: 'token.set', token: makeToken(tokens, { name: draft.name, value }) }];
    });
    if (made) setDraft({ name: '', value: '' });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <Section
        title="Tokens"
        actions={
          <span className="flex gap-0.5">
            {TOKEN_EXPORTS.map((format) => (
              <Mini
                key={format}
                title={`Export as ${format === 'css' ? 'CSS custom properties' : format === 'tailwind' ? 'a Tailwind theme' : 'JSON'}`}
                disabled={tokens.tokens.length === 0}
                onClick={() => setExporting(format)}
              >
                {format === 'css' ? 'CSS' : format === 'tailwind' ? 'Tailwind' : 'JSON'}
              </Mini>
            ))}
          </span>
        }
      >
        <Segments
          value={mode}
          options={tokens.modes.map((m) => [m, m, `Show the design in ${m} mode`] as const)}
          onChange={props.setMode}
        />
        {editable && (
          <form
            className="grid grid-cols-[1fr_1fr_auto] gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <input
              value={draft.name}
              placeholder="color.brand"
              aria-label="New token's name"
              spellCheck={false}
              onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
              onKeyDown={(event) => event.stopPropagation()}
              className={`${fieldClass} font-mono text-[11px]`}
            />
            <input
              value={draft.value}
              placeholder="#0a84ff"
              aria-label="New token's value"
              spellCheck={false}
              onChange={(event) => setDraft((d) => ({ ...d, value: event.target.value }))}
              onKeyDown={(event) => event.stopPropagation()}
              className={`${fieldClass} font-mono text-[11px]`}
            />
            <Button size="sm" type="submit" className="h-7 px-2.5">
              Add
            </Button>
          </form>
        )}
        {tokens.tokens.length === 0 && (
          <p className="text-[12px] leading-relaxed text-dim">
            No tokens yet. Name them in groups joined by dots: primitives such as{' '}
            <span className="font-mono">color.blue.500</span>, then the ones a design uses, such as{' '}
            <span className="font-mono">color.brand</span> with the value{' '}
            <span className="font-mono">{'{color.blue.500}'}</span>.
          </p>
        )}
      </Section>

      {[...groups].map(([group, list]) => {
        const open = !closed.has(group);
        return (
          <section key={group} className="border-b border-line">
            <button
              type="button"
              aria-expanded={open}
              onClick={() =>
                setClosed((c) => {
                  const next = new Set(c);
                  if (open) next.add(group);
                  else next.delete(group);
                  return next;
                })
              }
              className="flex h-8 w-full items-center gap-1.5 px-3 text-left text-[12px] text-white/85 hover:bg-white/[0.04]"
            >
              <span className="w-3 text-[9px] text-dim">{open ? '▾' : '▸'}</span>
              <span className="font-mono">{group}</span>
              <span className="text-[10px] text-dim">{list.length}</span>
            </button>
            {open && (
              <ul className="flex flex-col gap-1 px-3 pb-3">
                {list.map((token) => {
                  const own = mode === first ? token.value : token.modes?.[mode];
                  const colour =
                    token.type === 'color' ? resolveColor(tokens, `{${token.path}}`, mode) : null;
                  return (
                    <li
                      key={token.path}
                      className="group grid grid-cols-[1fr_1fr] items-center gap-1.5"
                    >
                      {renaming === token.path ? (
                        <Input
                          mono
                          value={token.path}
                          onCommit={(to) => {
                            setRenaming(null);
                            if (to && to !== token.path) {
                              store.apply([{ op: 'token.rename', path: token.path, to }]);
                            }
                          }}
                        />
                      ) : (
                        <span
                          className="flex min-w-0 items-center gap-1.5"
                          title={token.description ?? `${token.type}. Double-click to rename.`}
                          onDoubleClick={() => editable && setRenaming(token.path)}
                        >
                          {colour ? (
                            <span
                              className="size-3.5 shrink-0 rounded border border-white/20"
                              style={{ background: colour }}
                            />
                          ) : (
                            <span className="w-3.5 shrink-0 text-center text-[10px] text-dim">
                              {token.type === 'typography'
                                ? 'Aa'
                                : token.type === 'shadow'
                                  ? '▚'
                                  : '#'}
                            </span>
                          )}
                          <span className="truncate font-mono text-[11px] text-white/85">
                            {token.path.slice(group.length + 1) || token.path}
                          </span>
                        </span>
                      )}
                      <span className="flex min-w-0 items-center gap-0.5">
                        <Input
                          mono
                          label={`${token.path} in ${mode}`}
                          disabled={!editable}
                          value={own === undefined ? '' : valueText(token.type, own)}
                          placeholder={
                            own === undefined ? valueText(token.type, valueIn(token, mode)) : ''
                          }
                          onCommit={(text) => {
                            if (text === '' && mode === first) return;
                            setValue(token, text);
                          }}
                        />
                        {editable && (
                          <span className="opacity-0 group-hover:opacity-100">
                            <Mini
                              title={`Delete {${token.path}}`}
                              onClick={() =>
                                store.apply([{ op: 'token.remove', path: token.path }])
                              }
                            >
                              ×
                            </Mini>
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      {exporting && (
        <ExportDialog
          format={exporting}
          text={exportTokens(tokens, exporting)}
          source={props.source}
          onClose={() => setExporting(null)}
        />
      )}
    </div>
  );
}

/** The tokens as code: to copy, or to save beside the tokens for the build to import. */
function ExportDialog(props: {
  format: TokenExport;
  text: string;
  source: DesignSource;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const [copied, setCopied] = useState(false);
  const save = useMutation(trpc.design.exportTokens.mutationOptions());
  const path = `design/${EXPORT_FILES[props.format]}`;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-8"
      onClick={props.onClose}
    >
      <div
        role="dialog"
        aria-label="Export tokens"
        className="flex max-h-full w-full max-w-2xl flex-col gap-3 rounded-2xl border border-line bg-panel p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium">
            Tokens as{' '}
            {props.format === 'css'
              ? 'CSS custom properties'
              : props.format === 'tailwind'
                ? 'a Tailwind CSS theme'
                : 'JSON'}
          </h2>
          <span className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(props.text).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({ source: props.source, format: props.format, save: true })
              }
            >
              {save.isSuccess ? `Saved to ${path}` : `Save to ${path}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={props.onClose}>
              Close
            </Button>
          </span>
        </header>
        {save.error && <ErrorText>{save.error.message}</ErrorText>}
        <pre className="min-h-0 flex-1 overflow-auto rounded-xl bg-black/40 p-4 font-mono text-[12px] leading-relaxed text-white/85 select-text">
          {props.text}
        </pre>
      </div>
    </div>
  );
}
