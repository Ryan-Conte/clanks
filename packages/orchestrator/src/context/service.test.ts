import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { project } from '../store/schema';
import { openStore } from '../store/store';
import { migrationsFolder, tempDir } from '../test-helpers';
import { ContextService, fitLines, ftsQuery, noteRef } from './service';

function setup() {
  const store = openStore({ file: join(tempDir(), 'clanks.db'), migrationsFolder });
  const now = new Date('2026-10-06T00:00:00Z');
  for (const [id, name] of [
    ['p1', 'Surf shop'],
    ['p2', 'Other'],
  ]) {
    store.db
      .insert(project)
      .values({
        id: id!,
        name: name!,
        brief: '',
        key: id!.toUpperCase(),
        folder: '/tmp',
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  const context = new ContextService({ db: store.db });
  return { context, close: () => store.close() };
}

describe('project notes', () => {
  it('are searched by meaning words, kept to their project and live ones', () => {
    const { context, close } = setup();
    const note = (title: string, extra: Partial<Parameters<ContextService['addNote']>[0]> = {}) =>
      context.addNote({
        projectId: 'p1',
        kind: 'decision',
        title,
        body: '',
        why: '',
        author: 'forge',
        ticketId: 't1',
        status: 'provisional',
        ...extra,
      });
    const cart = note('Cart state lives in Zustand', { why: 'The quiz shares it' });
    note('Prices include GST', { kind: 'fact', author: 'user', status: 'active', ticketId: null });
    context.addNote({
      projectId: 'p2',
      kind: 'fact',
      title: 'Cart lives in Redux',
      body: '',
      why: '',
      author: 'user',
      ticketId: null,
      status: 'active',
    });

    expect(
      context.searchNotes('p1', 'Where does the cart state live?').map((n) => n.title),
    ).toEqual(['Cart state lives in Zustand']);
    expect(context.searchNotes('p1', 'GST on prices')[0]!.title).toBe('Prices include GST');
    expect(context.findNote('p1', noteRef(cart))?.id).toBe(cart.id);

    // A newer note replaces an older one, which stays in history.
    const next = note('Cart state lives in a React context', { supersedes: cart.id });
    expect(context.note(cart.id).status).toBe('superseded');
    expect(context.searchNotes('p1', 'cart').map((n) => n.id)).toEqual([next.id]);

    // Approving the ticket settles its notes; rejecting another drops them.
    expect(context.activateForTicket('p1', 't1')).toBe(1);
    expect(context.note(next.id).status).toBe('active');
    note('Use pnpm', { ticketId: 't2' });
    context.dropForTicket('p1', 't2');
    expect(context.notes('p1').map((n) => n.title)).toEqual([
      'Cart state lives in a React context',
      'Prices include GST',
    ]);

    // Edits are searchable straight away.
    context.updateNote(next.id, { title: 'Basket state lives in a React context' });
    expect(context.searchNotes('p1', 'basket').map((n) => n.id)).toEqual([next.id]);
    close();
  });

  it('never keep a secret', () => {
    const { context, close } = setup();
    expect(() =>
      context.addNote({
        projectId: 'p1',
        kind: 'link',
        title: 'Stripe key',
        body: 'sk_test_51HabcdefGHIJKLmnopqrs',
        why: '',
        author: 'forge',
        ticketId: null,
        status: 'provisional',
      }),
    ).toThrow(/secret/);
    close();
  });
});

describe('clank memory', () => {
  it('is searched per clank, and keeps one entry per chat', () => {
    const { context, close } = setup();
    context.remember({
      projectId: 'p1',
      clankId: 'forge',
      kind: 'decision',
      body: 'Picked Zustand over Redux for the cart: less boilerplate, and the quiz shares it.',
    });
    context.remember({
      projectId: 'p1',
      clankId: 'gauge',
      kind: 'note',
      body: 'The cart tests are flaky on Windows.',
    });
    expect(context.searchMemory('p1', 'forge', 'why zustand for the cart?')).toHaveLength(1);
    expect(context.searchMemory('p1', 'gauge', 'zustand')).toHaveLength(0);

    context.rememberChat({ projectId: 'p1', clankId: 'forge', conversationId: 'c1', body: 'One' });
    context.rememberChat({ projectId: 'p1', clankId: 'forge', conversationId: 'c1', body: 'Two' });
    expect(context.memories('p1', 'forge').filter((m) => m.kind === 'chat')).toMatchObject([
      { body: 'Two' },
    ]);
    close();
  });
});

describe('helpers', () => {
  it('turn words into a safe search, and fit lines to a budget', () => {
    expect(ftsQuery('Where does the "cart" live?')).toBe('"does" OR "cart" OR "live"');
    expect(ftsQuery('a the of')).toBeNull();
    expect(fitLines(['x'.repeat(40), 'y'.repeat(40), 'z'.repeat(40)], 25)).toEqual({
      kept: ['x'.repeat(40), 'y'.repeat(40)],
      left: 1,
    });
  });
});
