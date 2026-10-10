import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { Marked, type Token, type Tokens } from 'marked';

/**
 * Documents the crew wrote, as files to take elsewhere: Markdown turned into a page of HTML, which
 * the app prints to PDF, and into a Word document. What a clank wrote is never trusted: raw HTML in
 * it is shown as text, and links go only to web and mail addresses.
 */

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Addresses a link in a document may go to. */
function safeHref(href: string): string | null {
  const value = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null;
}

const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      return safe ? `<a href="${escapeHtml(safe)}">${inner}</a>` : inner;
    },
    // Pictures aren't fetched for a print: their description stands in.
    image({ text, href }) {
      return `<span class="image">[Image: ${escapeHtml(text || href)}]</span>`;
    },
  },
});

/** Markdown as HTML for the body of a page. */
export function markdownHtml(text: string): string {
  return markdown.parse(text, { async: false });
}

const PAGE_CSS = `
@page { size: A4; margin: 22mm 20mm; }
.doc { font: 11pt/1.55 'Inter Variable', Inter, 'Segoe UI', system-ui, sans-serif; color: #16161a; background: #fff; }
.doc h1, .doc h2, .doc h3, .doc h4 { font-family: 'Inter Variable', Inter, 'Segoe UI', system-ui, sans-serif; line-height: 1.25; margin: 1.4em 0 0.5em; break-after: avoid; }
.doc h1 { font-size: 22pt; margin-top: 0; letter-spacing: -0.01em; }
.doc h2 { font-size: 15pt; }
.doc h3 { font-size: 12.5pt; }
.doc h4 { font-size: 11pt; }
.doc p, .doc ul, .doc ol, .doc blockquote, .doc pre, .doc table { margin: 0 0 0.8em; }
.doc ul, .doc ol { padding-left: 1.4em; }
.doc li { margin: 0.15em 0; }
.doc a { color: #2a4bd7; text-decoration: none; }
.doc blockquote { border-left: 3px solid #d0d0d8; padding-left: 0.9em; color: #4a4a55; }
.doc code { font: 9.5pt/1.45 'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace; background: #f1f1f5; padding: 0.1em 0.3em; border-radius: 3px; }
.doc pre { background: #f1f1f5; padding: 0.8em 1em; border-radius: 6px; white-space: pre-wrap; break-inside: avoid; }
.doc pre code { background: none; padding: 0; }
.doc table { border-collapse: collapse; width: 100%; font-size: 10pt; break-inside: avoid; }
.doc th, .doc td { border: 1px solid #d0d0d8; padding: 0.35em 0.6em; text-align: left; vertical-align: top; }
.doc th { background: #f1f1f5; font-weight: 600; }
.doc hr { border: none; border-top: 1px solid #d0d0d8; margin: 1.4em 0; }
.doc .image { color: #6a6a75; font-style: italic; }
.doc .meta { color: #6a6a75; font-size: 9pt; margin-bottom: 1.6em; }
.doc pre.plain { background: none; padding: 0; font: 11pt/1.55 'Inter Variable', Inter, 'Segoe UI', system-ui, sans-serif; }
`;

/**
 * A document as the piece of HTML the app prints: its styles, then its body. Plain text, such as
 * an email, keeps its line breaks.
 */
export function printableHtml(input: { text: string; plain?: boolean; meta?: string }): string {
  const body = input.plain
    ? `<pre class="plain">${escapeHtml(input.text)}</pre>`
    : markdownHtml(input.text);
  const meta = input.meta ? `<p class="meta">${escapeHtml(input.meta)}</p>` : '';
  return `<style>${PAGE_CSS}</style><div class="doc">${meta}${body}</div>`;
}

/** The same document as a page of its own, to save as an HTML file. */
export function htmlPage(input: { title: string; text: string; plain?: boolean }): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(input.title)}</title>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>body { margin: 0 auto; max-width: 46rem; padding: 3rem 1.5rem; }</style>',
    '</head>',
    `<body>${printableHtml(input)}</body>`,
    '</html>',
    '',
  ].join('\n');
}

interface Inline {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
}

const MONO = 'Consolas';

function run(text: string, style: Inline): TextRun {
  return new TextRun({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.strike ? { strike: true } : {}),
    ...(style.code
      ? { font: MONO, size: 20, shading: { type: ShadingType.CLEAR, fill: 'F1F1F5' } }
      : {}),
  });
}

/** What a paragraph holds, from Markdown's inline tokens. */
function inline(tokens: Token[] | undefined, style: Inline = {}): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        children.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        children.push(...inline((token as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case 'del':
        children.push(...inline((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        children.push(run((token as Tokens.Codespan).text, { ...style, code: true }));
        break;
      case 'br':
        children.push(new TextRun({ break: 1 }));
        break;
      case 'link': {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        const inner = inline(link.tokens, style);
        if (!href) children.push(...inner);
        else {
          children.push(
            new ExternalHyperlink({
              link: href,
              children: [new TextRun({ text: link.text, style: 'Hyperlink' })],
            }),
          );
        }
        break;
      }
      case 'image':
        children.push(
          run(`[Image: ${(token as Tokens.Image).text || (token as Tokens.Image).href}]`, {
            ...style,
            italics: true,
          }),
        );
        break;
      case 'text': {
        const text = token as Tokens.Text;
        if (text.tokens?.length) children.push(...inline(text.tokens, style));
        else children.push(run(decode(text.text), style));
        break;
      }
      default:
        // Raw HTML and anything else is shown as it was written.
        if ('text' in token && typeof token.text === 'string') {
          children.push(run(decode(token.text), style));
        }
    }
  }
  return children;
}

/** The entities an author wrote, as the characters they mean. */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const ORDERED = 'ordered';

type Block = Paragraph | Table;

interface BlockContext {
  /** How far in a list it is: 0 at the top. */
  depth: number;
  quote: boolean;
  /** Each ordered list counts from one, so each gets a numbering of its own. */
  lists: { next: number };
}

function blocks(tokens: Token[], ctx: BlockContext): Block[] {
  const out: Block[] = [];
  const indent = ctx.quote ? { indent: { left: 480 } } : {};
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        out.push(
          new Paragraph({
            heading: HEADINGS[Math.min(heading.depth, 6) - 1]!,
            children: inline(heading.tokens),
          }),
        );
        break;
      }
      case 'paragraph':
        out.push(
          new Paragraph({
            children: inline(
              (token as Tokens.Paragraph).tokens,
              ctx.quote ? { italics: true } : {},
            ),
            spacing: { after: 160 },
            ...indent,
          }),
        );
        break;
      case 'text': {
        const text = token as Tokens.Text;
        out.push(
          new Paragraph({
            children: text.tokens?.length ? inline(text.tokens) : [run(decode(text.text), {})],
            ...indent,
          }),
        );
        break;
      }
      case 'list': {
        const list = token as Tokens.List;
        const instance = list.ordered ? ctx.lists.next++ : 0;
        for (const item of list.items) {
          let first = true;
          for (const child of item.tokens) {
            if (child.type === 'list') {
              out.push(...blocks([child], { ...ctx, depth: ctx.depth + 1 }));
              continue;
            }
            const text = child as Tokens.Text | Tokens.Paragraph;
            const children =
              'tokens' in text && text.tokens?.length
                ? inline(text.tokens)
                : [run(decode('text' in text ? text.text : ''), {})];
            const level = Math.min(ctx.depth, 8);
            out.push(
              new Paragraph({
                children:
                  item.task && first
                    ? [run(item.checked ? '☑ ' : '☐ ', {}), ...children]
                    : children,
                ...(first
                  ? list.ordered
                    ? { numbering: { reference: ORDERED, level, instance } }
                    : { bullet: { level } }
                  : { indent: { left: 720 * (level + 1) } }),
                spacing: { after: 60 },
              }),
            );
            first = false;
          }
        }
        break;
      }
      case 'blockquote':
        out.push(...blocks((token as Tokens.Blockquote).tokens, { ...ctx, quote: true }));
        break;
      case 'code':
        for (const line of (token as Tokens.Code).text.split('\n')) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || ' ', font: MONO, size: 19 })],
              shading: { type: ShadingType.CLEAR, fill: 'F1F1F5' },
              spacing: { after: 0 },
            }),
          );
        }
        out.push(new Paragraph({ children: [], spacing: { after: 80 } }));
        break;
      case 'table': {
        const table = token as Tokens.Table;
        const cell = (c: Tokens.TableCell, header: boolean) =>
          new TableCell({
            children: [new Paragraph({ children: inline(c.tokens, header ? { bold: true } : {}) })],
            ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'F1F1F5' } } : {}),
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
          });
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: table.header.map((c) => cell(c, true)) }),
              ...table.rows.map(
                (row) => new TableRow({ children: row.map((c) => cell(c, false)) }),
              ),
            ],
          }),
          new Paragraph({ children: [], spacing: { after: 120 } }),
        );
        break;
      }
      case 'hr':
        out.push(
          new Paragraph({
            children: [],
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C8C8D0', space: 1 } },
            spacing: { after: 200 },
          }),
        );
        break;
      case 'space':
        break;
      default:
        // Raw HTML, shown as it was written.
        if ('text' in token && typeof token.text === 'string' && token.text.trim()) {
          out.push(new Paragraph({ children: [run(token.text.trim(), {})], ...indent }));
        }
    }
  }
  return out;
}

/** A document as a Word file. Plain text, such as an email, becomes a paragraph per line. */
export async function wordDocument(input: {
  title: string;
  text: string;
  plain?: boolean;
  author?: string;
}): Promise<Uint8Array> {
  const children: Block[] = input.plain
    ? input.text.split('\n').map((line) => new Paragraph({ children: [new TextRun(line)] }))
    : blocks(markdown.lexer(input.text), { depth: 0, quote: false, lists: { next: 1 } });
  const document = new Document({
    title: input.title,
    creator: input.author ?? 'clanks',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { line: 300 } } },
      },
    },
    numbering: {
      config: [
        {
          reference: ORDERED,
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: level % 2 === 0 ? LevelFormat.DECIMAL : LevelFormat.LOWER_LETTER,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
