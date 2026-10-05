import * as monaco from 'monaco-editor/editor/editor.api';
// Syntax colouring for every language Monaco knows, without the language servers: the diff editor
// shows code, it doesn't check it.
import 'monaco-editor/basic-languages/monaco.contribution';
// The editor's parts are opt-in: its icon font, the diff editor's own actions, hovers for the
// change markers, the right-click menu, find, and copy and paste.
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/diffEditor/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/clipboard/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

// Diffs are worked out in a worker bundled with the app, so nothing loads from the network.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

/** The clanks.si palette, for the editor. */
monaco.editor.defineTheme('clanks', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8a8a93', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b9a7ff' },
    { token: 'string', foreground: '7ce7d2' },
    { token: 'number', foreground: 'fcd34d' },
    { token: 'type', foreground: '7dd3fc' },
  ],
  colors: {
    'editor.background': '#08080a',
    'editor.foreground': '#e4e4e7',
    'editorLineNumber.foreground': '#4a4a52',
    'editorLineNumber.activeForeground': '#a1a1aa',
    'editor.lineHighlightBackground': '#ffffff08',
    'editor.selectionBackground': '#b9a7ff40',
    'editorGutter.background': '#08080a',
    'diffEditor.insertedTextBackground': '#7ce7d21f',
    'diffEditor.removedTextBackground': '#fb71852a',
    'diffEditor.insertedLineBackground': '#7ce7d212',
    'diffEditor.removedLineBackground': '#fb718518',
    'diffEditorGutter.insertedLineBackground': '#7ce7d222',
    'diffEditorGutter.removedLineBackground': '#fb718528',
    'diffEditor.diagonalFill': '#ffffff08',
    'scrollbarSlider.background': '#ffffff1a',
    'scrollbarSlider.hoverBackground': '#ffffff2a',
    'editorWidget.background': '#0d0d10',
    'editorWidget.border': '#ffffff14',
  },
});

/** Monaco's language for a file, from its name. Plain text when it doesn't know. */
export function languageOf(path: string): string {
  const name = path.split('/').pop()!.toLowerCase();
  const byName: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'shell' };
  if (byName[name]) return byName[name];
  const extension = `.${name.split('.').pop()}`;
  const known = monaco.languages.getLanguages().find((l) => l.extensions?.includes(extension));
  return known?.id ?? 'plaintext';
}

export { monaco };
