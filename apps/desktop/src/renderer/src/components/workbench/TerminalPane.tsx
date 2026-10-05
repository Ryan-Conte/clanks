import type { TerminalSession } from '@clanks/core';
import { useMutation } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTRPC, useTRPCClient } from '../../lib/trpc';
import { useWorkbench } from '../../lib/workbench';
import { Button, Dot, ErrorText } from '../ui';

/** Every command the clank ran, live, and the user's own shell in its worktree. */
export function TerminalPane() {
  const trpc = useTRPC();
  const { conversationId, focus, state } = useWorkbench();
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  useSubscription(
    trpc.workspace.terminal.sessions.subscriptionOptions(conversationId!, {
      enabled: conversationId !== null,
      onData: (next) => {
        setSessions(next);
        // A new command takes the stage, unless the user is typing in their shell.
        setSelected((current) => {
          const chosen = next.find((s) => s.id === current);
          if (chosen?.kind === 'user' && chosen.state === 'running') return current;
          const newest = next.at(-1);
          return newest && (newest.state === 'running' || !chosen)
            ? newest.id
            : (chosen?.id ?? null);
        });
      },
    }),
  );
  // The activity timeline and tool cards can point the terminal at a command.
  const [seenFocus, setSeenFocus] = useState(0);
  if (focus && focus.nonce !== seenFocus) {
    setSeenFocus(focus.nonce);
    if (focus.sessionId) setSelected(focus.sessionId);
  }

  const open = useMutation(
    trpc.workspace.terminal.open.mutationOptions({
      onSuccess: (session) => setSelected(session.id),
    }),
  );
  const stop = useMutation(trpc.workspace.terminal.stop.mutationOptions());
  const clear = useMutation(trpc.workspace.terminal.clear.mutationOptions());
  const session = sessions.find((s) => s.id === selected) ?? null;
  if (!conversationId) return null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-52 shrink-0 flex-col border-r border-line">
        <ul className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Commands">
          {sessions.length === 0 && (
            <li className="px-3 py-2 text-[12px] text-dim">Commands show up here as they run.</li>
          )}
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelected(s.id)}
                title={s.title}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${s.id === selected ? 'bg-white/[0.07] text-white' : 'text-white/75 hover:bg-white/[0.04]'}`}
              >
                <Dot
                  tone={
                    s.state === 'running'
                      ? 'mint'
                      : s.exitCode === 0 || s.kind === 'user'
                        ? 'dim'
                        : 'rose'
                  }
                  live={s.state === 'running'}
                />
                <span
                  className={`min-w-0 flex-1 truncate ${s.kind === 'clank' ? 'font-mono' : ''}`}
                >
                  {s.title}
                </span>
                {s.state !== 'running' && s.kind === 'clank' && (
                  <span className="shrink-0 font-mono text-[10px] text-dim">
                    {s.state === 'stopped' ? 'stopped' : s.exitCode}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-1.5 border-t border-line p-2">
          <Button
            size="sm"
            disabled={!state?.run || open.isPending}
            onClick={() => open.mutate({ conversationId, cols: 100, rows: 30 })}
            title="Your own shell in the clank's worktree. The clank can't see or use it."
          >
            Open a shell here
          </Button>
          {sessions.some((s) => s.state !== 'running') && (
            <Button size="sm" variant="ghost" onClick={() => clear.mutate(conversationId)}>
              Clear finished
            </Button>
          )}
          {open.error && <ErrorText>{open.error.message}</ErrorText>}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {session ? (
          <>
            <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-mono text-dim" title={session.cwd}>
                {session.cwd}
              </span>
              {session.state === 'running' && (
                <Button size="sm" variant="danger" onClick={() => stop.mutate(session.id)}>
                  {session.kind === 'user' ? 'Close' : 'Stop'}
                </Button>
              )}
            </div>
            <Xterm key={session.id} session={session} />
          </>
        ) : (
          <p className="p-6 text-sm text-dim">Pick a command to see its output.</p>
        )}
      </div>
    </div>
  );
}

/** One session's output, as a terminal draws it. The user's shell takes typing. */
function Xterm({ session }: { session: TerminalSession }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const host = useRef<HTMLDivElement>(null);
  const input = useMutation(trpc.workspace.terminal.input.mutationOptions());
  const resize = useMutation(trpc.workspace.terminal.resize.mutationOptions());
  const interactive = session.kind === 'user' && session.state === 'running';
  const latest = useRef({ interactive, input, resize });
  useLayoutEffect(() => {
    latest.current = { interactive, input, resize };
  });

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: {
        background: '#08080a',
        foreground: '#e4e4e7',
        cursor: '#b9a7ff',
        selectionBackground: '#b9a7ff40',
        black: '#18181b',
        green: '#7ce7d2',
        brightGreen: '#a7f3e4',
        magenta: '#b9a7ff',
        brightMagenta: '#d4c9ff',
        red: '#fb7185',
        yellow: '#fcd34d',
        blue: '#7dd3fc',
        cyan: '#67e8f9',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    // Everything printed so far comes first, then each new piece.
    const output = client.workspace.terminal.output.subscribe(session.id, {
      onData: (event) => term.write(event.data),
    });
    const sizeUp = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (latest.current.interactive) {
        latest.current.resize.mutate({ sessionId: session.id, cols: term.cols, rows: term.rows });
      }
    };
    sizeUp();
    const observer = new ResizeObserver(sizeUp);
    observer.observe(host.current!);
    const typing = term.onData((data) => {
      if (latest.current.interactive) latest.current.input.mutate({ sessionId: session.id, data });
    });
    if (session.kind === 'user') term.focus();
    return () => {
      output.unsubscribe();
      observer.disconnect();
      typing.dispose();
      term.dispose();
    };
  }, [client, session.id, session.kind]);

  return <div ref={host} className="min-h-0 flex-1 bg-[#08080a] px-2 py-1" />;
}
