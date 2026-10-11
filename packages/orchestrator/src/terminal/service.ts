import type { TerminalSession } from '@clanks/core';
import type { CommandResult, ShellAccess } from '@clanks/tools';
import {
  type CommandHandle,
  type PtyHandle,
  type Sandbox,
  commandEnv,
  commandShell,
  headTail,
  jobsReady,
  markedExecArgs,
  openPty,
  plainOutput,
  runCommand,
  scrubbedEnv,
  stopMarked,
  userShell,
  withJobsStopped,
} from '@clanks/workspace';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** What a session keeps of its output for the terminal pane. Older output scrolls away. */
const MAX_BUFFER = 2 * 1024 * 1024;
/** How long `shell_start` waits for a server's first words. */
const START_WAIT_MS = 4000;

interface Session {
  info: TerminalSession;
  /** Short and per chat, for the model: `p1`, `p2`. */
  handle: string;
  buffer: string;
  /** Characters ever written, and how far the clank has read, for `shell_output`. */
  written: number;
  read: number;
  command: CommandHandle | null;
  pty: PtyHandle | null;
  done: Promise<void>;
  /** How a command ended, once it has. */
  reason: CommandResult['reason'];
}

/**
 * Every command the clanks run, and the user's own shells, per chat. Clanks' commands run with
 * piped output; the user's shell runs in a real terminal. Emits `sessions` when a chat's list
 * changes and `output` as anything prints.
 */
export class TerminalService extends EventEmitter<{
  sessions: [conversationId: string];
  output: [conversationId: string, sessionId: string, data: string];
}> {
  private readonly sessions = new Map<string, Session>();
  private readonly counters = new Map<string, number>();

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  list(conversationId: string): TerminalSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.info.conversationId === conversationId)
      .map((s) => ({ ...s.info }));
  }

  /** What a session has printed, as far back as it's kept. */
  output(sessionId: string): string {
    return this.sessions.get(sessionId)?.buffer ?? '';
  }

  /** Commands for one tool call: its sessions show it ran them. */
  shellFor(options: {
    conversationId: string;
    cwd: string;
    toolCallId: string;
    maxChars: number;
    /** A Docker container to run commands in, rather than on this computer. */
    sandbox?: Sandbox | null;
    /** Variables commands get besides the usual, such as the port a run's servers use. */
    env?: Record<string, string>;
  }): Promise<ShellAccess> {
    // On Windows a command's processes are held in a job, which a helper makes: the first
    // command of a session waits a moment for it to start.
    return Promise.all([commandShell(), jobsReady()]).then(([shell]) => {
      const find = (handle: string) =>
        [...this.sessions.values()].find(
          (s) => s.info.conversationId === options.conversationId && s.handle === handle,
        );
      // Output the clank hasn't seen: everything after the command line, then whatever's new.
      const result = (session: Session): CommandResult => {
        const bufferStart = session.written - session.buffer.length;
        const text = session.buffer.slice(Math.max(0, session.read - bufferStart));
        session.read = session.written;
        const running = session.info.state === 'running';
        return {
          handle: session.handle,
          sessionId: session.info.id,
          output: headTail(plainOutput(text), options.maxChars),
          running,
          exitCode: session.info.exitCode,
          reason: running ? null : session.reason,
        };
      };
      const begin = (command: string, background: boolean, timeoutMs?: number) => {
        const session = this.add(options.conversationId, {
          kind: 'clank',
          title: command,
          cwd: options.cwd,
          background,
          toolCallId: options.toolCallId,
        });
        const sandbox = options.sandbox ?? null;
        // In a container, a marker in the command line lets it be stopped there too.
        const marker = sandbox ? `clanks-cmd-${randomUUID().slice(0, 12)}` : null;
        const handle = runCommand({
          command: background
            ? command
            : withJobsStopped(
                command,
                sandbox ? { name: 'bash' } : shell,
                sandbox ? 'linux' : process.platform,
              ),
          cwd: options.cwd,
          shell: sandbox
            ? {
                name: 'bash',
                file: 'docker',
                verbatim: false,
                args: (wrapped) => markedExecArgs(sandbox, wrapped, marker!),
              }
            : shell,
          env: commandEnv(options.env),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          onOutput: (text) => this.write(session, text),
        });
        session.command = sandbox
          ? {
              ...handle,
              stop: () => {
                handle.stop();
                void stopMarked(sandbox, marker!);
              },
            }
          : handle;
        session.done = handle.done.then((exit) => {
          session.info.exitCode = exit.exitCode;
          session.info.state =
            exit.reason === 'exited' ? 'exited' : exit.reason === 'error' ? 'failed' : 'stopped';
          session.reason = exit.reason;
          if (exit.error) this.write(session, `\n${exit.error}\n`);
          if (exit.lingered && exit.reason === 'exited') {
            this.write(
              session,
              '\n[It left something running in the background, which was stopped. Start servers and watchers with shell_start, so they keep running.]\n',
            );
          }
          this.finish(session);
        });
        return session;
      };
      return {
        name: shell.name,
        async exec(command, { timeoutMs, signal }) {
          const session = begin(command, false, timeoutMs);
          const stop = () => session.command?.stop();
          signal.addEventListener('abort', stop, { once: true });
          await session.done;
          signal.removeEventListener('abort', stop);
          return result(session);
        },
        async start(command, { signal }) {
          const session = begin(command, true);
          await Promise.race([
            session.done,
            new Promise((resolve) => setTimeout(resolve, START_WAIT_MS)),
            new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
          ]);
          return result(session);
        },
        output: (handle) => {
          const session = find(handle);
          return session ? result(session) : null;
        },
        stop: async (handle) => {
          const session = find(handle);
          if (!session) return null;
          session.command?.stop();
          await Promise.race([session.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
          return result(session);
        },
      };
    });
  }

  /** Opens the user's own shell in a chat's worktree. */
  async openShell(options: {
    conversationId: string;
    cwd: string;
    cols: number;
    rows: number;
  }): Promise<TerminalSession> {
    const session = this.add(options.conversationId, {
      kind: 'user',
      title: 'Your shell',
      cwd: options.cwd,
      background: true,
      toolCallId: null,
    });
    const { file, args } = userShell();
    let exited!: () => void;
    session.done = new Promise((resolve) => (exited = resolve));
    try {
      session.pty = await openPty({
        file,
        args,
        cwd: options.cwd,
        env: scrubbedEnv(),
        cols: options.cols,
        rows: options.rows,
        onData: (data) => this.write(session, data),
        onExit: (code) => {
          session.info.exitCode = code;
          session.info.state = 'exited';
          this.finish(session);
          exited();
        },
      });
    } catch (error) {
      session.info.state = 'failed';
      this.write(
        session,
        `Couldn't start ${file}: ${error instanceof Error ? error.message : String(error)}\r\n`,
      );
      this.finish(session);
      exited();
    }
    return { ...session.info };
  }

  /** Keys typed into the user's shell. Clanks' commands take no input. */
  input(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.pty?.resize(cols, rows);
  }

  /** Stops a command, or closes the user's shell. */
  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.command?.stop();
    session?.pty?.kill();
  }

  /** Forgets finished sessions, so the list doesn't grow forever. */
  clear(conversationId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.info.conversationId === conversationId && session.info.state !== 'running') {
        this.sessions.delete(id);
      }
    }
    this.emit('sessions', conversationId);
  }

  /** Stops the commands a clank left running in a chat, such as a dev server, when its run ends. */
  stopBackground(conversationId: string): void {
    for (const session of this.sessions.values()) {
      if (
        session.info.conversationId === conversationId &&
        session.info.kind === 'clank' &&
        session.info.state === 'running'
      ) {
        session.command?.stop();
      }
    }
  }

  /** Stops everything a chat started, when it's deleted or its folder changes. */
  closeConversation(conversationId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.info.conversationId !== conversationId) continue;
      session.command?.stop();
      session.pty?.kill();
      this.sessions.delete(id);
    }
    this.emit('sessions', conversationId);
  }

  /** Stops everything, for quitting. */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.command?.stop();
      session.pty?.kill();
    }
    this.sessions.clear();
  }

  private add(
    conversationId: string,
    info: Pick<TerminalSession, 'kind' | 'title' | 'cwd' | 'background' | 'toolCallId'>,
  ): Session {
    const count = (this.counters.get(conversationId) ?? 0) + 1;
    this.counters.set(conversationId, count);
    const session: Session = {
      info: {
        ...info,
        id: randomUUID(),
        conversationId,
        state: 'running',
        exitCode: null,
        startedAt: new Date(),
        endedAt: null,
      },
      handle: `p${count}`,
      buffer: '',
      written: 0,
      read: 0,
      command: null,
      pty: null,
      done: Promise.resolve(),
      reason: null,
    };
    this.sessions.set(session.info.id, session);
    if (info.kind === 'clank') {
      // The command line, as a terminal would show it.
      this.write(session, `\u001b[2m$ ${info.title}\u001b[0m\r\n`, false);
    }
    this.emit('sessions', conversationId);
    return session;
  }

  private write(session: Session, text: string, counts = true): void {
    if (!text) return;
    // Piped output has bare \n; a terminal needs \r\n to start the next line at the left.
    const shown = session.pty ? text : text.replace(/\r?\n/g, '\r\n');
    session.buffer += shown;
    if (session.buffer.length > MAX_BUFFER) {
      session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER);
    }
    session.written += shown.length;
    if (!counts) session.read = session.written;
    this.emit('output', session.info.conversationId, session.info.id, shown);
  }

  private finish(session: Session): void {
    session.info.endedAt = new Date();
    session.command = null;
    session.pty = null;
    this.emit('sessions', session.info.conversationId);
  }
}
