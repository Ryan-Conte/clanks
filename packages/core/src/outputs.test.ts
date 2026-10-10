import { describe, expect, it } from 'vitest';
import { clankFrontmatterSchema, customClankDoc, suggestClankId } from './crew';
import {
  checkOutput,
  citedSources,
  documentPathProblem,
  keepLineBreaks,
  outputDocument,
  parseAddress,
  parseSources,
  postLength,
  postLimit,
} from './outputs';

const NOTE = `# Which payment provider fits a small surf shop?

**Answer.** Stripe, for its fees and its checkout. [1][2]

## Findings
- Stripe charges 1.7% + 30c on domestic cards. [1]
- Square has no monthly fee either. [2, 3]

## Sources
1. Pricing. Stripe, updated 2026-08-14. https://stripe.com/au/pricing (seen 2026-10-05)
2. Fees. Square. https://squareup.com/au/en/pricing.
3. A forum thread, no link
`;

describe('research notes', () => {
  it('reads the sources and what cites them', () => {
    expect(parseSources(NOTE)).toEqual([
      {
        n: 1,
        text: 'Pricing. Stripe, updated 2026-08-14. https://stripe.com/au/pricing (seen 2026-10-05)',
        url: 'https://stripe.com/au/pricing',
      },
      {
        n: 2,
        text: 'Fees. Square. https://squareup.com/au/en/pricing.',
        url: 'https://squareup.com/au/en/pricing',
      },
      { n: 3, text: 'A forum thread, no link', url: null },
    ]);
    expect(citedSources(NOTE)).toEqual([1, 2, 3]);
    // A Markdown link isn't a citation.
    expect(citedSources('See [1](https://example.com) and [2].')).toEqual([2]);
  });

  it('passes a note with cited sources, and warns about one without a URL', () => {
    const check = checkOutput('research', { type: 'research', note: NOTE });
    expect(check.problems).toEqual([]);
    expect(check.warnings).toEqual(["Source 3 has no URL, so it can't be checked."]);
    expect(check.output).toMatchObject({
      title: 'Which payment provider fits a small surf shop?',
      sources: [{ n: 1 }, { n: 2 }, { n: 3 }],
    });
  });

  it('refuses a note with no sources, uncited sources or a citation to nothing', () => {
    expect(checkOutput('research', { note: 'Stripe is best.' }).problems[0]).toMatch(/no sources/);
    expect(
      checkOutput('research', {
        note: 'Stripe is best.\n\n## Sources\n1. Stripe https://stripe.com',
      }).problems[0],
    ).toMatch(/Nothing in the note cites/);
    expect(
      checkOutput('research', {
        note: 'Stripe is best. [1][4]\n\n## Sources\n1. Stripe https://stripe.com',
      }).problems[0],
    ).toMatch(/cites \[4\]/);
    // The note under another name small models use.
    expect(checkOutput('research', { body: NOTE }).problems).toEqual([]);
  });
});

describe('documents and copy', () => {
  it('takes the title from the first heading and keeps a path in the project', () => {
    const check = checkOutput('doc', {
      type: 'doc',
      content: '# Launch notes\n\nWe ship on 14 Nov. Call [TODO: shop phone number].',
      path: 'docs\\launch.md',
    });
    expect(check.problems).toEqual([]);
    expect(check.output).toMatchObject({
      title: 'Launch notes',
      body: expect.stringContaining('We ship') as string,
      path: 'docs/launch.md',
    });
    expect(check.output).not.toHaveProperty('content');
    expect(check.warnings).toEqual(['1 placeholder to fill: shop phone number']);
  });

  it('refuses an empty document, a path outside the project and scripts', () => {
    expect(checkOutput('copy', { title: 'Home' }).problems[0]).toMatch(/Put the copy in `body`/);
    expect(documentPathProblem('../secrets.md')).toMatch(/inside the project/);
    expect(documentPathProblem('C:/Users/x.md')).toMatch(/inside the project/);
    expect(documentPathProblem('docs/launch.exe')).toMatch(/Markdown or text/);
    expect(documentPathProblem('docs/launch.md')).toBeNull();
    expect(
      checkOutput('doc', { title: 'x', body: 'Hi <script>alert(1)</script>' }).problems[0],
    ).toMatch(/raw HTML/);
  });

  it('keeps copy on the lines its writer gave it, and leaves the rest of the Markdown alone', () => {
    const copy = [
      '## Hero',
      '',
      '**Headline**: Your best ride starts here',
      '**Subhead**: Boards for every wave.',
      '**Button**: Shop boards',
      '',
      '- one',
      '- two',
      '',
      '| a | b |',
      '| --- | --- |',
      '',
      '```',
      'line one',
      'line two',
      '```',
      'Last line',
    ].join('\n');
    const kept = keepLineBreaks(copy).split('\n');
    expect(kept[2]).toBe('**Headline**: Your best ride starts here  ');
    expect(kept[3]).toBe('**Subhead**: Boards for every wave.  ');
    // The last line of a block has nothing to break before.
    expect(kept[4]).toBe('**Button**: Shop boards');
    expect(kept.slice(6)).toEqual(copy.split('\n').slice(6));
    // Doing it twice changes nothing more.
    expect(keepLineBreaks(kept.join('\n'))).toBe(kept.join('\n'));
  });

  it('is one document for export, with its title on top once', () => {
    expect(outputDocument({ type: 'doc', title: 'Launch', body: 'We ship.' })).toMatchObject({
      name: 'doc.md',
      text: '# Launch\n\nWe ship.',
    });
    expect(
      outputDocument({ type: 'doc', title: 'Launch', body: '# Launch\n\nWe ship.' })?.text,
    ).toBe('# Launch\n\nWe ship.');
    expect(outputDocument({ type: 'pr', title: 'x' })).toBeNull();
  });
});

describe('emails', () => {
  it('reads addresses however they were written', () => {
    expect(parseAddress('Sam <sam@example.com>')).toEqual({
      name: 'Sam',
      address: 'sam@example.com',
    });
    expect(parseAddress('sam@example')).toBeNull();
    const check = checkOutput('email', {
      to: 'sam@example.com, Kai <kai@example.com>',
      cc: [],
      subject: 'Quote for the 12 May booking',
      body: 'Hi Kai,\n\nHere is the quote.\n\nSam',
    });
    expect(check.problems).toEqual([]);
    expect(check.output).toMatchObject({
      to: ['sam@example.com', 'Kai <kai@example.com>'],
      cc: [],
    });
    expect(outputDocument(check.output)?.text).toBe(
      'To: sam@example.com, Kai <kai@example.com>\nSubject: Quote for the 12 May booking\n\nHi Kai,\n\nHere is the quote.\n\nSam',
    );
  });

  it('refuses a guessed address, and only warns when there is no recipient yet', () => {
    const guessed = checkOutput('email', { to: ['the shop'], subject: 'Hi', body: 'Hello' });
    expect(guessed.problems[0]).toMatch(/"the shop" isn't an email address/);
    const none = checkOutput('email', { subject: 'Hi', body: 'Hello' });
    expect(none.problems).toEqual([]);
    expect(none.warnings).toContain('No recipient yet: add one before sending.');
    expect(checkOutput('email', { body: 'Hello' }).problems).toEqual([
      'Give the email a `subject`.',
    ]);
  });
});

describe('campaigns', () => {
  const plan =
    '## Goal and metric\nSales.\n## Audience\nSurfers.\n## Positioning\nx\n## Channels\ny\n## Calendar\nz';

  it('tidies posts, even as JSON in a string, and checks each fits its platform', () => {
    const check = checkOutput('campaign', {
      title: 'Launch',
      plan,
      posts: JSON.stringify([
        { platform: 'X', handle: '@surfshop', when: '14 Nov 7:00 AEDT', copy: 'x'.repeat(300) },
        { channel: 'Instagram', text: 'Find your board.', visual: 'Promo / Instagram' },
      ]),
    });
    expect(check.problems).toEqual([]);
    expect(check.output.posts).toEqual([
      {
        channel: 'X',
        account: '@surfshop',
        at: '14 Nov 7:00 AEDT',
        text: 'x'.repeat(300),
        visual: null,
      },
      {
        channel: 'Instagram',
        account: null,
        at: null,
        text: 'Find your board.',
        visual: 'Promo / Instagram',
      },
    ]);
    expect(check.warnings).toEqual(['Post 1 is 300 characters; X takes 280.']);
  });

  it('refuses a post without a channel or text, and a missing plan', () => {
    const check = checkOutput('campaign', { posts: [{ text: 'Hi' }, 'nonsense'] });
    expect(checkOutput('campaign', { plan: 'x' }).problems).toHaveLength(1);
    expect(check.problems).toEqual([
      'Put the plan in `plan`, as Markdown.',
      'Post 1 has no `channel`, such as "Instagram".',
      "Post 2 isn't an object. Give each post `channel`, `text` and, when you know them, `account`, `at` and `visual`.",
    ]);
  });

  it('turns back a plan whose posts were left out, but takes one that has none on purpose', () => {
    expect(checkOutput('campaign', { plan }).problems[0]).toMatch(/^The campaign has no `posts`/);
    const none = checkOutput('campaign', { plan, posts: [] });
    expect(none.problems).toEqual([]);
    expect(none.warnings).toEqual(['It has no posts drafted, only the plan.']);
  });

  it('counts a link as X does', () => {
    expect(postLimit('Twitter / X')).toBe(280);
    expect(postLimit('Newsletter')).toBeNull();
    expect(postLength({ channel: 'X', text: `Go: https://example.com/${'a'.repeat(100)}` })).toBe(
      27,
    );
  });
});

describe('custom clanks', () => {
  it('writes a priming doc whose frontmatter is valid', () => {
    const text = customClankDoc({
      id: 'sentinel',
      name: 'Sentinel',
      role: 'Security',
      summary: 'Reviews every pull request: "safe", or not.',
      avatar: 'red',
      kind: 'checker',
      outputs: [],
      stage: 'security',
      after: 'qa',
      appliesTo: ['pr'],
      bounceTo: ['maker'],
      allow: ['review_pass', 'fs_read', 'git_diff'],
      ask: ['shell_exec'],
      tags: ['code'],
      vision: false,
      minContext: 32768,
      temperature: 0.1,
      prompt: '# Sentinel\n\nYou are the security reviewer. Finish with `review_pass`.',
    });
    const [, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
    // Flow lists and quoted strings are plain YAML; this reads them without a YAML parser.
    expect(frontmatter).toContain('summary: "Reviews every pull request: \\"safe\\", or not."');
    expect(frontmatter).toContain('  after: qa');
    expect(frontmatter).toContain('  applies_to: [pr]');
    expect(body!.trim()).toMatch(/^# Sentinel/);
    expect(
      clankFrontmatterSchema.safeParse({
        id: 'sentinel',
        name: 'Sentinel',
        role: 'Security',
        summary: 's',
        outputs: [],
        workflow: { kind: 'checker', stage: 'security', after: 'qa', applies_to: ['pr'] },
        model: {
          tags: ['code'],
          needs: ['tools'],
          prefers: [],
          min_context: 32768,
          temperature: 0.1,
        },
        tools: { allow: ['review_pass'], ask: [] },
      }).success,
    ).toBe(true);
  });

  it('suggests an id from a name', () => {
    expect(suggestClankId('Legal Eagle')).toBe('legal-eagle');
    expect(suggestClankId('007 Bond!')).toBe('bond');
    expect(suggestClankId('!!!')).toBe('clank');
  });
});
