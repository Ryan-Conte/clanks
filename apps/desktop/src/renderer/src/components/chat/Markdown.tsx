import { type ComponentProps, type ReactNode, isValidElement, memo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CheckIcon, CopyIcon } from '../ui';

/** Plain text of rendered children, for copying a code block as it was written. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-dim transition-colors hover:bg-white/[0.06] hover:text-white"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Copied' : label}
    </button>
  );
}

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children)
    ? children
    : null;
  const language = /language-([\w+#-]+)/.exec(code?.props.className ?? '')?.[1] ?? '';
  return (
    <div className="code-block overflow-hidden rounded-xl border border-line bg-black/40">
      <div className="flex items-center justify-between border-b border-line py-1 pr-1.5 pl-3.5">
        <span className="font-mono text-[11px] text-dim">{language || 'text'}</span>
        <CopyButton text={textOf(code?.props.children).replace(/\n$/, '')} />
      </div>
      <pre className="overflow-x-auto p-3.5 font-mono text-[12.5px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  pre: CodeBlock,
  // Links open in the user's own browser; the app window only ever shows the app.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

/**
 * A reply as Markdown, with tables and highlighted code. Raw HTML in it is never rendered: replies
 * are a model's output, and nothing in them is trusted.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
