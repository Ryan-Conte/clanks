import {
  type Avatar,
  type ClankDocText,
  type ClankId,
  type ClankOverrides,
  type ClankProfilePatch,
  type ClankSummary,
  avatarSchema,
  clankBrowserSchema,
  clankProfilePatchSchema,
  defaultClankBrowser,
  toolOverridesSchema,
} from '@clanks/core';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
}

export interface CrewServiceOptions {
  /** The priming docs that ship with the app. Never written to. */
  bundledDir: string;
  /** The user's edited copies, in the app data folder. */
  editedDir: string;
  db: Db;
}

/**
 * The crew: the premade clanks' priming docs, the user's edited copies of them, and what the user
 * changed in each clank's profile. Emits `change` when any of that changes.
 */
export class CrewService extends EventEmitter<{ change: [] }> {
  private readonly bundled = new Map<ClankId, string>();
  private readonly rulesText: string;
  private cache: Clank[] | null = null;

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

  /** Every clank, in roster order. */
  list(): Clank[] {
    this.cache ??= PREMADE_CREW.map((id) => this.load(id));
    return this.cache;
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
    const bundled = this.requireBundled(id);
    const edited = this.readEdited(id);
    return { id, text: edited ?? bundled, bundled, edited: edited !== null };
  }

  /**
   * Saves the user's edit of a priming doc. It must parse, and keep its id. Saving the bundled text
   * unchanged is the same as resetting it.
   */
  saveDoc(id: ClankId, text: string): ClankSummary {
    const bundled = this.requireBundled(id);
    if (normalize(text) === normalize(bundled)) return this.resetDoc(id);
    const doc = parseClankDoc(text);
    if (doc.frontmatter.id !== id) {
      throw new CrewDocError(`The id must stay ${id}. Create a custom clank to make a new one.`);
    }
    mkdirSync(this.options.editedDir, { recursive: true });
    const file = this.editedPath(id);
    // A sibling file renamed over the old one, so a crash never leaves half a doc.
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
    return this.changed(id);
  }

  /** Goes back to the doc that ships with the app. */
  resetDoc(id: ClankId): ClankSummary {
    this.requireBundled(id);
    rmSync(this.editedPath(id), { force: true });
    return this.changed(id);
  }

  updateProfile(id: ClankId, patch: ClankProfilePatch): ClankSummary {
    this.requireBundled(id);
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
    outputs: frontmatter.outputs,
    model: clank.overrides.model,
    doc: clank.doc,
    docError: clank.docError,
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
