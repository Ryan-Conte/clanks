import {
  ALWAYS_AVAILABLE_TOOLS,
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
  looksSecret,
  toolOverridesSchema,
  toolsMatching,
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
import { clank as clankTable } from '../store/schema';
import type { Db } from '../store/store';
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
}

/** The most a custom clank's prompt may come to with the crew rules, in tokens. */
const MAX_CUSTOM_TOKENS = 6000;
/** What the shipped docs stay under, so they fit small local models. */
export const DOC_TOKEN_BUDGET = 2500;

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
    const { tools, workflow } = doc.frontmatter;
    const listed = [...tools.allow, ...tools.ask, ...tools.deny];
    const unknown = listed.filter(
      (entry) => toolsMatching(entry).length === 0 && !/^mcp_[a-z0-9_]+\*?$/.test(entry),
    );
    if (unknown.length > 0) {
      throw new CrewDocError(
        `${unknown.join(', ')} ${unknown.length === 1 ? "isn't a tool" : "aren't tools"}. Use names from the tool list, or a group such as browser_*.`,
      );
    }
    const given = new Set<string>([
      ...ALWAYS_AVAILABLE_TOOLS,
      ...[...tools.allow, ...tools.ask].flatMap(toolsMatching),
    ]);
    const finish = workflow.kind === 'maker' ? 'submit_output' : 'review_pass';
    if (!given.has(finish)) {
      throw new CrewDocError(
        'A checker passes tickets with review_pass, so its tools must allow it. Add review_pass to its tools.',
      );
    }
    if (!doc.body.includes(finish)) {
      throw new CrewDocError(
        `The prompt never says how to finish. Tell it to call \`${finish}\` when ${workflow.kind === 'maker' ? 'its work is done, and what to put in it' : 'the ticket passes, and `ticket_bounce` when it does not'}.`,
      );
    }
    if (looksSecret(doc.body)) {
      throw new CrewDocError(
        'The prompt has something that looks like a password or key in it. Take it out: prompts go to the model, and to anyone you share the clank with.',
      );
    }
    const tokens = estimateTokens(this.rulesText) + estimateTokens(doc.body);
    if (tokens > MAX_CUSTOM_TOKENS) {
      throw new CrewDocError(
        `With the crew rules the prompt comes to about ${tokens} tokens. Keep it under ${MAX_CUSTOM_TOKENS}; under ${DOC_TOKEN_BUDGET} fits small local models.`,
      );
    }
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
    };
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
    return {
      ...doc,
      id,
      name: overrides.name ?? doc.frontmatter.name,
      avatar: overrides.avatar ?? doc.frontmatter.avatar ?? defaultAvatar(id),
      overrides,
      doc: 'edited',
      docError: null,
      custom: true,
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
