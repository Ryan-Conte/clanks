import type { RunInfo, Sandbox as SandboxSettings } from '@clanks/core';
import {
  type DockerStatus,
  type Sandbox,
  containerName,
  docker,
  dockerStatus,
  ensureContainer,
  removeContainer,
} from '@clanks/workspace';
import { posix, relative, sep } from 'node:path';

/** How long Docker's status is trusted before asking again. */
const STATUS_TTL_MS = 30_000;

/** A sandbox problem worded for the clank and the user, such as Docker not running. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * The Docker containers runs' commands go in, when a project asks for them: one per run, with only
 * its worktree mounted and the network off unless the project allows it. Files, git and the model
 * stay with the app either way, so a container never sees a key.
 */
export class SandboxService {
  private status: { at: number; status: Promise<DockerStatus> } | null = null;
  /** The containers started, by conversation. */
  private readonly started = new Map<string, string>();
  private cleaned = false;

  /** Whether Docker is installed and running, asked at most every half minute. */
  docker(): Promise<DockerStatus> {
    if (this.status && Date.now() - this.status.at < STATUS_TTL_MS) return this.status.status;
    const status = dockerStatus();
    this.status = { at: Date.now(), status };
    return status;
  }

  /** A run's container, started if it isn't, and where its commands run in it. */
  async forRun(conversationId: string, run: RunInfo, settings: SandboxSettings): Promise<Sandbox> {
    const status = await this.docker();
    if (!status.running) {
      this.status = null;
      throw new SandboxError(
        `This project runs commands in Docker, and ${status.problem ?? "Docker isn't available"}. Nothing ran. Ask the user to start Docker, or to run commands on this computer in the project's settings.`,
      );
    }
    if (!this.cleaned) {
      this.cleaned = true;
      await this.cleanUp();
    }
    const name = containerName(run.id);
    try {
      await ensureContainer({
        name,
        worktree: run.worktree,
        image: settings.image,
        network: settings.network,
      });
    } catch (error) {
      throw new SandboxError(error instanceof Error ? error.message : String(error));
    }
    this.started.set(conversationId, name);
    const sub = relative(run.worktree, run.cwd).split(sep).filter(Boolean);
    return { container: name, workdir: posix.join('/work', ...sub) };
  }

  /** Removes a conversation's container, when its run ends or the chat goes. */
  async remove(conversationId: string): Promise<void> {
    const name = this.started.get(conversationId);
    if (!name) return;
    this.started.delete(conversationId);
    await removeContainer(name).catch(() => {});
  }

  /** Removes every container this app started, for quitting. Doesn't wait. */
  closeAll(): void {
    for (const name of this.started.values()) void removeContainer(name).catch(() => {});
    this.started.clear();
  }

  /** Containers a crashed app left behind go when Docker is first used again. */
  private async cleanUp(): Promise<void> {
    const listed = await docker(['ps', '--all', '--quiet', '--filter', 'label=clanks=run']);
    const ids = listed.stdout.split('\n').filter(Boolean);
    if (ids.length > 0) await docker(['rm', '--force', ...ids]);
  }
}
