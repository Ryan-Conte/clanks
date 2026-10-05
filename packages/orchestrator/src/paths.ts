import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where everything lives under the app data folder. See docs/PLAN.md, "App data". */
export interface AppDataLayout {
  root: string;
  /** SQLite: everything in the data model. */
  database: string;
  /** Secrets, encrypted with a key held by the OS keychain. Never in the database. */
  secrets: string;
  /**
   * The default models folder: GGUF files named by sha256 in `blobs/`, downloads in progress in
   * `partial/`. The user can move it to another drive; the model manager tracks where it is.
   */
  models: string;
  /** llama-server builds downloaded for this machine's GPU backend. */
  runtime: string;
  /** One git worktree per run, under <repo>/<key>. */
  worktrees: string;
  /** Shadow git directories for checkpoints, one per run. */
  checkpoints: string;
  /** Notes, documents, email drafts and screenshots, per ticket. */
  artifacts: string;
  /** The clank library: edited and custom priming docs. */
  crew: string;
  /** Persistent browser sessions. Created only when a clank is given one. */
  browser: string;
  logs: string;
}

export function appDataLayout(root: string): AppDataLayout {
  return {
    root,
    database: join(root, 'clanks.db'),
    secrets: join(root, 'secrets.json'),
    models: join(root, 'models'),
    runtime: join(root, 'runtime'),
    worktrees: join(root, 'worktrees'),
    checkpoints: join(root, 'checkpoints'),
    artifacts: join(root, 'artifacts'),
    crew: join(root, 'crew'),
    browser: join(root, 'browser'),
    logs: join(root, 'logs'),
  };
}

/** Creates the layout's folders. Idempotent. */
export function ensureAppDataLayout(layout: AppDataLayout): void {
  for (const dir of [
    layout.root,
    layout.models,
    layout.runtime,
    layout.worktrees,
    layout.checkpoints,
    layout.artifacts,
    layout.crew,
    layout.logs,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
