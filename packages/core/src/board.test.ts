import { describe, expect, it } from 'vitest';
import {
  type Ticket,
  type WorkflowMember,
  bounceTargets,
  columnOf,
  moveRefusal,
  parseCriterion,
  routeFor,
} from './board';
import { suggestKey } from './projects';
import { changedStories, criteriaOf, normalizeStoryId, parseSpec } from './spec';

const member = (m: Partial<WorkflowMember> & Pick<WorkflowMember, 'id'>): WorkflowMember => ({
  name: m.id.charAt(0).toUpperCase() + m.id.slice(1),
  kind: 'maker',
  stage: 'build',
  appliesTo: [],
  outputs: [],
  bounceTo: [],
  ...m,
});

const crew: WorkflowMember[] = [
  member({ id: 'atlas', kind: 'checker', stage: 'signoff', appliesTo: ['all'], bounceTo: ['all'] }),
  member({ id: 'scribe', stage: 'spec', outputs: ['spec'], bounceTo: ['atlas'] }),
  member({ id: 'prism', stage: 'design', outputs: ['design'], bounceTo: ['scribe'] }),
  member({ id: 'forge', outputs: ['pr'], bounceTo: ['scribe'] }),
  member({
    id: 'gauge',
    kind: 'checker',
    stage: 'qa',
    appliesTo: ['pr'],
    bounceTo: ['maker', 'scribe'],
  }),
  member({
    id: 'sentinel',
    kind: 'checker',
    stage: 'security',
    after: 'qa',
    appliesTo: ['pr'],
    bounceTo: ['maker'],
  }),
];

describe('routes', () => {
  it('go maker, then the checkers for the type in stage order, ending with sign-off', () => {
    expect(routeFor('pr', 'forge', crew).map((s) => s.clankId)).toEqual([
      'forge',
      'gauge',
      'sentinel',
      'atlas',
    ]);
    expect(routeFor('spec', 'scribe', crew).map((s) => s.clankId)).toEqual(['scribe', 'atlas']);
    expect(routeFor('design', null, crew)).toEqual([
      { clankId: null, role: 'maker' },
      { clankId: 'atlas', role: 'checker' },
    ]);
  });

  it('let a checker send work back only to who it names', () => {
    const route = routeFor('pr', 'forge', crew);
    expect(bounceTargets(crew[4]!, route, crew).sort()).toEqual(['forge', 'scribe']);
    expect(bounceTargets(crew[0]!, route, crew)).not.toContain('atlas');
    expect(bounceTargets(crew[0]!, route, crew)).toContain('prism');
  });
});

describe('columns', () => {
  const ticket = (step: number, done = false) =>
    ({ step, route: routeFor('pr', 'forge', crew), doneAt: done ? new Date() : null }) as Ticket;

  it('follow where a ticket is on its route', () => {
    expect(columnOf(ticket(-1))).toBe('backlog');
    expect(columnOf(ticket(0))).toBe('build');
    expect(columnOf(ticket(1))).toBe('review');
    expect(columnOf(ticket(3))).toBe('review');
    expect(columnOf(ticket(4))).toBe('ready');
    expect(columnOf(ticket(4, true))).toBe('done');
  });

  it('only let the user reorder the backlog by dragging', () => {
    expect(moveRefusal(ticket(-1), 'backlog')).toBeNull();
    expect(moveRefusal(ticket(-1), 'done')).toMatch(/approving/);
    expect(moveRefusal(ticket(0), 'review')).toMatch(/crew moves/);
    expect(moveRefusal(ticket(4, true), 'backlog')).toMatch(/Done/);
  });
});

const SPEC = `# Surf shop: spec

## Overview
A shop for surf boards.

## Stories

### US-1 Browse boards
As a shopper, I want to see every board, so that I can pick one.

Acceptance criteria
- AC-1.1: Given the shop, when I open it, then I see the boards with prices.
- **AC-1.2**: Sold-out boards say so.

Edge cases
- No boards in stock: the page says so.

### US-2: Checkout
As a shopper, I want to pay by card.

#### Acceptance criteria
- AC-2.1: Given a cart, when I pay, then I see an order number.
- AC-3.1: A declined card keeps the cart.

### US-3 Gift cards (Removed in v2)

## Non-functional
- Loads in under 2 seconds on 4G.
`;

describe('the spec parser', () => {
  it('picks out stories, criteria and edge cases', () => {
    const { stories, problems } = parseSpec(SPEC);
    expect(stories.map((s) => [s.id, s.title, s.criteria.map((c) => c.id), s.removed])).toEqual([
      ['US-1', 'Browse boards', ['AC-1.1', 'AC-1.2'], false],
      ['US-2', 'Checkout', ['AC-2.1', 'AC-3.1'], false],
      ['US-3', 'Gift cards (Removed in v2)', [], true],
    ]);
    expect(stories[0]!.text).toBe(
      'As a shopper, I want to see every board, so that I can pick one.',
    );
    expect(stories[0]!.criteria[1]!.text).toBe('Sold-out boards say so.');
    expect(stories[0]!.edgeCases).toEqual(['No boards in stock: the page says so.']);
    expect(problems).toEqual(['AC-3.1 is under US-2; number it AC-2.x']);
  });

  it('says what is missing', () => {
    expect(parseSpec('# Nothing here').problems[0]).toMatch(/no stories/);
    expect(parseSpec('### US-1 A\n\nText.\n\n### US-1 B\n- AC-1.1: x').problems).toEqual([
      'US-1 has no acceptance criteria',
      'US-1 is used twice; give the second a new number',
    ]);
  });

  it('ignores code blocks', () => {
    expect(parseSpec('```\n### US-9 Not a story\n```\n').stories).toEqual([]);
  });

  it('copies criteria from stories and finds what changed', () => {
    const { stories } = parseSpec(SPEC);
    expect(criteriaOf(['us-2', 'US-9'], stories).map((c) => c.id)).toEqual(['AC-2.1', 'AC-3.1']);
    const next = parseSpec(SPEC.replace('see an order number', 'see an order number by email'));
    expect(changedStories(stories, next.stories)).toEqual(['US-2']);
    expect(normalizeStoryId('us4')).toBe('US-4');
    expect(normalizeStoryId('4')).toBe('US-4');
    expect(normalizeStoryId('US-1: Browse Catalog')).toBe('US-1');
    expect(normalizeStoryId('Story about checkout')).toBe('STORY ABOUT CHECKOUT');
  });
});

describe('criteria and keys', () => {
  it('reads a criterion with or without its id', () => {
    expect(parseCriterion('AC-4.2: Given a card')).toEqual({ id: 'AC-4.2', text: 'Given a card' });
    expect(parseCriterion('**ac-4.2** - Given')).toEqual({ id: 'AC-4.2', text: 'Given' });
    expect(parseCriterion('npm run build succeeds')).toEqual({
      id: null,
      text: 'npm run build succeeds',
    });
  });

  it('suggests ticket key letters from a name', () => {
    expect(suggestKey('Surf shop')).toBe('SURF');
    expect(suggestKey('a b c')).toBe('ABC');
    expect(suggestKey('2048 clone')).toBe('P2C');
    expect(suggestKey('Café')).toBe('CAFE');
    expect(suggestKey('!!')).toBe('PRJ');
  });
});
