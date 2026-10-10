import { ToolFailure } from '@clanks/tools';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startTestOrchestrator } from '../test-helpers';
import { ArtifactError, sizeText } from './service';

function setup() {
  const { context, paths } = startTestOrchestrator();
  const chat = { ticketId: null, conversationId: randomUUID(), projectId: null };
  return { artifacts: context.artifacts, dir: paths.artifacts, chat };
}

describe('artifacts', () => {
  it('keeps every version saved under a name, and skips a save that changes nothing', () => {
    const { artifacts, dir, chat } = setup();
    const save = (data: string) =>
      artifacts.save({ ...chat, author: 'scout', kind: 'note', name: 'notes.md', data });
    const first = save('Stripe: 1.7%');
    expect(first).toMatchObject({
      name: 'notes.md',
      version: 1,
      mediaType: 'text/markdown',
      size: 12,
      path: `${chat.conversationId}/files/notes.v1.md`,
    });
    expect(save('Stripe: 1.7%')).toMatchObject({ id: first.id, version: 1, unchanged: true });
    const second = save('Stripe: 1.7% + 30c');
    expect(second.version).toBe(2);
    expect(artifacts.list(chat).map((a) => a.version)).toEqual([2, 1]);
    expect(artifacts.text(first.id)).toBe('Stripe: 1.7%');
    expect(existsSync(join(dir, second.path))).toBe(true);
    // A name is looked up whatever its case, so "Notes.md" adds to the same file.
    expect(artifacts.latest(chat, 'NOTES.md')?.id).toBe(second.id);
  });

  it('refuses names that could leave its folder, and files too big to keep', () => {
    const { artifacts, chat } = setup();
    const save = (name: string, data: string | Uint8Array = 'x') =>
      artifacts.save({ ...chat, author: 'scout', kind: 'note', name, data });
    for (const name of ['../x.md', 'a/b.md', 'C:\\x.md', '.hidden', 'a..b.md', '']) {
      expect(() => save(name), name).toThrow(ArtifactError);
    }
    expect(() => save('big.bin', new Uint8Array(9 * 1024 * 1024))).toThrow(/too big to keep/);
    expect(() =>
      artifacts.save({
        ticketId: null,
        conversationId: null,
        projectId: null,
        author: 'scout',
        kind: 'note',
        name: 'a.md',
        data: 'x',
      }),
    ).toThrow(/belongs to a ticket or a chat/);
  });

  it('reads back as its tools do: a list, a file, an earlier version, a long file in parts', () => {
    const { artifacts, chat } = setup();
    const access = artifacts.access({ ...chat, author: 'scout', label: 'this chat' }, 60);
    expect(access.read({ fromLine: 1 })).toBe('Nothing is saved with this chat yet.');
    expect(access.save({ name: 'sources.csv', content: 'a,b' })).toMatch(
      /^Saved sources.csv with this chat \(3 B\)/,
    );
    access.save({ name: 'notes.md', content: 'one' });
    expect(access.save({ name: 'notes.md', content: 'one\ntwo' })).toContain(
      'as version 2; earlier versions are kept',
    );
    expect(access.save({ name: 'notes.md', content: 'one\ntwo' })).toBe(
      'notes.md is the same as version 2, so nothing new was saved.',
    );
    expect(access.read({ fromLine: 1 })).toBe(
      'Saved with this chat:\n\n- notes.md (note, 7 B, by scout, 2 versions)\n- sources.csv (file, 3 B, by scout)',
    );
    expect(access.read({ name: 'notes.md', fromLine: 1 })).toBe(
      'notes.md, version 2 of 2:\n\none\ntwo',
    );
    expect(access.read({ name: 'notes.md', version: 1, fromLine: 1 })).toBe(
      'notes.md, version 1 of 2:\n\none',
    );
    expect(() => access.read({ name: 'notes.md', version: 5, fromLine: 1 })).toThrow(
      'notes.md has no version 5. It has 1, 2.',
    );
    expect(() => access.read({ name: 'missing.md', fromLine: 1 })).toThrow(ToolFailure);
    expect(() => access.save({ name: '../x.md', content: 'x' })).toThrow(ToolFailure);

    access.save({
      name: 'long.txt',
      content: Array.from({ length: 12 }, (_, i) => `line ${i + 1} of the file`).join('\n'),
    });
    const part = access.read({ name: 'long.txt', fromLine: 1 });
    expect(part).toMatch(/^long.txt, version 1, lines 1 to 3 of 12:/);
    expect(part).toContain('[More below: read on with from_line 4.]');
    expect(access.read({ name: 'long.txt', fromLine: 11 })).toBe(
      'long.txt, version 1, lines 11 to 12 of 12:\n\nline 11 of the file\nline 12 of the file',
    );
  });

  it('keeps a picture a tool took, and only one the app saved itself', () => {
    const { artifacts, dir, chat } = setup();
    mkdirSync(join(dir, chat.conversationId), { recursive: true });
    writeFileSync(join(dir, chat.conversationId, 'o1.jpg'), new Uint8Array([0xff, 0xd8, 0xff]));
    const scope = { ...chat, author: 'scout' };
    const kept = artifacts.keepPicture(scope, `${chat.conversationId}/o1.jpg`, 'source-1');
    expect(kept).toMatchObject({
      name: 'source-1.jpg',
      kind: 'screenshot',
      mediaType: 'image/jpeg',
    });
    expect([...artifacts.read(kept!.id)]).toEqual([0xff, 0xd8, 0xff]);
    expect(() => artifacts.text(kept!.id)).toThrow(/isn't text/);
    expect(artifacts.keepPicture(scope, `${chat.conversationId}/gone.jpg`, 'x')).toBeNull();
    expect(artifacts.keepPicture(scope, '../secrets.json', 'x')).toBeNull();
    expect(artifacts.keepPicture(scope, `${chat.conversationId}/../clanks.db`, 'x')).toBeNull();

    artifacts.removeConversation(chat.conversationId);
    expect(artifacts.list(chat)).toEqual([]);
  });

  it('says sizes as people do', () => {
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(1536)).toBe('1.5 kB');
    expect(sizeText(3 * 1024 * 1024)).toBe('3 MB');
  });
});
