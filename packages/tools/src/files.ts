import {
  PathError,
  changedRanges,
  headOnly,
  isBinary,
  resolveInside,
  runGit,
  toRelative,
} from '@clanks/workspace';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { type ToolContext, ToolFailure, type WorkspaceAccess, defineTool, short } from './spec';

/** Files bigger than this are someone's data, not code to read whole. */
const MAX_READ_BYTES = 20 * 1024 * 1024;
const DEFAULT_LINES = 2000;
const MAX_LIST_LINES = 300;
const MAX_MATCHES = 200;

function workspaceOf(ctx: ToolContext): WorkspaceAccess {
  if (!ctx.workspace) throw new ToolFailure('This chat has no workspace, so there are no files.');
  return ctx.workspace;
}

/** A path the clank gave, resolved inside the workspace, with the reason if it can't be. */
function locate(ctx: ToolContext, path: string): { full: string; rel: string } {
  const ws = workspaceOf(ctx);
  try {
    const full = resolveInside(ws.root, ws.cwd, path);
    return { full, rel: toRelative(ws.cwd, full) || '.' };
  } catch (error) {
    if (error instanceof PathError) throw new ToolFailure(error.message);
    throw error;
  }
}

const pathArg = z.string().min(1).describe('A path relative to the workspace, such as src/app.ts');

export const fsRead = defineTool({
  name: 'fs_read',
  description:
    'Reads a text file. Long files come back in parts: pass offset and limit to read further.',
  schema: z.object({
    path: pathArg,
    offset: z.number().int().min(1).optional().describe('The first line to read, from 1'),
    limit: z.number().int().min(1).max(10_000).optional().describe('How many lines to read'),
  }),
  needs: ['workspace'],
  mutates: false,
  label: (args) => `Reading \`${short(args.path)}\``,
  approval: (args) => ({ kind: 'path', subject: args.path, pattern: args.path }),
  run(args, ctx) {
    const { full, rel } = locate(ctx, args.path);
    if (!existsSync(full)) {
      throw new ToolFailure(`There's no file at ${rel}. Use fs_list or fs_search to find it.`);
    }
    const stat = statSync(full);
    if (stat.isDirectory()) throw new ToolFailure(`${rel} is a folder. Use fs_list to see it.`);
    if (stat.size > MAX_READ_BYTES) {
      throw new ToolFailure(`${rel} is ${stat.size} bytes, too big to read. Use fs_search in it.`);
    }
    const buffer = readFileSync(full);
    if (isBinary(buffer)) {
      return Promise.resolve({ content: `${rel} is a binary file of ${stat.size} bytes.` });
    }
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const total = lines.length;
    if (total === 0) return Promise.resolve({ content: `${rel} is empty.` });
    const start = Math.min(args.offset ?? 1, total);
    let end = Math.min(total, start - 1 + (args.limit ?? DEFAULT_LINES));
    let body = lines.slice(start - 1, end).join('\n');
    if (body.length > ctx.maxChars) {
      // Whole lines only, so the model can pick up where it stopped.
      let size = 0;
      let count = 0;
      for (const line of lines.slice(start - 1, end)) {
        if (size + line.length + 1 > ctx.maxChars && count > 0) break;
        size += line.length + 1;
        count++;
      }
      end = start - 1 + count;
      body = lines.slice(start - 1, end).join('\n');
    }
    let range =
      start === 1 && end === total ? `${total} lines` : `lines ${start}–${end} of ${total}`;
    if (end < total) range += `. Read on with offset ${end + 1}`;
    return Promise.resolve({ content: `${rel} (${range})\n\n${body}` });
  },
});

export const fsList = defineTool({
  name: 'fs_list',
  description:
    "Lists a folder's files and subfolders as a tree, leaving out what git ignores, such as node_modules.",
  schema: z.object({
    path: z.string().optional().describe('The folder, relative to the workspace. Default: its top'),
    depth: z.number().int().min(1).max(6).optional().describe('How many levels deep. Default 2'),
  }),
  needs: ['workspace'],
  mutates: false,
  label: (args) => `Listing \`${short(args.path ?? '.')}\``,
  approval: (args) => ({ kind: 'path', subject: args.path ?? '.', pattern: args.path ?? '.' }),
  async run(args, ctx) {
    const { full, rel } = locate(ctx, args.path ?? '.');
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      throw new ToolFailure(`There's no folder at ${rel}.`);
    }
    const listed = await runGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: full,
    });
    const all = listed.stdout.toString('utf8').split('\0').filter(Boolean);
    // The index still lists files deleted since the last commit. Checking is quick enough for any
    // repository a person browses; a huge one is listed as git has it.
    const files = all.length > 20_000 ? all : all.filter((path) => existsSync(join(full, path)));
    if (files.length === 0) return { content: `${rel} has no files.` };
    return {
      content: `${rel === '.' ? 'The workspace' : rel}:\n\n${tree(files, args.depth ?? 2)}`,
    };
  },
});

/** Paths as an indented tree, folders first, deeper levels summed up. */
export function tree(paths: string[], depth: number): string {
  interface Node {
    dirs: Map<string, Node>;
    files: string[];
    /** Files below the depth limit. */
    hidden: number;
  }
  const root: Node = { dirs: new Map(), files: [], hidden: 0 };
  for (const path of paths) {
    const parts = path.split('/');
    const folders = parts.slice(0, -1);
    // Folders show down to the depth asked for; files below it are counted, not named.
    let node = root;
    for (const folder of folders.slice(0, depth)) {
      let next = node.dirs.get(folder);
      if (!next) {
        next = { dirs: new Map(), files: [], hidden: 0 };
        node.dirs.set(folder, next);
      }
      node = next;
    }
    if (folders.length >= depth) node.hidden++;
    else node.files.push(parts.at(-1)!);
  }
  const lines: string[] = [];
  const walk = (node: Node, indent: string) => {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${indent}${name}/`);
      walk(child, `${indent}  `);
    }
    for (const file of node.files.sort((a, b) => a.localeCompare(b)))
      lines.push(`${indent}${file}`);
    if (node.hidden) {
      lines.push(`${indent}… ${node.hidden} ${node.hidden === 1 ? 'file' : 'files'} further down`);
    }
  };
  walk(root, '');
  if (lines.length > MAX_LIST_LINES) {
    return `${lines.slice(0, MAX_LIST_LINES).join('\n')}\n… ${lines.length - MAX_LIST_LINES} more. List a subfolder to see them.`;
  }
  return lines.join('\n');
}

export const fsSearch = defineTool({
  name: 'fs_search',
  description:
    "Searches the contents of the workspace's files for a regular expression and lists matching lines as path:line:text. Skips what git ignores.",
  schema: z.object({
    pattern: z.string().min(1).describe('A regular expression, or plain text with literal: true'),
    path: z.string().optional().describe('Only search this folder or file'),
    glob: z.string().optional().describe('Only files matching this, such as *.ts'),
    literal: z.boolean().optional().describe('Match the pattern as plain text'),
    ignore_case: z.boolean().optional(),
  }),
  needs: ['workspace'],
  mutates: false,
  label: (args) => `Searching for \`${short(args.pattern, 40)}\``,
  approval: (args) => ({ kind: 'path', subject: args.path ?? '.', pattern: args.path ?? '.' }),
  async run(args, ctx) {
    const ws = workspaceOf(ctx);
    const { full } = locate(ctx, args.path ?? '.');
    const spec = toRelative(ws.cwd, full) || '.';
    const pathspec = args.glob
      ? `:(glob)${spec === '.' ? '' : `${spec}/`}${args.glob.includes('/') ? args.glob : `**/${args.glob}`}`
      : spec;
    const search = async (mode: string) =>
      runGit(
        [
          'grep',
          '-n',
          '-I',
          '--untracked',
          '--no-color',
          '--full-name',
          ...(args.ignore_case ? ['-i'] : []),
          mode,
          '-e',
          args.pattern,
          '--',
          pathspec,
        ],
        { cwd: ws.cwd, okCodes: [1], signal: ctx.signal },
      );
    let result;
    try {
      result = await search(args.literal ? '-F' : '-P');
    } catch (error) {
      // Not every git has Perl regular expressions.
      if (!args.literal && /pcre|perl/i.test(String(error))) result = await search('-E');
      else throw new ToolFailure(`The search failed: ${(error as Error).message}`);
    }
    if (result.exitCode === 1) return { content: `No matches for ${args.pattern}.` };
    const prefix = toRelative(ws.root, ws.cwd);
    const lines = result.stdout
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      // --full-name prints paths from the worktree root; show them from the chat's folder.
      .map((line) =>
        prefix && line.startsWith(`${prefix}/`) ? line.slice(prefix.length + 1) : line,
      )
      .map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line));
    const shown = lines.slice(0, MAX_MATCHES).join('\n');
    const more =
      lines.length > MAX_MATCHES
        ? `\n… ${lines.length - MAX_MATCHES} more. Narrow the search.`
        : '';
    return { content: headOnly(`${shown}${more}`, ctx.maxChars, 'Cut to fit. Narrow the search.') };
  },
});

export const fsWrite = defineTool({
  name: 'fs_write',
  description:
    'Writes a whole file, creating it and its folders if needed. For changing part of a file, use fs_edit.',
  schema: z.object({ path: pathArg, content: z.string().describe("The file's full new text") }),
  needs: ['workspace'],
  mutates: true,
  label: (args) => `Writing \`${short(args.path)}\``,
  approval: (args) => ({ kind: 'path', subject: args.path, pattern: args.path }),
  run(args, ctx) {
    const { full, rel } = locate(ctx, args.path);
    if (existsSync(full) && statSync(full).isDirectory()) {
      throw new ToolFailure(`${rel} is a folder.`);
    }
    const existed = existsSync(full);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, args.content);
    const lines = args.content === '' ? 0 : args.content.split('\n').length;
    return Promise.resolve({
      content: `${existed ? 'Replaced' : 'Created'} ${rel} (${lines} ${lines === 1 ? 'line' : 'lines'}).`,
    });
  },
});

export const fsEdit = defineTool({
  name: 'fs_edit',
  description:
    'Changes part of a file: replaces old_string with new_string. old_string must match the file exactly, whitespace included, and only once unless replace_all is true. Read the file first.',
  schema: z.object({
    path: pathArg,
    old_string: z
      .string()
      .min(1)
      .describe('The exact text to replace, with enough lines around it to be unique'),
    new_string: z.string().describe('The text to put in its place'),
    replace_all: z.boolean().optional().describe('Replace every match, not just one'),
  }),
  needs: ['workspace'],
  mutates: true,
  label: (args) => `Editing \`${short(args.path)}\``,
  approval: (args) => ({ kind: 'path', subject: args.path, pattern: args.path }),
  run(args, ctx) {
    const { full, rel } = locate(ctx, args.path);
    if (!existsSync(full)) {
      throw new ToolFailure(`There's no file at ${rel}. Use fs_write to create it.`);
    }
    const before = readFileSync(full, 'utf8');
    let find = args.old_string;
    let replace = args.new_string;
    // Models write \n; a file written on Windows may use \r\n.
    if (!before.includes(find) && before.includes('\r\n') && find.includes('\n')) {
      find = find.replace(/\r?\n/g, '\r\n');
      replace = replace.replace(/\r?\n/g, '\r\n');
    }
    const count = before.split(find).length - 1;
    if (count === 0) {
      throw new ToolFailure(
        `old_string isn't in ${rel}. Read the file again and copy the text exactly, whitespace included.`,
      );
    }
    if (count > 1 && !args.replace_all) {
      throw new ToolFailure(
        `old_string is in ${rel} ${count} times. Include more of the lines around it so it's unique, or set replace_all.`,
      );
    }
    const after = args.replace_all
      ? before.split(find).join(replace)
      : before.replace(find, () => replace);
    if (after === before)
      return Promise.resolve({ content: `${rel} already says that; nothing changed.` });
    writeFileSync(full, after);
    const ranges = changedRanges(before, after)
      .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`))
      .join(', ');
    return Promise.resolve({
      content: `Edited ${rel}${count > 1 ? ` (${count} places)` : ''}. Changed lines: ${ranges}.`,
    });
  },
});

export const FILE_TOOLS = [fsRead, fsList, fsSearch, fsWrite, fsEdit];
