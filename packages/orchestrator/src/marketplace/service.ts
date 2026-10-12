import {
  type ClankPreview,
  type CrewPreview,
  type InstalledPackage,
  type IntegrationPreview,
  type Licence,
  type MarketplaceEntry,
  type MarketplaceIndexInfo,
  type MarketplaceSnapshot,
  type OperationRisk,
  type PackageKind,
  type PackagePreview,
  type PreviewTool,
  type ProjectTemplate,
  type PublishInput,
  type PublishPreview,
  type PublishResult,
  type RoutinePreview,
  type RoutineTemplate,
  type TemplatePreview,
  type ToolPolicyLevel,
  type UpdateChanges,
  compareVersions,
  indexUrlSchema,
  nextVersion,
  projectTemplateFileSchema,
  publishInputSchema,
  toolsMatching,
} from '@clanks/core';
import {
  GUIDE_FILE,
  type Integration,
  type IntegrationFiles,
  MANIFEST_FILE,
  OPENAPI_FILE,
  loadIntegration,
  mcpCommand,
} from '@clanks/integrations';
import {
  CLANK_FILE,
  CREW_FILE,
  type IndexPackage,
  type MarketplaceIndex,
  MarketplaceError,
  PACKAGE_FILE,
  type PackageMeta,
  ROUTINE_FILE,
  TEMPLATE_FILE,
  type VerifiedPackage,
  crewFileSchema,
  fetchIndex,
  fetchPackage,
  latestVersion,
  packagePath,
  packageYaml,
  parsePackageMeta,
  scanForPublishing,
} from '@clanks/marketplace';
import { localZone, routineFromYaml, triggerWords } from '@clanks/routines';
import { docLevel, policyFor } from '@clanks/tools';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { parse as parseYaml } from 'yaml';
import { type CrewService, DOC_TOKEN_BUDGET } from '../crew/crew';
import { type ClankDoc, parseClankDoc } from '../crew/docs';
import type { GitHubService } from '../github/service';
import type { IntegrationService } from '../integrations/service';
import type { SettingsService } from '../settings';
import { type PackageData, pkg } from '../store/schema';
import type { Db } from '../store/store';

export { MarketplaceError } from '@clanks/marketplace';

/** The public marketplace: a GitHub repository with a static index anyone can read. */
export const DEFAULT_MARKETPLACE_REPO = 'Ryan-Conte/clanks-marketplace';
export const DEFAULT_MARKETPLACE_INDEX = `https://raw.githubusercontent.com/${DEFAULT_MARKETPLACE_REPO}/main/index.json`;

type Row = typeof pkg.$inferSelect;

interface IndexState {
  url: string;
  index: MarketplaceIndex | null;
  error: string | null;
  fetchedAt: Date | null;
}

/** A package version, fetched, verified and read. */
interface Read {
  state: IndexState;
  entry: IndexPackage;
  verified: VerifiedPackage;
  meta: PackageMeta;
}

export interface MarketplaceServiceOptions {
  db: Db;
  settings: SettingsService;
  crew: CrewService;
  integrations: IntegrationService;
  github: GitHubService;
  /** The marketplace that ships with the app. */
  defaultIndex: string;
  /** Takes a clank out of the library, once no project's crew has it. */
  removeClank: (id: string) => Promise<void>;
  userName: () => string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const keyOf = (kind: PackageKind, id: string) => `${kind}/${id}`;

/**
 * The marketplace: what its indexes list, what's installed from them, and publishing to one.
 * Everything fetched is checked against its index's checksums before it's read, shown in full
 * before it's installed, and never changed afterwards without the user accepting an update.
 * Emits `change` when the window's view of it does.
 */
export class MarketplaceService extends EventEmitter<{ change: [] }> {
  private readonly states = new Map<string, IndexState>();
  private refreshing: Promise<void> | null = null;

  constructor(private readonly options: MarketplaceServiceOptions) {
    super();
  }

  snapshot(): MarketplaceSnapshot {
    const installed = this.rows();
    const byKey = new Map(installed.map((row) => [row.key, row]));
    const entries: MarketplaceEntry[] = [];
    for (const url of this.urls()) {
      const state = this.states.get(url);
      if (!state?.index) continue;
      for (const entry of state.index.packages) {
        const row = byKey.get(keyOf(entry.kind, entry.id));
        entries.push({
          index: url,
          indexName: state.index.name,
          kind: entry.kind,
          id: entry.id,
          name: entry.name,
          summary: entry.summary,
          publisher: entry.publisher,
          licence: entry.licence,
          reviewed: entry.reviewed,
          revoked: entry.revoked,
          latest: latestVersion(entry).version,
          versions: entry.versions.map((v) => v.version),
          runsCode: entry.runsCode,
          installed: row && row.indexUrl === url ? toInstalled(row) : null,
          builtin:
            (entry.kind === 'integration' &&
              this.options.integrations.sourceOf(entry.id) === 'bundled') ||
            (entry.kind === 'clank' && this.options.crew.isPremade(entry.id)),
        });
      }
    }
    return {
      indexes: this.urls().map((url) => this.indexInfo(url)),
      entries,
      installed: installed.map(toInstalled),
      refreshing: this.refreshing !== null,
    };
  }

  /** Reads every marketplace again, and says which installed packages have moved on. */
  refresh(): Promise<void> {
    this.refreshing ??= this.readAll().finally(() => {
      this.refreshing = null;
      this.emit('change');
    });
    this.emit('change');
    return this.refreshing;
  }

  /** Adds a marketplace, once it can be read. */
  async addIndex(url: string): Promise<void> {
    const parsed = indexUrlSchema.safeParse(url);
    if (!parsed.success) throw new MarketplaceError(parsed.error.issues[0]!.message);
    const address = parsed.data;
    if (this.urls().includes(address))
      throw new MarketplaceError('That marketplace is already added');
    const index = await fetchIndex(address, { fetch: this.fetch() });
    const { marketplaceIndexes } = this.options.settings.get();
    this.options.settings.update({ marketplaceIndexes: [...marketplaceIndexes, address] });
    this.states.set(address, { url: address, index, error: null, fetchedAt: this.now() });
    this.applyStatuses();
    this.emit('change');
  }

  /** Takes a marketplace off the list. What was installed from it stays, without updates. */
  removeIndex(url: string): void {
    if (url === this.options.defaultIndex) {
      throw new MarketplaceError('The public marketplace stays');
    }
    const { marketplaceIndexes } = this.options.settings.get();
    this.options.settings.update({
      marketplaceIndexes: marketplaceIndexes.filter((existing) => existing !== url),
    });
    this.states.delete(url);
    this.emit('change');
  }

  /**
   * Everything about a package version, fetched and checked, before anything is installed: a
   * clank's whole priming doc and the tools it asks for, an integration's hosts and operations.
   */
  async preview(input: {
    index: string;
    kind: PackageKind;
    id: string;
    version?: string | undefined;
  }): Promise<PackagePreview> {
    const read = await this.read(input.index, input.kind, input.id, input.version);
    return this.previewOf(read);
  }

  /**
   * Installs exactly what was previewed: the digest the window saw must be the one fetched now, so
   * nothing can change between looking and installing.
   */
  async install(input: {
    index: string;
    kind: PackageKind;
    id: string;
    version: string;
    sha256: string;
  }): Promise<InstalledPackage> {
    const read = await this.read(input.index, input.kind, input.id, input.version);
    if (read.verified.sha256 !== input.sha256) {
      throw new MarketplaceError(
        `${read.entry.name} changed since you looked at it. Open it again before installing.`,
      );
    }
    const preview = await this.previewOf(read);
    if (preview.problems.length > 0) throw new MarketplaceError(preview.problems[0]!);
    const row = await this.installRead(read, preview);
    this.options.crew.refresh();
    this.options.integrations.reload();
    this.emit('change');
    return toInstalled(row);
  }

  async uninstall(kind: PackageKind, id: string): Promise<void> {
    const row = this.row(kind, id);
    if (!row) throw new MarketplaceError("That isn't installed");
    if (kind === 'clank') {
      // Its doc may already be gone from the library, deleted by hand.
      if (this.options.crew.has(id)) await this.options.removeClank(id);
    } else if (kind === 'integration') {
      await this.options.integrations.uninstall(id);
    }
    this.options.db.delete(pkg).where(eq(pkg.key, row.key)).run();
    this.options.crew.refresh();
    this.options.integrations.reload();
    this.emit('change');
  }

  /** Forgets that a clank came from a marketplace, when it's deleted from the crew page. */
  forget(kind: PackageKind, id: string): void {
    this.options.db
      .delete(pkg)
      .where(eq(pkg.key, keyOf(kind, id)))
      .run();
    this.emit('change');
  }

  /** Stays on the installed version, so newer ones aren't offered; or goes back to being told. */
  setPinned(kind: PackageKind, id: string, pinned: boolean): void {
    const row = this.row(kind, id);
    if (!row) throw new MarketplaceError("That isn't installed");
    this.options.db.update(pkg).set({ pinned }).where(eq(pkg.key, row.key)).run();
    this.applyStatuses();
    this.emit('change');
  }

  /** The crews installed, for a new project to start from. */
  crews(): { id: string; name: string; clanks: string[]; integrations: string[] }[] {
    return this.rows()
      .filter((row) => row.kind === 'crew' && row.status !== 'revoked')
      .map((row) => ({
        id: row.packageId,
        name: row.name,
        clanks: (row.data?.clanks ?? []).filter((id) => this.options.crew.has(id)),
        integrations: row.data?.integrations ?? [],
      }));
  }

  /** The routine templates installed, each a routine to start one from. */
  routineTemplates(): RoutineTemplate[] {
    return this.rows()
      .filter((row) => row.kind === 'routine' && row.status !== 'revoked' && row.data?.routine)
      .map((row) => ({
        id: row.packageId,
        name: row.name,
        summary: row.data?.summary ?? '',
        version: row.version,
        definition: row.data!.routine!,
      }));
  }

  /** The project templates installed, beside the ones that ship with the app. */
  projectTemplates(): ProjectTemplate[] {
    return this.rows()
      .filter((row) => row.kind === 'template' && row.status !== 'revoked' && row.data?.template)
      .map((row) => ({
        id: row.packageId,
        name: row.name,
        summary: row.data?.summary ?? '',
        source: 'marketplace' as const,
        ...row.data!.template!,
        // A clank that was deleted since is left out rather than stopping the project being made.
        crew: row.data!.template!.crew.filter((id) => this.options.crew.has(id)),
      }));
  }

  // Publishing

  /** What publishing a clank or an integration would send, and what stands in the way. */
  async publishPreview(input: {
    kind: 'clank' | 'integration';
    id: string;
  }): Promise<PublishPreview> {
    if (this.states.size === 0) await this.refresh().catch(() => {});
    return this.publishing(input.kind, input.id, null, null);
  }

  /**
   * Publishes: a pull request to the marketplace's repository from the user's GitHub account, with
   * the package's files and nothing else. A maintainer merges it; the app never can.
   */
  async publish(input: PublishInput & { acknowledged: boolean }): Promise<PublishResult> {
    const values = publishInputSchema.parse(input);
    await this.refresh().catch(() => {});
    const preview = this.publishing(values.kind, values.id, values.version, values.licence);
    if (preview.problems.length > 0) throw new MarketplaceError(preview.problems[0]!);
    if (preview.warnings.length > 0 && !input.acknowledged) {
      throw new MarketplaceError('Read what the check flagged, and tick that you have, first.');
    }
    const pull = await this.options.github.proposeFiles({
      repo: preview.repo!,
      branch: `publish/${values.kind}-${values.id}-${values.version}`,
      files: preview.files,
      title: `${preview.published ? 'Update' : 'Add'} ${preview.name} ${values.version} (${values.kind})`,
      body: [
        `${preview.summary}`,
        '',
        `- Kind: ${values.kind}`,
        `- Id: \`${values.id}\``,
        `- Version: ${values.version}`,
        `- Licence: ${values.licence}`,
        '',
        `Published from the clanks app by @${preview.publisher}, who wrote it or has the right to publish it, under the ${values.licence} licence.`,
      ].join('\n'),
    });
    return { url: pull.url, number: pull.number, repo: pull.repo };
  }

  private publishing(
    kind: 'clank' | 'integration',
    id: string,
    version: string | null,
    licence: Licence | null,
  ): PublishPreview {
    const problems: string[] = [];
    const warnings: string[] = [];
    const names = [this.options.userName()].filter((name) => name && name !== 'the user');
    const status = this.options.github.status();
    const publisher = status.signedIn ? status.login : null;
    if (!publisher) {
      problems.push(
        'Sign in to GitHub in Settings first: the pull request comes from your account.',
      );
    }

    let name: string;
    let summary: string;
    const texts = new Map<string, string>();
    if (kind === 'clank') {
      const clank = this.options.crew.list().find((c) => c.id === id);
      if (!clank) throw new MarketplaceError(`There's no clank called ${id}`);
      name = clank.frontmatter.name;
      summary = clank.frontmatter.summary;
      if (!clank.custom) {
        problems.push(`${clank.name} ships with the app. Publish clanks you made.`);
      } else if (clank.marketplace) {
        problems.push(
          `${clank.name} came from a marketplace. To publish a changed one, make it a clank of your own first, with its own id.`,
        );
      }
      const text = normalize(this.options.crew.docText(id).text);
      texts.set(CLANK_FILE, text);
      try {
        const doc = this.options.crew.checkDoc(text);
        const tokens = this.options.crew.tokensOf(doc.body);
        if (tokens > DOC_TOKEN_BUDGET) {
          warnings.push(
            `With the crew rules its prompt is about ${tokens} tokens. Over ${DOC_TOKEN_BUDGET}, it won't fit the small local models many people run.`,
          );
        }
        const own = listedTools(doc).filter((tool) => /^(mcp|int)_/.test(tool));
        if (own.length > 0) {
          warnings.push(
            `It names ${own.join(', ')}, which come from servers and services other people may not have.`,
          );
        }
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
      const scan = scanForPublishing(text, { what: 'The priming doc', names });
      problems.push(...scan.problems);
      warnings.push(...scan.warnings);
    } else {
      const files = this.options.integrations.files(id);
      const integration = this.options.integrations.find(id);
      if (!files || !integration) throw new MarketplaceError(`There's no integration called ${id}`);
      name = integration.manifest.name;
      summary = integration.manifest.summary;
      if (this.options.integrations.sourceOf(id) !== 'local') {
        problems.push(
          `${name} isn't yours to publish: it ${this.options.integrations.sourceOf(id) === 'bundled' ? 'ships with the app' : 'came from a marketplace'}.`,
        );
      }
      texts.set(MANIFEST_FILE, normalize(files.manifest));
      if (files.openapi) texts.set(OPENAPI_FILE, normalize(files.openapi));
      if (files.guide) texts.set(GUIDE_FILE, normalize(files.guide));
      try {
        // As anyone installing it would load it: public hosts only.
        loadIntegration(files);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
      for (const [file, text] of texts) {
        const scan = scanForPublishing(text, { what: file, names });
        problems.push(...scan.problems);
        warnings.push(...scan.warnings);
      }
    }

    // Where it goes: the first marketplace that takes pull requests, else the public one.
    const target = [...this.states.values()].find((state) => state.index?.repo) ?? null;
    const repo =
      target?.index?.repo ??
      (this.options.defaultIndex === DEFAULT_MARKETPLACE_INDEX ? DEFAULT_MARKETPLACE_REPO : null);
    if (!repo)
      problems.push(
        "None of your marketplaces takes pull requests, so there's nowhere to publish to.",
      );
    const existing = target?.index?.packages.find((p) => p.kind === kind && p.id === id) ?? null;
    const published = existing ? latestVersion(existing).version : null;
    if (existing && publisher && existing.publisher.toLowerCase() !== publisher.toLowerCase()) {
      problems.push(
        `The marketplace already has ${kind === 'clank' ? 'a clank' : 'an integration'} with the id ${id}, published by ${existing.publisher}. Give yours another id.`,
      );
    }
    const chosen = version ?? (published ? nextVersion(published) : '1.0.0');
    if (published && compareVersions(chosen, published) <= 0) {
      problems.push(`Version ${chosen} isn't newer than ${published}, which is already published.`);
    }
    const meta: PackageMeta = {
      kind,
      id,
      name,
      summary,
      version: chosen,
      publisher: publisher ?? 'you',
      licence: licence ?? 'MIT',
    };
    const folder = packagePath(kind, id, chosen);
    return {
      kind,
      id,
      name,
      summary,
      version: chosen,
      published,
      repo,
      publisher,
      files: [
        { path: `${folder}/${PACKAGE_FILE}`, text: packageYaml(meta) },
        ...[...texts].map(([file, text]) => ({ path: `${folder}/${file}`, text })),
      ],
      problems,
      warnings,
    };
  }

  // Inside

  private async readAll(): Promise<void> {
    const urls = this.urls();
    for (const url of [...this.states.keys()]) {
      if (!urls.includes(url)) this.states.delete(url);
    }
    await Promise.all(
      urls.map(async (url) => {
        const previous = this.states.get(url);
        try {
          const index = await fetchIndex(url, { fetch: this.fetch() });
          this.states.set(url, { url, index, error: null, fetchedAt: this.now() });
        } catch (error) {
          // What was read before is still worth showing, with why it couldn't be read again.
          this.states.set(url, {
            url,
            index: previous?.index ?? null,
            error: error instanceof Error ? error.message : String(error),
            fetchedAt: previous?.fetchedAt ?? null,
          });
        }
      }),
    );
    if (this.applyStatuses()) {
      this.options.crew.refresh();
      this.options.integrations.reload();
    }
  }

  /**
   * Brings each installed package's status in line with its index: an update to offer, or a notice
   * that it was taken down. Returns whether anything was turned off or back on.
   */
  private applyStatuses(): boolean {
    let toggled = false;
    for (const row of this.rows()) {
      const index = this.states.get(row.indexUrl)?.index;
      const entry = index?.packages.find((p) => p.kind === row.kind && p.id === row.packageId);
      // An index that can't be read, or no longer lists it, changes nothing.
      if (!entry) continue;
      const latest = latestVersion(entry).version;
      const status: Row['status'] = entry.revoked
        ? 'revoked'
        : !row.pinned && compareVersions(latest, row.version) > 0
          ? 'update_available'
          : 'active';
      if (status === row.status && latest === row.latest && entry.revoked === row.notice) continue;
      if ((status === 'revoked') !== (row.status === 'revoked')) toggled = true;
      this.options.db
        .update(pkg)
        .set({ status, latest, notice: entry.revoked })
        .where(eq(pkg.key, row.key))
        .run();
    }
    return toggled;
  }

  private async read(
    indexUrl: string,
    kind: PackageKind,
    id: string,
    version?: string,
  ): Promise<Read> {
    if (!this.urls().includes(indexUrl)) {
      throw new MarketplaceError("That isn't one of your marketplaces");
    }
    if (!this.states.get(indexUrl)?.index) await this.refresh();
    const state = this.states.get(indexUrl);
    if (!state?.index) {
      throw new MarketplaceError(state?.error ?? "The marketplace couldn't be read");
    }
    const entry = state.index.packages.find((p) => p.kind === kind && p.id === id);
    if (!entry) throw new MarketplaceError(`${state.index.name} has no ${kind} called ${id}`);
    const chosen = version ?? latestVersion(entry).version;
    const verified = await fetchPackage(indexUrl, entry, chosen, { fetch: this.fetch() });
    const text = verified.files.get(PACKAGE_FILE);
    if (!text) throw new MarketplaceError(`${entry.name} ${chosen} has no ${PACKAGE_FILE}`);
    const meta = parsePackageMeta(text);
    if (meta.kind !== kind || meta.id !== id || meta.version !== chosen) {
      throw new MarketplaceError(
        `${entry.name} ${chosen} says it's ${meta.kind}/${meta.id} ${meta.version}, so it wasn't used.`,
      );
    }
    return { state, entry, verified, meta };
  }

  private async previewOf(read: Read): Promise<PackagePreview> {
    const { entry, verified, state } = read;
    const problems: string[] = [];
    const row = this.row(entry.kind, entry.id);
    if (entry.revoked)
      problems.push(`It was taken down from ${state.index!.name}: ${entry.revoked}`);
    if (row && row.indexUrl !== state.url) {
      problems.push(
        `You installed a ${entry.kind} with this id from another marketplace. Uninstall that one first.`,
      );
    }
    let clank: ClankPreview | null = null;
    let integration: IntegrationPreview | null = null;
    let crew: CrewPreview | null = null;
    let routine: RoutinePreview | null = null;
    let template: TemplatePreview | null = null;
    let changes: UpdateChanges | null = null;

    if (entry.kind === 'clank') {
      const result = this.clankPreview(entry.id, verified.files.get(CLANK_FILE) ?? '', row);
      clank = result.preview;
      changes = result.changes;
      problems.push(...result.problems);
    } else if (entry.kind === 'integration') {
      const result = this.integrationPreview(entry.id, verified.files, row);
      integration = result.preview;
      changes = result.changes;
      problems.push(...result.problems);
    } else if (entry.kind === 'crew') {
      const result = await this.crewPreview(read);
      crew = result.preview;
      problems.push(...result.problems);
    } else if (entry.kind === 'routine') {
      const result = this.routinePreview(verified.files.get(ROUTINE_FILE) ?? '');
      routine = result.preview;
      problems.push(...result.problems);
    } else {
      const result = this.templatePreview(verified.files.get(TEMPLATE_FILE) ?? '');
      template = result.preview;
      problems.push(...result.problems);
    }
    const snapshot = this.snapshot().entries.find(
      (e) => e.index === state.url && e.kind === entry.kind && e.id === entry.id,
    )!;
    return {
      entry: snapshot,
      version: verified.version,
      sha256: verified.sha256,
      clank,
      integration,
      crew,
      routine,
      template,
      problems,
      changes,
    };
  }

  /** A routine template as it reads, before it's installed. It schedules nothing by being there. */
  private routinePreview(text: string): { preview: RoutinePreview | null; problems: string[] } {
    try {
      const zone = this.options.settings.get().profile.timeZone || localZone();
      const definition = routineFromYaml(text, { now: this.now(), zone });
      const steps = definition.steps.map((step) =>
        step.ticket
          ? `${step.id}: a ${step.ticket.type} ticket for ${step.ticket.clank}, "${step.ticket.title}"`
          : `${step.id}: ${step.action!.integration} ${step.action!.operation} at ${step.action!.at}, once you approve it`,
      );
      return {
        preview: {
          name: definition.name,
          trigger: triggerWords(definition.trigger, definition.timeZone || zone, this.now()),
          steps,
          clanks: [...new Set(definition.steps.flatMap((s) => s.ticket?.clank ?? []))],
          integrations: [...new Set(definition.steps.flatMap((s) => s.action?.integration ?? []))],
          yaml: text,
        },
        problems: [],
      };
    } catch (error) {
      return {
        preview: null,
        problems: [
          `Its routine can't be read: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  /** A project template as it reads: the crew it wants and what it has the crew do first. */
  private templatePreview(text: string): { preview: TemplatePreview | null; problems: string[] } {
    const parsed = projectTemplateFileSchema.safeParse(safeYaml(text));
    if (!parsed.success) {
      return { preview: null, problems: ["Its template can't be read, so it wasn't used."] };
    }
    const file = parsed.data;
    const missing = file.crew.filter((id) => !this.options.crew.has(id));
    return {
      preview: {
        crew: file.crew,
        missing,
        ask: file.ask,
        kickoff: file.kickoff,
        tickets: file.tickets.map(
          (t) => `${t.type}${t.clank ? ` for ${t.clank}` : ''}: ${t.title}`,
        ),
        yaml: text,
      },
      problems: [],
    };
  }

  private clankPreview(
    id: string,
    text: string,
    row: Row | undefined,
  ): { preview: ClankPreview | null; problems: string[]; changes: UpdateChanges | null } {
    const problems: string[] = [];
    let doc: ClankDoc;
    try {
      doc = parseClankDoc(text);
    } catch (error) {
      return {
        preview: null,
        problems: [
          `Its priming doc can't be read: ${error instanceof Error ? error.message : String(error)}`,
        ],
        changes: null,
      };
    }
    try {
      this.options.crew.checkDoc(text);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    const { frontmatter } = doc;
    if (frontmatter.id !== id) {
      problems.push(`Its doc says its id is ${frontmatter.id}, not ${id}.`);
    }
    const { crew } = this.options;
    if (crew.isPremade(id)) {
      problems.push(`${id} is a clank that ships with the app, which nothing replaces.`);
    } else if (crew.has(id) && !row) {
      problems.push(
        `You already have a clank of your own with the id ${id}. Delete or rename it to install this one.`,
      );
    }
    const tools = previewTools(doc);
    const preview: ClankPreview = {
      id: frontmatter.id,
      name: frontmatter.name,
      role: frontmatter.role,
      summary: frontmatter.summary,
      kind: frontmatter.workflow.kind,
      stage: frontmatter.workflow.stage,
      after: frontmatter.workflow.after ?? null,
      appliesTo: frontmatter.workflow.applies_to ?? [],
      outputs: frontmatter.outputs,
      bounceTo: frontmatter.workflow.bounce_to ?? [],
      doc: text,
      tokens: crew.tokensOf(doc.body),
      tools,
      integrations: frontmatter.integrations ?? [],
      needs: frontmatter.model.needs,
      minContext: frontmatter.model.min_context,
    };
    let changes: UpdateChanges | null = null;
    if (row && crew.has(id)) {
      const before = crew.docText(id).text;
      let old: PreviewTool[] = [];
      try {
        old = previewTools(parseClankDoc(before));
      } catch {
        // The installed copy was edited into something unreadable: everything counts as new.
      }
      const was = new Map(old.map((tool) => [tool.name, tool.asks]));
      changes = {
        from: row.version,
        files: differing([[CLANK_FILE, before, text]]),
        newTools: tools.filter((t) => !was.has(t.name) && t.asks !== 'deny').map((t) => t.name),
        raisedTools: tools
          .filter((t) => was.has(t.name) && rank(t.asks) > rank(was.get(t.name)!))
          .map((t) => t.name),
        newHosts: [],
        newOperations: [],
        loweredRisks: [],
      };
    }
    return { preview, problems, changes };
  }

  private integrationPreview(
    id: string,
    files: Map<string, string>,
    row: Row | undefined,
  ): { preview: IntegrationPreview | null; problems: string[]; changes: UpdateChanges | null } {
    const problems: string[] = [];
    const read: IntegrationFiles = {
      manifest: files.get(MANIFEST_FILE) ?? '',
      openapi: files.get(OPENAPI_FILE) ?? null,
      guide: files.get(GUIDE_FILE) ?? null,
    };
    let integration: Integration;
    try {
      integration = loadIntegration(read);
    } catch (error) {
      return {
        preview: null,
        problems: [`It can't be used: ${error instanceof Error ? error.message : String(error)}`],
        changes: null,
      };
    }
    const { manifest } = integration;
    if (manifest.id !== id) problems.push(`Its manifest says its id is ${manifest.id}, not ${id}.`);
    const { integrations } = this.options;
    if (integrations.sourceOf(id) === 'local') {
      problems.push(
        `You added an integration of your own with the id ${id}. Remove it in Settings to install this one.`,
      );
    }
    const preview = describeIntegration(integration, read.manifest);
    let changes: UpdateChanges | null = null;
    const current = integrations.find(id);
    const currentFiles = integrations.files(id);
    // An installed version, or the one that ships with the app, which installing would stand in for.
    if (current && currentFiles && integrations.sourceOf(id) !== 'local') {
      const before = describeIntegration(current, currentFiles.manifest);
      const was = new Map(before.operations.map((o) => [o.id, o]));
      changes = {
        from: row?.version ?? 'the one that ships with the app',
        files: differing([
          [MANIFEST_FILE, currentFiles.manifest, read.manifest],
          [GUIDE_FILE, currentFiles.guide ?? '', read.guide ?? ''],
          [OPENAPI_FILE, currentFiles.openapi ?? '', read.openapi ?? ''],
        ]),
        newTools: [],
        raisedTools: [],
        newHosts: preview.hosts.filter((host) => !before.hosts.includes(host)),
        newOperations: preview.operations.filter((o) => !was.has(o.id)).map((o) => o.id),
        loweredRisks: preview.operations.flatMap((o) => {
          const old = was.get(o.id);
          const lowered = (from: OperationRisk, to: OperationRisk) => riskRank(to) < riskRank(from);
          if (!old) return [];
          if (lowered(old.risk, o.risk)) return [{ operation: o.id, from: old.risk, to: o.risk }];
          if (lowered(old.testRisk, o.testRisk)) {
            return [{ operation: `${o.id} (test mode)`, from: old.testRisk, to: o.testRisk }];
          }
          return [];
        }),
      };
    }
    return { preview, problems, changes };
  }

  /** A crew: each clank and integration it brings, previewed as it would be on its own. */
  private async crewPreview(
    read: Read,
  ): Promise<{ preview: CrewPreview | null; problems: string[] }> {
    const problems: string[] = [];
    let file;
    try {
      file = crewFileSchema.parse(parseYaml(read.verified.files.get(CREW_FILE) ?? ''));
    } catch {
      return { preview: null, problems: [`Its ${CREW_FILE} can't be read.`] };
    }
    const index = read.state.index!;
    const preview: CrewPreview = { premade: [], clanks: [], integrations: [], missing: [] };
    for (const id of file.clanks) {
      if (this.options.crew.isPremade(id)) {
        preview.premade.push(id);
        continue;
      }
      if (!index.packages.some((p) => p.kind === 'clank' && p.id === id)) {
        preview.missing.push(`the clank ${id}`);
        continue;
      }
      const sub = await this.preview({ index: read.state.url, kind: 'clank', id });
      if (sub.clank) preview.clanks.push(sub.clank);
      // One that's already installed from here is fine as it is.
      if (!sub.entry.installed)
        problems.push(...sub.problems.map((p) => `${sub.entry.name}: ${p}`));
    }
    for (const id of file.integrations) {
      if (this.options.integrations.has(id)) continue;
      if (!index.packages.some((p) => p.kind === 'integration' && p.id === id)) {
        preview.missing.push(`the integration ${id}`);
        continue;
      }
      const sub = await this.preview({ index: read.state.url, kind: 'integration', id });
      if (sub.integration) preview.integrations.push(sub.integration);
      problems.push(...sub.problems.map((p) => `${sub.entry.name}: ${p}`));
    }
    if (preview.missing.length > 0) {
      problems.push(`It needs ${preview.missing.join(' and ')}, which ${index.name} doesn't have.`);
    }
    return { preview, problems };
  }

  private async installRead(read: Read, preview: PackagePreview): Promise<Row> {
    const { entry, verified, state } = read;
    let data: PackageData | null = null;
    if (entry.kind === 'clank') {
      this.options.crew.installPackage(verified.files.get(CLANK_FILE)!);
    } else if (entry.kind === 'integration') {
      // The row goes in first, so the integration is known to be a marketplace's as it's loaded.
      this.upsert(read, null);
      const files = new Map([...verified.files].filter(([name]) => name !== PACKAGE_FILE));
      try {
        await this.options.integrations.install(files, 'marketplace');
      } catch (error) {
        if (!this.options.integrations.files(entry.id)) {
          this.options.db
            .delete(pkg)
            .where(eq(pkg.key, keyOf(entry.kind, entry.id)))
            .run();
        }
        throw error;
      }
    } else if (entry.kind === 'crew' && preview.crew) {
      const file = crewFileSchema.parse(parseYaml(verified.files.get(CREW_FILE)!));
      for (const kind of ['clank', 'integration'] as const) {
        const wanted = kind === 'clank' ? preview.crew.clanks : preview.crew.integrations;
        for (const member of wanted) {
          if (this.row(kind, member.id)) continue;
          const sub = await this.read(state.url, kind, member.id);
          await this.installRead(sub, await this.previewOf(sub));
        }
      }
      data = { clanks: file.clanks, integrations: file.integrations };
    } else if (entry.kind === 'routine') {
      const zone = this.options.settings.get().profile.timeZone || localZone();
      data = {
        summary: entry.summary,
        routine: routineFromYaml(verified.files.get(ROUTINE_FILE) ?? '', { now: this.now(), zone }),
      };
    } else if (entry.kind === 'template') {
      data = {
        summary: entry.summary,
        template: projectTemplateFileSchema.parse(
          safeYaml(verified.files.get(TEMPLATE_FILE) ?? ''),
        ),
      };
    }
    return this.upsert(read, data);
  }

  private upsert(read: Read, data: PackageData | null): Row {
    const { entry, verified, meta, state } = read;
    const existing = this.row(entry.kind, entry.id);
    const latest = latestVersion(entry).version;
    const row: Row = {
      key: keyOf(entry.kind, entry.id),
      kind: entry.kind,
      packageId: entry.id,
      name: meta.name,
      indexUrl: state.url,
      version: verified.version,
      sha256: verified.sha256,
      publisher: meta.publisher,
      licence: meta.licence,
      pinned: existing?.pinned ?? false,
      status:
        !existing?.pinned && compareVersions(latest, verified.version) > 0
          ? 'update_available'
          : 'active',
      latest,
      notice: null,
      data,
      installedAt: this.now(),
    };
    this.options.db
      .insert(pkg)
      .values(row)
      .onConflictDoUpdate({ target: pkg.key, set: { ...row, key: undefined } })
      .run();
    return row;
  }

  private indexInfo(url: string): MarketplaceIndexInfo {
    const state = this.states.get(url);
    const builtin = url === this.options.defaultIndex;
    return {
      url,
      name: state?.index?.name ?? (builtin ? 'clanks marketplace' : url),
      builtin,
      repo: state?.index?.repo ?? null,
      packages: state?.index?.packages.length ?? 0,
      fetchedAt: state?.fetchedAt ?? null,
      error: state?.error ?? null,
    };
  }

  /** The public marketplace first, then the user's own. */
  private urls(): string[] {
    return [
      ...new Set([this.options.defaultIndex, ...this.options.settings.get().marketplaceIndexes]),
    ];
  }

  private rows(): Row[] {
    return this.options.db
      .select()
      .from(pkg)
      .all()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private row(kind: PackageKind, id: string): Row | undefined {
    return this.options.db
      .select()
      .from(pkg)
      .where(eq(pkg.key, keyOf(kind, id)))
      .get();
  }

  private fetch(): typeof fetch {
    return this.options.fetch ?? fetch;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function toInstalled(row: Row): InstalledPackage {
  return {
    kind: row.kind,
    id: row.packageId,
    name: row.name,
    version: row.version,
    index: row.indexUrl,
    publisher: row.publisher,
    licence: row.licence,
    sha256: row.sha256,
    pinned: row.pinned,
    status: row.status,
    latest: row.latest,
    notice: row.notice,
    installedAt: row.installedAt,
  };
}

/** Every tool a doc names, groups such as `browser_*` spelled out. */
function listedTools(doc: ClankDoc): string[] {
  const { allow, ask, deny } = doc.frontmatter.tools;
  const names = new Set<string>();
  for (const entry of [...allow, ...ask, ...deny]) {
    const matched = toolsMatching(entry);
    if (matched.length > 0) for (const name of matched) names.add(name);
    else names.add(entry);
  }
  return [...names];
}

/** What each tool starts at once installed: nothing above read higher than ask. */
function previewTools(doc: ClankDoc): PreviewTool[] {
  return listedTools(doc).map((name) => ({
    name,
    asks: docLevel(doc.frontmatter.tools, name),
    starts: policyFor({ doc: doc.frontmatter.tools, overrides: {}, name, capped: true }).level,
  }));
}

function describeIntegration(integration: Integration, manifestText: string): IntegrationPreview {
  const { manifest } = integration;
  const base = {
    id: manifest.id,
    name: manifest.name,
    summary: manifest.summary,
    hosts: integration.hosts,
    guide: integration.guide,
    manifest: manifestText,
  };
  if (integration.kind === 'mcp') {
    const command = mcpCommand(integration.manifest, { docker: false });
    return {
      ...base,
      kind: 'mcp',
      auth: 'Its own, through the environment variables you give it',
      operations: [],
      command: [command.command, ...command.args].join(' '),
    };
  }
  const { auth } = integration.manifest;
  return {
    ...base,
    kind: 'declarative',
    auth:
      auth.type === 'api_key'
        ? `${auth.label ?? 'An API key'}, sent to its hosts only`
        : auth.type === 'oauth2'
          ? `Signing in with OAuth, for ${auth.scopes.join(', ') || 'no particular scopes'}`
          : auth.type === 'basic'
            ? 'A user name and password, sent to its hosts only'
            : 'None',
    operations: integration.operations.map((operation) => ({
      id: operation.id,
      tool: operation.tool,
      summary: operation.summary,
      calls: operation.steps.map((s) => `${s.call.method} ${s.call.path}`),
      risk: operation.risk,
      testRisk: operation.testRisk,
    })),
    command: null,
  };
}

/** The files that aren't the same in both versions, line endings aside. */
function differing(files: [name: string, before: string, after: string][]): UpdateChanges['files'] {
  return files
    .map(([name, before, after]) => ({ name, before: normalize(before), after: normalize(after) }))
    .filter((file) => file.before !== file.after);
}

function rank(level: ToolPolicyLevel): number {
  return level === 'allow' ? 2 : level === 'ask' ? 1 : 0;
}

function riskRank(risk: OperationRisk): number {
  return risk === 'read' ? 0 : risk === 'write' ? 1 : 2;
}

/** Text as it's published: LF line endings, one newline at the end. */
function normalize(text: string): string {
  return `${text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`;
}

/** YAML as data, or null when it isn't YAML: what reads it says what's wrong. */
function safeYaml(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    return null;
  }
}
