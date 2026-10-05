import type { Hunk } from '@clanks/core';
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { hunkLines } from '../../lib/hunks';
import { languageOf, monaco } from '../../lib/monaco';

/** What the diff pane can ask of the editor. */
export interface DiffHandle {
  /** The right-hand side's text, with any edits. */
  value(): string;
  /** The lines selected on the right, if more than a caret. */
  selection(): { start: number; end: number } | null;
  reveal(line: number): void;
}

/**
 * Monaco's diff editor for one file. The right-hand side is editable when it's the live worktree;
 * Ctrl+S saves. Each changed run gets a marker in the gutter that picks it.
 */
export function MonacoDiff(props: {
  path: string;
  original: string;
  modified: string;
  sideBySide: boolean;
  editable: boolean;
  hunks: Hunk[];
  activeHunk: number | null;
  onSelectHunk: (index: number) => void;
  onDirty: (dirty: boolean) => void;
  onSave: (content: string) => void;
  handle: RefObject<DiffHandle | null>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const models = useRef<{
    path: string;
    original: monaco.editor.ITextModel;
    modified: monaco.editor.ITextModel;
  } | null>(null);
  /** The right-hand text as last loaded, to tell the user's edits from Forge's. */
  const loaded = useRef('');
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  // Callbacks change every render; the editor's listeners read the latest through these.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const diff = monaco.editor.createDiffEditor(container.current!, {
      theme: 'clanks',
      automaticLayout: true,
      renderSideBySide: latest.current.sideBySide,
      useInlineViewWhenSpaceIsLimited: false,
      readOnly: !latest.current.editable,
      originalEditable: false,
      ignoreTrimWhitespace: false,
      glyphMargin: true,
      fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
      fontSize: 12.5,
      lineHeight: 19,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 },
      padding: { top: 8 },
      stickyScroll: { enabled: false },
    });
    editor.current = diff;
    const right = diff.getModifiedEditor();
    decorations.current = right.createDecorationsCollection();
    right.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (latest.current.editable && models.current)
        latest.current.onSave(models.current.modified.getValue());
    });
    const onMouse = right.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = event.target.position?.lineNumber;
      if (line === undefined) return;
      const index = latest.current.hunks.findIndex((h) => {
        const { start, end } = hunkLines(h);
        return line >= start && line <= end;
      });
      if (index !== -1) latest.current.onSelectHunk(index);
    });
    latest.current.handle.current = {
      value: () => models.current?.modified.getValue() ?? '',
      selection: () => {
        const selection = right.getSelection();
        if (!selection || selection.isEmpty()) return null;
        const end =
          selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
            ? selection.endLineNumber - 1
            : selection.endLineNumber;
        return { start: selection.startLineNumber, end };
      },
      reveal: (line) => right.revealLineInCenterIfOutsideViewport(line),
    };
    return () => {
      onMouse.dispose();
      diff.dispose();
      models.current?.original.dispose();
      models.current?.modified.dispose();
      models.current = null;
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    editor.current?.updateOptions({
      renderSideBySide: props.sideBySide,
      readOnly: !props.editable,
    });
  }, [props.sideBySide, props.editable]);

  // A new file gets new models; the same file is updated in place, keeping the scroll position.
  useEffect(() => {
    const diff = editor.current;
    if (!diff) return;
    const current = models.current;
    if (!current || current.path !== props.path) {
      const language = languageOf(props.path);
      const original = monaco.editor.createModel(props.original, language);
      const modified = monaco.editor.createModel(props.modified, language);
      diff.setModel({ original, modified });
      current?.original.dispose();
      current?.modified.dispose();
      models.current = { path: props.path, original, modified };
      loaded.current = props.modified;
      modified.onDidChangeContent(() =>
        latest.current.onDirty(modified.getValue() !== loaded.current),
      );
      latest.current.onDirty(false);
      return;
    }
    if (current.original.getValue() !== props.original) current.original.setValue(props.original);
    const dirty = current.modified.getValue() !== loaded.current;
    if (!dirty && current.modified.getValue() !== props.modified) {
      const right = diff.getModifiedEditor();
      const view = right.saveViewState();
      loaded.current = props.modified;
      current.modified.setValue(props.modified);
      if (view) right.restoreViewState(view);
    } else if (!dirty) {
      loaded.current = props.modified;
    }
  }, [props.path, props.original, props.modified]);

  // Markers in the gutter, with the picked change lit up.
  useEffect(() => {
    decorations.current?.set(
      props.hunks.flatMap((hunk, i) => {
        const { start, end } = hunkLines(hunk);
        const active = i === props.activeHunk;
        return [
          {
            range: new monaco.Range(start, 1, start, 1),
            options: {
              glyphMarginClassName: `hunk-glyph${active ? ' hunk-glyph-active' : ''}`,
              glyphMarginHoverMessage: { value: `Change ${i + 1}: click to pick it` },
            },
          },
          ...(active
            ? [
                {
                  range: new monaco.Range(start, 1, end, 1),
                  options: { isWholeLine: true, className: 'hunk-active-line' },
                },
              ]
            : []),
        ];
      }),
    );
  }, [props.hunks, props.activeHunk, props.path, props.modified]);

  return <div ref={container} className="h-full min-h-0 w-full" />;
}
