import {
  type Design,
  type Located,
  type Node,
  type Op,
  OpError,
  type Studio,
  type TokenSet,
  allNodes,
  applyOps,
  emptyDesign,
} from '@clanks/design';
import type { DesignSnapshot, DesignSource } from '@clanks/orchestrator';
import { useMutation, useQueries } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useCallback, useMemo, useState } from 'react';
import { useTRPC } from './trpc';

export type { DesignSource };

/** The tools of the canvas. */
export type Tool = 'select' | 'hand' | 'frame' | 'rect' | 'ellipse' | 'line' | 'text' | 'comment';

/** What's on the canvas: one of the design's pages, or one of its components, to edit it. */
export type View = { kind: 'page'; id: string } | { kind: 'component'; id: string };

/** A design as Studio holds it: what the orchestrator has, with the user's own edits ahead of it. */
export interface DesignStore {
  /** Null until the design first arrives. */
  snapshot: DesignSnapshot | null;
  /** What to draw. A project with no design yet draws an empty one. */
  state: Studio | null;
  /** Makes a change, shown at once and saved by the orchestrator. Returns whether it applied. */
  apply: (ops: Op[]) => boolean;
  /** Shows changes without saving them, while something is dragged. Null stops showing them. */
  preview: (ops: Op[] | null) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Why the last change didn't apply. */
  error: string | null;
  /** Says why something the user asked for can't be done. */
  report: (message: string) => void;
  clearError: () => void;
}

function studioOf(snapshot: DesignSnapshot): Studio {
  return { design: snapshot.design ?? emptyDesign(), tokens: snapshot.tokens };
}

/**
 * A design, kept live. The user's edits apply here first, with the same operations the
 * orchestrator runs, so the canvas never waits; what the orchestrator saved then takes over.
 * Undo and redo replay the inverse of the user's own changes.
 */
export function useDesign(source: DesignSource, file: string | undefined): DesignStore {
  const trpc = useTRPC();
  const [snapshot, setSnapshot] = useState<DesignSnapshot | null>(null);
  /** The user's edits, ahead of what the orchestrator has confirmed, marked by the newest one. */
  const [local, setLocal] = useState<{ state: Studio; edit: object } | null>(null);
  const [transient, setTransient] = useState<Op[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stacks, setStacks] = useState<{ undo: Op[][]; redo: Op[][] }>({ undo: [], redo: [] });
  const edit = useMutation(trpc.design.edit.mutationOptions());

  useSubscription(trpc.design.live.subscriptionOptions({ source, file }, { onData: setSnapshot }));

  const base = useMemo(
    () => local?.state ?? (snapshot ? studioOf(snapshot) : null),
    [local, snapshot],
  );

  const send = useCallback(
    (ops: Op[], from: Studio): Op[] | null => {
      let result: { state: Studio; inverse: Op[] };
      try {
        result = applyOps(from, ops);
      } catch (cause) {
        setError(cause instanceof OpError ? cause.message : String(cause));
        return null;
      }
      setError(null);
      const mark = {};
      setLocal({ state: result.state, edit: mark });
      // Once the newest edit is saved, what was saved is what's true.
      const settle = () => setLocal((current) => (current?.edit === mark ? null : current));
      edit
        .mutateAsync({ source, file, ops })
        .then((saved) => {
          setSnapshot(saved);
          settle();
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          settle();
        });
      return result.inverse;
    },
    [edit, source, file],
  );

  const apply = useCallback(
    (ops: Op[]) => {
      if (!base || ops.length === 0) return false;
      const inverse = send(ops, base);
      if (!inverse) return false;
      setTransient(null);
      setStacks((s) => ({ undo: [...s.undo.slice(-199), inverse], redo: [] }));
      return true;
    },
    [base, send],
  );

  const step = useCallback(
    (from: 'undo' | 'redo') => {
      if (!base) return;
      const batch = stacks[from].at(-1);
      if (!batch) return;
      const inverse = send(batch, base);
      const to = from === 'undo' ? 'redo' : 'undo';
      setStacks((s) => ({
        ...s,
        [from]: s[from].slice(0, -1),
        // A step that no longer applies, say to a layer a clank deleted, is dropped.
        [to]: inverse ? [...s[to], inverse] : s[to],
      }));
    },
    [base, send, stacks],
  );

  const state = useMemo(() => {
    if (!base || !transient) return base;
    try {
      return applyOps(base, transient).state;
    } catch {
      return base;
    }
  }, [base, transient]);

  return {
    snapshot,
    state,
    apply,
    preview: setTransient,
    undo: useCallback(() => step('undo'), [step]),
    redo: useCallback(() => step('redo'), [step]),
    canUndo: stacks.undo.length > 0,
    canRedo: stacks.redo.length > 0,
    error,
    report: setError,
    clearError: useCallback(() => setError(null), []),
  };
}

/**
 * The images a design shows, loaded once each. Returns what the renderer asks with: a path in, a
 * data URL out, or null while it loads or when the file isn't there.
 */
export function useAssets(
  source: DesignSource,
  design: Design | null,
): (src: string) => string | null {
  const trpc = useTRPC();
  const sources = useMemo(() => {
    const found = new Set<string>();
    if (design) {
      for (const node of allNodes(design)) {
        if (node.type === 'image' && node.src) found.add(node.src);
      }
    }
    return [...found].sort();
  }, [design]);
  // The combined result keeps its identity until an image arrives, so the canvas isn't redrawn.
  const urls = useQueries({
    queries: sources.map((src) =>
      trpc.design.asset.queryOptions({ source, src }, { staleTime: Infinity }),
    ),
    combine: (results) => results.map((result) => result.data ?? null),
  });
  return useMemo(() => {
    const map = new Map<string, string>();
    sources.forEach((src, i) => {
      const url = urls[i];
      if (url) map.set(src, url);
    });
    return (src: string) => map.get(src) ?? null;
  }, [sources, urls]);
}

/** The frames to draw for a view: a page's layers where they are, or a component's variants. */
export function viewRoots(
  design: Design,
  view: View,
): { node: Node; label: string; free: boolean }[] {
  if (view.kind === 'component') {
    const component = design.components.find((c) => c.id === view.id);
    return (component?.variants ?? []).map((variant) => ({
      node: variant.root,
      label: `${component!.name} / ${variant.name}`,
      free: false,
    }));
  }
  const page = design.pages.find((p) => p.id === view.id) ?? design.pages[0];
  return (page?.children ?? []).map((node) => ({ node, label: node.name, free: true }));
}

/** The mode a design is drawn in when the one asked for isn't one it has. */
export function modeOf(tokens: TokenSet, wanted: string): string {
  return tokens.modes.includes(wanted) ? wanted : (tokens.modes[0] ?? 'light');
}

/** How a layer sits in what holds it: placed by x and y, in auto layout, or a component's root. */
export function placementOf(located: Located): 'free' | 'flow' | 'fixed' {
  if (located.holder.kind === 'variant') return 'fixed';
  if (located.holder.kind === 'page') return 'free';
  if (located.node.absolute || (located.holder.node.layout ?? 'none') === 'none') return 'free';
  return 'flow';
}

/** The box around every top-level layer of a design's view, for placing new ones beside them. */
export function contentRight(design: Design, view: View): number {
  let right = 0;
  for (const { node, free } of viewRoots(design, view)) {
    if (!free) continue;
    right = Math.max(right, (node.x ?? 0) + (typeof node.w === 'number' ? node.w : 400) + 80);
  }
  return right;
}
