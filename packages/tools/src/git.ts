import { GitError, git, headTail, identity, runGit } from '@clanks/workspace';
import { z } from 'zod';
import { type ToolContext, ToolFailure, type WorkspaceAccess, defineTool, short } from './spec';

function workspaceOf(ctx: ToolContext): WorkspaceAccess {
  if (!ctx.workspace) throw new ToolFailure('This chat has no workspace, so there is no git.');
  return ctx.workspace;
}

async function inWorkspace(ctx: ToolContext, args: string[], okCodes?: number[]): Promise<string> {
  try {
    const result = await runGit(args, {
      cwd: workspaceOf(ctx).cwd,
      signal: ctx.signal,
      ...(okCodes ? { okCodes } : {}),
    });
    return result.stdout.toString('utf8').trimEnd();
  } catch (error) {
    if (error instanceof GitError) throw new ToolFailure(error.stderr || error.message);
    throw error;
  }
}

export const gitStatus = defineTool({
  name: 'git_status',
  description: 'Shows the branch and which files are changed, staged or new.',
  schema: z.object({}),
  needs: ['workspace'],
  mutates: false,
  label: () => 'Checking git status',
  approval: () => ({ kind: 'tool', subject: 'git status', pattern: '*' }),
  async run(_args, ctx) {
    const ws = workspaceOf(ctx);
    const status = await inWorkspace(ctx, ['status', '--short', '--branch']);
    return {
      content: `${status}\n\nYour branch ${ws.branch} started from ${ws.baseCommit.slice(0, 7)}.`,
    };
  },
});

export const gitDiff = defineTool({
  name: 'git_diff',
  description:
    "Shows changes as a diff. against: 'head' for changes not committed yet (the default), 'staged' for what's staged, or 'base' for everything changed on your branch, commits included.",
  schema: z.object({
    against: z.enum(['head', 'staged', 'base']).optional(),
    path: z.string().optional().describe('Only this file or folder'),
  }),
  needs: ['workspace'],
  mutates: false,
  label: (args) => (args.path ? `Diffing \`${short(args.path)}\`` : 'Reading the diff'),
  approval: () => ({ kind: 'tool', subject: 'git diff', pattern: '*' }),
  async run(args, ctx) {
    const ws = workspaceOf(ctx);
    const against = args.against ?? 'head';
    const target =
      against === 'staged' ? ['--cached'] : against === 'base' ? [ws.baseCommit] : ['HEAD'];
    const paths = args.path ? ['--', args.path] : [];
    const diff = await inWorkspace(ctx, [
      'diff',
      '--no-color',
      '--no-ext-diff',
      ...target,
      ...paths,
    ]);
    // A diff leaves out files git doesn't track yet.
    const untracked =
      against === 'staged'
        ? ''
        : await inWorkspace(ctx, ['ls-files', '--others', '--exclude-standard', ...paths]);
    const parts = [diff || 'No changes.'];
    if (untracked) parts.push(`New files, not in the diff (read them with fs_read):\n${untracked}`);
    return { content: headTail(parts.join('\n\n'), ctx.maxChars) };
  },
});

export const gitLog = defineTool({
  name: 'git_log',
  description: 'Lists recent commits on your branch, newest first.',
  schema: z.object({
    limit: z.number().int().min(1).max(100).optional().describe('How many. Default 15'),
    path: z.string().optional().describe('Only commits that touched this file or folder'),
  }),
  needs: ['workspace'],
  mutates: false,
  label: () => 'Reading the git log',
  approval: () => ({ kind: 'tool', subject: 'git log', pattern: '*' }),
  async run(args, ctx) {
    const log = await inWorkspace(ctx, [
      'log',
      '--no-color',
      '--date=short',
      '--pretty=format:%h %ad %an: %s',
      '-n',
      String(args.limit ?? 15),
      ...(args.path ? ['--', args.path] : []),
    ]);
    return { content: log || 'No commits yet.' };
  },
});

export const gitCommit = defineTool({
  name: 'git_commit',
  description:
    'Commits changes on your branch: every change, or only the paths you list. Write a summary line under 72 characters, then a line on why.',
  schema: z.object({
    message: z.string().min(1).describe('The commit message'),
    paths: z.array(z.string().min(1)).optional().describe('Only commit these files'),
  }),
  needs: ['workspace'],
  mutates: false,
  label: (args) => `Committing "${short(args.message.split('\n')[0]!, 50)}"`,
  approval: (args) => ({ kind: 'tool', subject: args.message.split('\n')[0]!, pattern: '*' }),
  async run(args, ctx) {
    const ws = workspaceOf(ctx);
    await inWorkspace(ctx, ['add', ...(args.paths?.length ? ['--', ...args.paths] : ['-A'])]);
    const staged = await runGit(['diff', '--cached', '--quiet'], { cwd: ws.cwd, okCodes: [1] });
    if (staged.exitCode === 0) return { content: 'Nothing to commit: no changes are staged.' };
    // The clank is the author; the user, as git knows them, commits.
    const env = {
      ...(await identity(ws.cwd, { name: 'clanks', email: 'clanks@localhost' })),
      GIT_AUTHOR_NAME: `${ctx.clank.name} (clanks)`,
      GIT_AUTHOR_EMAIL: `${ctx.clank.id}@clanks.local`,
    };
    try {
      await git(['commit', '--quiet', '-m', args.message], {
        cwd: ws.cwd,
        env,
        signal: ctx.signal,
      });
    } catch (error) {
      if (error instanceof GitError) throw new ToolFailure(error.stderr || error.message);
      throw error;
    }
    const summary = await inWorkspace(ctx, ['log', '-1', '--no-color', '--stat', '--format=%h %s']);
    return { content: `Committed on ${ws.branch}:\n\n${summary}` };
  },
});

export const GIT_TOOLS = [gitStatus, gitDiff, gitLog, gitCommit];
