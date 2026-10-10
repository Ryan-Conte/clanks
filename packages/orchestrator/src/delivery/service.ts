import {
  type Project,
  REPO_HOST_NAMES,
  type RepoHost,
  type Ticket,
  type TicketDelivery,
  type TicketPullRequest,
  pullRequestName,
} from '@clanks/core';
import {
  GitError,
  MergeBlockedError,
  MergeConflictError,
  currentBranch,
  git,
  isAncestor,
  mergeBranch,
  repoInfo,
  resolveCommit,
  worktreeOf,
} from '@clanks/workspace';
import type { RepoHostClient } from '../repos/host';
import type { WorkspaceService } from '../workspace/service';

/** A delivery problem worded for the user: a conflict, a push the host turned down. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    /** Files that conflict with the base, when that's what went wrong. */
    readonly conflicts: string[] = [],
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** How long where work starts is remembered. */
const START_TTL_MS = 30_000;

/** Where a project's new work starts. */
export interface WorkStart {
  /** The base branch's name. */
  base: string;
  /** The ref new branches start from: the base, or the host's copy of it. */
  from: string;
  /** The repository's top folder. */
  root: string;
}

export interface DeliveryServiceOptions {
  /** Where a project's repository is hosted: GitHub or GitLab. */
  hosts: (host: RepoHost) => RepoHostClient;
  workspace: WorkspaceService;
  /** Where scratch worktrees for merges go. */
  scratchDir: string;
}

/**
 * Where tickets' work goes: the branch a maker starts from, what it hands in, the pull request the
 * app opens for it on GitHub (or merge request on GitLab), and the merge when the user approves. Only the app does these, never
 * a clank: pushing is part of handing in, and merging waits for the user.
 */
export class DeliveryService {
  /** One merge at a time per repository, so two approvals can't race for the base branch. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Where work starts, per project, for a short while: finding out may mean asking the host. */
  private readonly starts = new Map<string, { at: number; start: Promise<WorkStart> }>();

  constructor(private readonly options: DeliveryServiceOptions) {}

  /**
   * The project's base branch, and the commit new work starts from: the branch in the project's
   * folder, or the host's copy of it when that's further on, as after a pull request is merged there.
   */
  start(project: Project): Promise<WorkStart> {
    const key = `${project.id}:${project.baseBranch ?? ''}`;
    const cached = this.starts.get(key);
    if (cached && Date.now() - cached.at < START_TTL_MS) return cached.start;
    const start = this.findStart(project);
    this.starts.set(key, { at: Date.now(), start });
    start.catch(() => this.starts.delete(key));
    return start;
  }

  /** Forgets where work starts, after a merge moves the base. */
  private forget(project: Project): void {
    for (const key of this.starts.keys()) {
      if (key.startsWith(`${project.id}:`)) this.starts.delete(key);
    }
  }

  private async findStart(project: Project): Promise<WorkStart> {
    const root = await this.root(project);
    const base = await this.baseBranch(project, root);
    const local = await resolveCommit(root, `refs/heads/${base}`);
    let from = local ? `refs/heads/${base}` : null;
    const host = this.hostOf(project);
    if (host?.signedIn()) {
      try {
        await host.fetch(root, base);
        const remote = await resolveCommit(root, `refs/remotes/origin/${base}`);
        if (remote && (!local || (await isAncestor(root, local, remote)))) {
          from = `refs/remotes/origin/${base}`;
        }
      } catch {
        // Offline, or the host is having a moment: the local branch will do.
      }
    }
    if (!from) {
      throw new DeliveryError(
        `There's no branch called ${base} in ${project.folder}. Pick the base branch in the project's settings.`,
      );
    }
    return { base, from, root };
  }

  /**
   * A maker hands in: whatever it left uncommitted goes on its branch, as its own commit, and the
   * branch's state is recorded. Pushing and the pull request come after, in `publish`.
   */
  async handIn(input: {
    project: Project;
    ticket: Ticket;
    conversationId: string;
    maker: { id: string; name: string };
    /** What the commit says, when it isn't the maker's own leftovers. */
    message?: string;
  }): Promise<TicketDelivery | null> {
    const { project, ticket, maker } = input;
    const left = await this.options.workspace.commitLeftovers(
      input.conversationId,
      input.message ?? `Work left by ${maker.name} on ${ticket.key}`,
      { name: `${maker.name} (clanks)`, email: `${maker.id}@clanks.local` },
    );
    if (!left) return null;
    const root = await this.root(project);
    const base = await this.baseBranch(project, root);
    const baseTip =
      (await resolveCommit(root, `refs/heads/${base}`)) ??
      (await resolveCommit(root, `refs/remotes/origin/${base}`));
    const changed = baseTip ? !(await isAncestor(root, left.head, baseTip)) : true;
    const previous = ticket.delivery;
    return {
      branch: left.branch,
      base,
      head: left.head,
      changed,
      pushedAt: previous?.pushedAt ?? null,
      pr: previous?.pr ?? null,
      merged: null,
      error: null,
    };
  }

  /**
   * Pushes a ticket's branch to its host and opens its pull request, or brings the open one up to
   * date. Does nothing for a local folder, or a branch with nothing new on it.
   */
  async publish(input: {
    project: Project;
    ticket: Ticket;
    delivery: TicketDelivery;
    title: string;
    body: string;
  }): Promise<TicketDelivery> {
    const { project, delivery } = input;
    const host = this.hostOf(project);
    if (!project.repo || !host || !delivery.changed) return delivery;
    const root = await this.root(project);
    try {
      await host.push(root, delivery.branch);
      const pr = await host.openPullRequest({
        repo: project.repo.fullName,
        head: delivery.branch,
        base: delivery.base,
        title: input.title,
        body: input.body,
      });
      return {
        ...delivery,
        pushedAt: new Date().toISOString(),
        pr: { number: pr.number, url: pr.url, state: pr.state, ci: delivery.pr?.ci ?? null },
        error: null,
      };
    } catch (error) {
      return { ...delivery, error: messageOf(error) };
    }
  }

  /**
   * Merges a ticket's work into its base, now the user has approved it: its pull request on
   * its host, or its branch in the project's folder. Returns the merge commit, or null when there was
   * nothing to merge.
   */
  async merge(project: Project, ticket: Ticket): Promise<{ commit: string; how: string } | null> {
    const delivery = ticket.delivery;
    if (!delivery?.changed) return null;
    const root = await this.root(project);
    this.forget(project);
    try {
      return await this.lock(root, async () => {
        const message = `Merge ${ticket.key}: ${ticket.title}`;
        if (project.repo && delivery.pr) {
          const repo = project.repo.fullName;
          const github = this.options.hosts(project.repo.host);
          const named = pullRequestName(project.repo.host, delivery.pr.number);
          let pull = await github.pullRequest(repo, delivery.pr.number);
          if (pull.state === 'closed') {
            throw new DeliveryError(
              `${named} was closed on ${REPO_HOST_NAMES[project.repo.host]}. Reopen it, then approve again.`,
            );
          }
          let sha: string;
          if (pull.state === 'merged') {
            sha = pull.head;
          } else {
            // Anything handed in since the last push goes up first.
            const tip = await resolveCommit(root, `refs/heads/${delivery.branch}`);
            if (tip && tip !== pull.head) {
              await github.push(root, delivery.branch);
              pull = await github.pullRequest(repo, delivery.pr.number);
            }
            try {
              sha = await github.mergePullRequest(repo, pull.number, message);
            } catch (error) {
              const conflict =
                pull.mergeable === false || /not mergeable|conflict/i.test(messageOf(error));
              throw new DeliveryError(
                conflict
                  ? `${named} conflicts with ${delivery.base}. Send it back to have the conflicts resolved.`
                  : messageOf(error),
                conflict ? [`(see the ${pullRequestName(project.repo.host)})`] : [],
              );
            }
          }
          await this.catchUp(project, root, delivery.base);
          return { commit: sha, how: `merged ${named}` };
        }
        try {
          const result = await mergeBranch({
            repoRoot: root,
            base: delivery.base,
            branch: delivery.branch,
            message,
            scratchDir: this.options.scratchDir,
          });
          return {
            commit: result.commit,
            how: result.already
              ? `found ${delivery.branch} already in ${delivery.base}`
              : `merged ${delivery.branch} into ${delivery.base}`,
          };
        } catch (error) {
          if (error instanceof MergeConflictError) {
            throw new DeliveryError(
              `${ticket.key} conflicts with ${delivery.base} in ${error.files.join(', ') || 'some files'}. Send it back to have the conflicts resolved.`,
              error.files,
            );
          }
          if (error instanceof MergeBlockedError) throw new DeliveryError(error.message);
          throw new DeliveryError(messageOf(error));
        }
      });
    } finally {
      this.forget(project);
    }
  }

  /** Closes a rejected ticket's pull request, if it has one. Best effort. */
  async close(project: Project, ticket: Ticket): Promise<void> {
    const pr = ticket.delivery?.pr;
    const host = this.hostOf(project);
    if (!project.repo || !host || !pr || pr.state !== 'open') return;
    await host.closePullRequest(project.repo.fullName, pr.number).catch(() => {});
  }

  /**
   * Merges the latest base into a ticket's branch in its maker's worktree, leaving conflicts for
   * the maker to resolve. Returns the files with conflicts.
   */
  async mergeBaseInto(project: Project, conversationId: string): Promise<string[]> {
    const { from } = await this.start(project);
    try {
      return await this.options.workspace.mergeInto(conversationId, from);
    } catch (error) {
      throw new DeliveryError(messageOf(error));
    }
  }

  /** How the checks on a ticket's pull request are doing now, and whether it was merged. */
  async refresh(project: Project, ticket: Ticket): Promise<TicketPullRequest | null> {
    const pr = ticket.delivery?.pr;
    const host = this.hostOf(project);
    if (!project.repo || !host || !pr) return null;
    const pull = await host.pullRequest(project.repo.fullName, pr.number);
    const ci = pull.head ? await host.checks(project.repo.fullName, pull.head) : null;
    return { number: pull.number, url: pull.url, state: pull.state, ci };
  }

  /** The base branch: the project's choice, or what its folder has checked out. */
  private async baseBranch(project: Project, root: string): Promise<string> {
    if (project.baseBranch) return project.baseBranch;
    const checkedOut = await currentBranch(project.folder).catch(() => null);
    if (checkedOut && !checkedOut.startsWith('clanks/')) return checkedOut;
    for (const name of ['main', 'master']) {
      if (await resolveCommit(root, `refs/heads/${name}`)) return name;
    }
    throw new DeliveryError(
      `${project.folder} has no branch checked out. Pick the base branch in the project's settings.`,
    );
  }

  /** After a merge on the host, the user's checkout of the base gets it too, where that's safe. */
  private async catchUp(project: Project, root: string, base: string): Promise<void> {
    try {
      await this.hostOf(project)?.fetch(root, base);
      const remote = await resolveCommit(root, `refs/remotes/origin/${base}`);
      const local = await resolveCommit(root, `refs/heads/${base}`);
      if (!remote || !local || !(await isAncestor(root, local, remote))) return;
      const checkout = await worktreeOf(root, base);
      if (checkout) await git(['merge', '--ff-only', '--quiet', remote], { cwd: checkout });
      else await git(['update-ref', `refs/heads/${base}`, remote, local], { cwd: root });
    } catch {
      // The user's checkout has changes in the way, or the fetch failed: they'll pull themselves.
    }
  }

  /** Where the project's repository is hosted. Null for a local folder. */
  private hostOf(project: Project): RepoHostClient | null {
    return project.repo ? this.options.hosts(project.repo.host) : null;
  }

  private async root(project: Project): Promise<string> {
    const info = await repoInfo(project.folder).catch(() => null);
    if (!info) throw new DeliveryError(`${project.folder} isn't a git repository any more`);
    return info.root;
  }

  private lock<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    const settled = next.catch(() => {});
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof GitError)
    return error.stderr.split('\n').find((l) => l.trim()) ?? error.message;
  return error instanceof Error ? error.message : String(error);
}
