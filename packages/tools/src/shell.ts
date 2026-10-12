import { z } from 'zod';
import { redactCommand } from './redact';
import { commandRisk } from './risk';
import {
  type CommandResult,
  type ShellAccess,
  type ToolContext,
  ToolFailure,
  defineTool,
  short,
} from './spec';

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

function shellOf(ctx: ToolContext): ShellAccess {
  if (!ctx.shell) throw new ToolFailure('This chat has no workspace to run commands in.');
  return ctx.shell;
}

/** A command's result as the model reads it: the output, then how it ended. */
export function describeResult(result: CommandResult, timeoutS?: number): string {
  const output = result.output.trimEnd() || '(no output)';
  let status: string;
  if (result.running) status = `Still running as ${result.handle}.`;
  else if (result.reason === 'timeout') {
    status = `Stopped after ${timeoutS ?? '?'} seconds: it ran too long. For servers and watchers use shell_start.`;
  } else if (result.reason === 'stopped') status = 'Stopped before it finished.';
  else if (result.reason === 'error') status = "It couldn't start.";
  else status = `Exit code ${result.exitCode ?? 'unknown'}.`;
  return `${output}\n\n[${status}]`;
}

const commandArg = z.string().min(1).describe('The command line');

export const shellExec = defineTool({
  name: 'shell_exec',
  description:
    'Runs a command in the workspace and waits for it, returning its output and exit code. Commands get no input, so they must not prompt. Use shell_start for servers, watchers and anything that keeps running.',
  schema: z.object({
    command: commandArg,
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_S)
      .optional()
      .describe(`Stop it after this long. Default ${DEFAULT_TIMEOUT_S}`),
  }),
  needs: ['workspace', 'shell'],
  mutates: true,
  label: (args) => `Running \`${short(redactCommand(args.command))}\``,
  approval: (args) => ({ kind: 'command', subject: args.command, pattern: args.command }),
  risk: (args, ctx) => commandRisk(args.command, ctx),
  async run(args, ctx) {
    const timeoutS = args.timeout_seconds ?? DEFAULT_TIMEOUT_S;
    const result = await shellOf(ctx).exec(args.command, {
      timeoutMs: timeoutS * 1000,
      signal: ctx.signal,
    });
    return {
      content: describeResult(result, timeoutS),
      error: result.reason !== 'exited' || result.exitCode !== 0,
      sessionId: result.sessionId,
    };
  },
});

export const shellStart = defineTool({
  name: 'shell_start',
  description:
    'Starts a command that keeps running, such as a dev server or a watcher, and returns a handle and its first output. Read more with shell_output; stop it with shell_stop when you are done.',
  schema: z.object({ command: commandArg }),
  needs: ['workspace', 'shell'],
  mutates: true,
  label: (args) => `Starting \`${short(redactCommand(args.command))}\``,
  approval: (args) => ({ kind: 'command', subject: args.command, pattern: args.command }),
  risk: (args, ctx) => commandRisk(args.command, ctx),
  async run(args, ctx) {
    const result = await shellOf(ctx).start(args.command, { signal: ctx.signal });
    const intro = result.running
      ? `Started as ${result.handle}. Output so far:`
      : `It ended straight away (handle ${result.handle}):`;
    return {
      content: `${intro}\n\n${describeResult(result)}`,
      error: !result.running && result.exitCode !== 0,
      sessionId: result.sessionId,
    };
  },
});

const handleArg = z.string().min(1).describe('The handle shell_start gave, such as p1');

export const shellOutput = defineTool({
  name: 'shell_output',
  description: 'Returns what a command started with shell_start printed since you last looked.',
  schema: z.object({ handle: handleArg }),
  needs: ['shell'],
  mutates: false,
  label: (args) => `Reading the output of ${short(args.handle, 20)}`,
  approval: (args) => ({ kind: 'tool', subject: args.handle, pattern: '*' }),
  run(args, ctx) {
    const result = shellOf(ctx).output(args.handle);
    if (!result) throw new ToolFailure(`There's no command ${args.handle}.`);
    return Promise.resolve({ content: describeResult(result), sessionId: result.sessionId });
  },
});

export const shellStop = defineTool({
  name: 'shell_stop',
  description: 'Stops a command started with shell_start, and everything it started.',
  schema: z.object({ handle: handleArg }),
  needs: ['shell'],
  mutates: false,
  label: (args) => `Stopping ${short(args.handle, 20)}`,
  approval: (args) => ({ kind: 'tool', subject: args.handle, pattern: '*' }),
  async run(args, ctx) {
    const result = await shellOf(ctx).stop(args.handle);
    if (!result) throw new ToolFailure(`There's no command ${args.handle}.`);
    return {
      content: `Stopped ${args.handle}.\n\n${describeResult(result)}`,
      sessionId: result.sessionId,
    };
  },
});

export const SHELL_TOOLS = [shellExec, shellStart, shellOutput, shellStop];
