import {
  type Avatar,
  type ClankDocText,
  type ClankId,
  type ClankOverrides,
  type ClankProfilePatch,
  type ClankSummary,
  type CustomClank,
  RESERVED_CLANK_IDS,
  avatarSchema,
  clankBrowserSchema,
  clankIdSchema,
  clankProfilePatchSchema,
  customClankDoc,
  customClankSchema,
  defaultClankBrowser,
  estimateTokens,
  toolOverridesSchema,
} from '@clanks/core';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { clank as clankTable, pkg } from '../store/schema';
import type { Db } from '../store/store';
import { checkCustomDoc } from './check';
import {
  CREW_RULES_FILE,
  type ClankDoc,
  CrewDocError,
  PREMADE_CREW,
  parseClankDoc,
  parseCrewRules,
} from './docs';

/** A clank ready to work: its doc, with the user's changes applied. */
export interface Clank extends ClankDoc {
  id: ClankId;
  name: string;
  avatar: Avatar;
  overrides: ClankOverrides;
  doc: 'bundled' | 'edited';
  docError: string | null;
  /** The user made it: its doc is in the library, with none shipped to go back to. */
  custom: boolean;
  /** It was installed from a marketplace, so its doc can't give it more than ask above read. */
  marketplace: boolean;
  /** Why its marketplace took it down, which stops it working. Null when it hasn't. */
  revoked: string | null;
}

export { DOC_TOKEN_BUDGET } from './check';

/** A custom clank's doc in the library that can't be used, and why. */
export interface BrokenClank {
  id: string;
  error: string;
}

export interface CrewServiceOptions {
  /** The priming docs that ship with the app. Never written to. */
  bundledDir: string;
  /** The user's edited copies, in the app data folder. */
  editedDir: string;
  db: Db;
}

/**
 * The crew: the premade clanks' priming docs, the user's edited copies of them, the custom clanks
 * in the user's library, and what the user changed in each clank's profile. Emits `change` when
 * any of that changes.
 */
export class CrewService extends EventEmitter<{ change: [] }> {
  private readonly bundled = new Map<ClankId, string>();
  private readonly rulesText: string;
  private cache: Clank[] | null = null;
  private broken: BrokenClank[] = [];

  constructor(private readonly options: CrewServiceOptions) {
    super();
    // The app can't run without its crew, so a missing or broken bundled doc fails loudly.
    this.rulesText = parseCrewRules(
      readFileSync(join(options.bundledDir, CREW_RULES_FILE), 'utf8'),
    );
    for (const id of PREMADE_CREW) {
      const text = readFileSync(join(options.bundledDir, `${id}.md`), 'utf8');
      const doc = parseClankDoc(text);
      if (doc.frontmatter.id !== id)
        throw new CrewDocError(`${id}.md says its id is ${doc.frontmatter.id}`);
      this.bundled.set(id, text);
    }
  }

  /** CREW.md: the rules every clank shares. */
  rules(): string {
    return this.rulesText;
  }

  /** Every clank, in roster order: the premade crew, then the library's custom clanks by name. */
  list(): Clank[] {
    if (!this.cache) {
      const broken: BrokenClank[] = [];
      const custom = this.customIds()
        .flatMap((id) => {
          try {
            return [this.loadCustom(id)];
          } catch (error) {
            broken.push({ id, error: error instanceof Error ? error.message : String(error) });
            return [];
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      this.broken = broken;
      this.cache = [...PREMADE_CREW.map((id) => this.load(id)), ...custom];
    }
    return this.cache;
  }

  /** Custom clanks whose docs don't parse, so they can't work until they're fixed. */
  brokenCustom(): BrokenClank[] {
    this.list();
    return this.broken;
  }

  get(id: string): Clank {
    const found = this.list().find((c) => c.id === id);
    if (!found) throw new CrewDocError(`There's no clank called ${id}`);
    return found;
  }

  has(id: string): boolean {
    return this.list().some((c) => c.id === id);
  }

  summaries(): ClankSummary[] {
    return this.list().map(summarize);
  }

  docText(id: ClankId): ClankDocText {
    if (!this.bundled.has(id)) {
      const text = this.readEdited(id);
      if (text === null) throw new CrewDocError(`There's no clank called ${id}`);
      return { id, text, bundled: '', edited: false, custom: true };
    }
    const bundled = this.requireBundled(id);
    const edited = this.readEdited(id);
    return { id, text: edited ?? bundled, bundled, edited: edited !== null, custom: false };
  }

  /** What the form for a new custom clank starts from, and a worked example. */
  templates(): { template: string; example: string } {
    const read = (file: string) => {
      try {
        return readFileSync(join(this.options.bundledDir, file), 'utf8');
      } catch {
        return '';
      }
    };
    return { template: read('custom.md'), example: read(join('examples', 'sentinel.md')) };
  }

  /**
   * Adds a custom clank to the library, from the form's fields or from a whole doc. Its id must be
   * free, and its doc is checked as a shipped one would be: real tools, a finishing call, no
   * secrets.
   */
  createCustom(input: CustomClank | { text: string }): ClankSummary {
    const text = 'text' in input ? input.text : customClankDoc(customClankSchema.parse(input));
    const doc = parseClankDoc(text);
    const id = doc.frontmatter.id;
    if (RESERVED_CLANK_IDS.includes(id)) {
      throw new CrewDocError(`"${id}" means something else in the workflow. Pick another id.`);
    }
    if (this.bundled.has(id) || existsSync(this.editedPath(id))) {
      throw new CrewDocError(`There's already a clank with the id ${id}. Pick another.`);
    }
    this.checkCustom(doc);
    this.write(id, text);
    return this.changed(id);
  }

  /**
   * Checks a doc as one joining the library is: its frontmatter, real tools, a finishing call, no
   * secrets, a prompt that fits. Throws a `CrewDocError` saying what's wrong.
   */
  checkDoc(text: string): ClankDoc {
    const doc = parseClankDoc(text);
    if (RESERVED_CLANK_IDS.includes(doc.frontmatter.id)) {
      throw new CrewDocError(
        `"${doc.frontmatter.id}" means something else in the workflow, so a clank can't be called that.`,
      );
    }
    this.checkCustom(doc);
    return doc;
  }

  /** About how many tokens a prompt takes with the crew rules. */
  tokensOf(body: string): number {
    return estimateTokens(this.rulesText) + estimateTokens(body);
  }

  /** Whether a clank ships with the app. */
  isPremade(id: string): boolean {
    return this.bundled.has(id);
  }

  /**
   * Puts a clank from a marketplace in the library, or a newer version over the one that's there.
   * It never replaces a clank that ships with the app, or one the user made.
   */
  installPackage(text: string): ClankSummary {
    const doc = this.checkDoc(text);
    const id = doc.frontmatter.id;
    if (this.bundled.has(id)) {
      throw new CrewDocError(`${id} is a clank that ships with the app, which nothing replaces.`);
    }
    if (existsSync(this.editedPath(id)) && !this.fromMarketplace().has(id)) {
      throw new CrewDocError(
        `You already have a clank of your own with the id ${id}. Delete or rename it first.`,
      );
    }
    this.write(id, text);
    return this.changed(id);
  }

  /** Reads the library again, after a marketplace changed what's installed or revoked. */
  refresh(): void {
    this.cache = null;
    this.emit('change');
  }

  /** Takes a custom clank out of the library, with what the user set on its profile. */
  deleteCustom(id: ClankId): void {
    if (this.bundled.has(id)) {
      throw new CrewDocError(`${this.get(id).name} ships with the app, so it can't be deleted.`);
    }
    if (!existsSync(this.editedPath(id))) throw new CrewDocError(`There's no clank called ${id}`);
    rmSync(this.editedPath(id), { force: true });
    this.options.db.delete(clankTable).where(eq(clankTable.id, id)).run();
    this.cache = null;
    this.emit('change');
  }

  isCustom(id: string): boolean {
    return !this.bundled.has(id) && this.has(id);
  }

  /**
   * Saves the user's edit of a priming doc. It must parse, and keep its id. Saving the bundled text
   * unchanged is the same as resetting it.
   */
  saveDoc(id: ClankId, text: string): ClankSummary {
    if (!this.bundled.has(id)) {
      // A custom clank's doc is its only one: the library's copy is replaced.
      if (!existsSync(this.editedPath(id))) throw new CrewDocError(`There's no clank called ${id}`);
      const doc = parseClankDoc(text);
      if (doc.frontmatter.id !== id) throw new CrewDocError(`The id must stay ${id}.`);
      this.checkCustom(doc);
      this.write(id, text);
      return this.changed(id);
    }
    const bundled = this.requireBundled(id);
    if (normalize(text) === normalize(bundled)) return this.resetDoc(id);
    const doc = parseClankDoc(text);
    if (doc.frontmatter.id !== id) {
      throw new CrewDocError(`The id must stay ${id}. Create a custom clank to make a new one.`);
    }
    this.write(id, text);
    return this.changed(id);
  }

  private write(id: ClankId, text: string): void {
    mkdirSync(this.options.editedDir, { recursive: true });
    const file = this.editedPath(id);
    // A sibling file renamed over the old one, so a crash never leaves half a doc.
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
  }

  /** What a custom clank's doc must get right before it joins the library. */
  private checkCustom(doc: ClankDoc): void {
    checkCustomDoc(doc, this.rulesText);
  }

  /** About how many tokens a doc's prompt takes with the crew rules, which every clank gets. */
  promptTokens(id: string): number {
    return estimateTokens(this.rulesText) + estimateTokens(this.get(id).body);
  }

  /** Goes back to the doc that ships with the app. */
  resetDoc(id: ClankId): ClankSummary {
    if (this.isCustom(id)) {
      throw new CrewDocError(
        `${this.get(id).name} is a custom clank, with no default to go back to.`,
      );
    }
    this.requireBundled(id);
    rmSync(this.editedPath(id), { force: true });
    return this.changed(id);
  }

  updateProfile(id: ClankId, patch: ClankProfilePatch): ClankSummary {
    this.get(id);
    const values = clankProfilePatchSchema.parse(patch);
    const current = this.readOverrides(id);
    const next: ClankOverrides = {
      name: values.name !== undefined ? values.name : current.name,
      avatar: values.avatar !== undefined ? values.avatar : current.avatar,
      model: values.model !== undefined ? values.model : current.model,
      tools: values.tools !== undefined ? values.tools : current.tools,
      browser: values.browser !== undefined ? values.browser : current.browser,
    };
    const browserDefault =
      next.browser.allow.length === 0 && next.browser.deny.length === 0 && !next.browser.persistent;
    const row = {
      id,
      name: next.name,
      avatar: next.avatar,
      provider: next.model?.provider ?? null,
      model: next.model?.model ?? null,
      tools: Object.keys(next.tools).length > 0 ? next.tools : null,
      browser: browserDefault ? null : next.browser,
      updatedAt: new Date(),
    };
    this.options.db
      .insert(clankTable)
      .values(row)
      .onConflictDoUpdate({ target: clankTable.id, set: { ...row, id: undefined } })
      .run();
    return this.changed(id);
  }

  /** Every clank running on a model, such as one being removed, goes back to the crew's. */
  clearModel(provider: string, model?: string): void {
    for (const clank of this.list()) {
      const own = clank.overrides.model;
      if (own?.provider === provider && (model === undefined || own.model === model)) {
        this.updateProfile(clank.id, { model: null });
      }
    }
  }

  private changed(id: ClankId): ClankSummary {
    this.cache = null;
    this.emit('change');
    return summarize(this.get(id));
  }

  private load(id: ClankId): Clank {
    const bundled = parseClankDoc(this.requireBundled(id));
    const overrides = this.readOverrides(id);
    let doc = bundled;
    let source: Clank['doc'] = 'bundled';
    let docError: string | null = null;
    const edited = this.readEdited(id);
    if (edited !== null) {
      source = 'edited';
      try {
        const parsed = parseClankDoc(edited);
        if (parsed.frontmatter.id !== id) throw new CrewDocError(`Its id must stay ${id}`);
        doc = parsed;
      } catch (error) {
        // The file was edited outside the app. Keep working on the bundled doc and say why.
        docError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      ...doc,
      id,
      name: overrides.name ?? doc.frontmatter.name,
      avatar: overrides.avatar ?? doc.frontmatter.avatar ?? defaultAvatar(id),
      overrides,
      doc: source,
      docError,
      custom: false,
      marketplace: false,
      revoked: null,
    };
  }

  /** The clanks installed from a marketplace, each with why it was taken down, if it was. */
  private fromMarketplace(): Map<string, string | null> {
    const rows = this.options.db.select().from(pkg).all();
    return new Map(
      rows
        .filter((row) => row.kind === 'clank')
        .map((row) => [
          row.packageId,
          row.status === 'revoked'
            ? `It was taken down from its marketplace${row.notice ? `: ${row.notice}` : '.'}`
            : null,
        ]),
    );
  }

  /** The library's docs that aren't edited copies of a premade clank's. */
  private customIds(): ClankId[] {
    let files: string[];
    try {
      files = readdirSync(this.options.editedDir);
    } catch {
      return [];
    }
    return files
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.slice(0, -3))
      .filter((id) => !this.bundled.has(id) && clankIdSchema.safeParse(id).success);
  }

  private loadCustom(id: ClankId): Clank {
    const doc = parseClankDoc(this.readEdited(id) ?? '');
    if (doc.frontmatter.id !== id) {
      throw new CrewDocError(`${id}.md says its id is ${doc.frontmatter.id}`);
    }
    const overrides = this.readOverrides(id);
    const installed = this.fromMarketplace();
    return {
      ...doc,
      id,
      name: overrides.name ?? doc.frontmatter.name,
      avatar: overrides.avatar ?? doc.frontmatter.avatar ?? defaultAvatar(id),
      overrides,
      doc: 'edited',
      docError: null,
      custom: true,
      marketplace: installed.has(id),
      revoked: installed.get(id) ?? null,
    };
  }

  private readOverrides(id: ClankId): ClankOverrides {
    const row = this.options.db.select().from(clankTable).where(eq(clankTable.id, id)).get();
    const avatar = avatarSchema.safeParse(row?.avatar);
    const tools = toolOverridesSchema.safeParse(row?.tools ?? {});
    const browser = clankBrowserSchema.safeParse(row?.browser ?? defaultClankBrowser);
    return {
      name: row?.name ?? null,
      avatar: avatar.success ? avatar.data : null,
      model: row?.provider && row.model ? { provider: row.provider, model: row.model } : null,
      tools: tools.success ? tools.data : {},
      browser: browser.success ? browser.data : defaultClankBrowser,
    };
  }

  private readEdited(id: ClankId): string | null {
    const file = this.editedPath(id);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  private editedPath(id: ClankId): string {
    return join(this.options.editedDir, `${id}.md`);
  }

  private requireBundled(id: string): string {
    const text = this.bundled.get(id);
    if (text === undefined) throw new CrewDocError(`There's no clank called ${id}`);
    return text;
  }
}

function summarize(clank: Clank): ClankSummary {
  const { frontmatter } = clank;
  return {
    id: clank.id,
    name: clank.name,
    role: frontmatter.role,
    summary: frontmatter.summary,
    avatar: clank.avatar,
    kind: frontmatter.workflow.kind,
    stage: frontmatter.workflow.stage,
    appliesTo: frontmatter.workflow.applies_to ?? [],
    outputs: frontmatter.outputs,
    model: clank.overrides.model,
    doc: clank.doc,
    docError: clank.docError,
    custom: clank.custom,
    marketplace: clank.marketplace,
    minContext: frontmatter.model.min_context,
    needs: frontmatter.model.needs,
    browser: clank.overrides.browser,
  };
}

/** A colour for a clank whose doc doesn't pick one, the same every time. */
function defaultAvatar(id: string): Avatar {
  const colours = avatarSchema.options;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colours[hash % colours.length]!;
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}
