import { EMAIL_PASSWORD } from '@clanks/core';
import type { Painted } from '@clanks/design';
import { describe, expect, it } from 'vitest';
import { tidyDraft, draftRequest } from '../crew/draft';
import type { DesignHost } from '../design/service';
import { DesignService } from '../design/service';
import { EmailError, EmailService, type OutgoingEmail } from '../email/service';
import { startTestOrchestrator, tempDir } from '../test-helpers';
import { htmlPage, markdownHtml, printableHtml, wordDocument } from './document';

const DOC = `# Launch notes

We ship on **14 November**. See the [plan](https://example.com/plan) and \`pnpm build\`.

- One
  - Nested
- Two

1. First
2. Second

> Quoted.

| Board | Price |
| --- | --- |
| Fish | $500 |

\`\`\`sh
pnpm test
\`\`\`

---

<script>alert(1)</script>

And [a trick](javascript:alert(1)) with ![a board](https://example.com/b.png).
`;

describe('documents', () => {
  it('turns Markdown into HTML without trusting what a clank wrote', () => {
    const html = markdownHtml(DOC);
    expect(html).toContain('<h1>Launch notes</h1>');
    expect(html).toContain('<strong>14 November</strong>');
    expect(html).toContain('<a href="https://example.com/plan">plan</a>');
    expect(html).toContain('<table>');
    // Raw HTML is shown as text, a script link loses its address, a picture isn't fetched.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('a trick');
    expect(html).not.toContain('<img');
    expect(html).toContain('[Image: a board]');
  });

  it('makes a page to print, and one to save', () => {
    const printed = printableHtml({
      text: 'To: kai@example.com\n\nHi <Kai>',
      plain: true,
      meta: 'Surf shop · SURF-2',
    });
    expect(printed).toContain('@page { size: A4;');
    expect(printed).toContain('<p class="meta">Surf shop · SURF-2</p>');
    expect(printed).toContain('<pre class="plain">To: kai@example.com\n\nHi &lt;Kai&gt;</pre>');
    const page = htmlPage({ title: 'Launch <notes>', text: '# Launch' });
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<title>Launch &lt;notes&gt;</title>');
    expect(page).toContain('<h1>Launch</h1>');
  });

  it('writes a Word document from every kind of block', async () => {
    const docx = await wordDocument({ title: 'Launch notes', text: DOC, author: 'Sam' });
    // A .docx is a zip, which starts "PK".
    expect([...docx.slice(0, 2)]).toEqual([0x50, 0x4b]);
    expect(docx.byteLength).toBeGreaterThan(2000);
    const plain = await wordDocument({ title: 'Email', text: 'Hi Kai,\n\nSam', plain: true });
    expect([...plain.slice(0, 2)]).toEqual([0x50, 0x4b]);
  });
});

describe('design exports', () => {
  const painted: Painted = {
    key: 'n1',
    x: 0,
    y: 0,
    w: 320,
    h: 200,
    background: 'rgb(250, 250, 250)',
    borders: [
      { w: 0, color: '' },
      { w: 0, color: '' },
      { w: 0, color: '' },
      { w: 0, color: '' },
    ],
    radius: [0, 0],
    opacity: 1,
    clip: false,
    shadow: '',
    children: [],
  };

  function studio(host: DesignHost | null) {
    const dir = tempDir();
    const service = new DesignService({ host, userName: () => 'Sam' });
    service.commit(dir, 'design/site.design', [
      {
        op: 'insert',
        parent: 'p1',
        node: {
          id: 'n1',
          type: 'frame',
          name: 'Promo / X',
          w: 320,
          h: 200,
          layout: 'col',
          children: [{ id: 'n2', type: 'text', name: 'Line', text: 'Find your board.' }],
        },
      },
    ]);
    return { dir, service };
  }

  it('exports a frame as a PNG, an SVG of shapes and text, and a one-page PDF', async () => {
    const asked: unknown[] = [];
    const host: DesignHost = {
      draw: (input) => {
        asked.push(input.capture);
        return Promise.resolve({
          boxes: {},
          width: 320,
          height: 200,
          png: input.capture ? new Uint8Array([0x89, 0x50]) : null,
        });
      },
      paint: () => Promise.resolve(painted),
      print: (input) => {
        asked.push(input.page);
        return Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      },
    };
    const { dir, service } = studio(host);
    const png = await service.exportFrame(dir, { frame: 'promo / x', format: 'png', scale: 2 });
    expect(png.name).toBe('promo-x.png');
    expect([...png.data]).toEqual([0x89, 0x50]);
    expect(asked[0]).toMatchObject({ scale: 2, minScale: 0.1 });
    const svg = await service.exportFrame(dir, { frame: 'n1', format: 'svg' });
    expect(svg.name).toBe('promo-x.svg');
    expect(Buffer.from(svg.data).toString('utf8')).toContain(
      '<title>Promo / X</title>\n<rect x="0" y="0" width="320" height="200" fill="#fafafa"/>',
    );
    const pdf = await service.exportFrame(dir, { frame: 'Promo / X', format: 'pdf' });
    expect(pdf.name).toBe('promo-x.pdf');
    // The page is the frame's own size.
    expect(asked.at(-1)).toEqual({ width: 320, height: 200 });
    await expect(service.exportFrame(dir, { frame: 'Nope', format: 'png' })).rejects.toThrow(
      'There\'s no frame "Nope". Frames: Promo / X.',
    );
  });

  it('says so where frames cannot be drawn', async () => {
    const { dir, service } = studio(null);
    await expect(service.exportFrame(dir, { frame: 'n1', format: 'png' })).rejects.toThrow(
      /can't be drawn here/,
    );
    await expect(service.printDocument('<p>x</p>')).rejects.toThrow(/can't be printed to PDF here/);
    expect(() => service.componentCode(dir, 'Button')).toThrow(/no component "Button"/);
  });
});

describe('the email account', () => {
  function setup() {
    const { context } = startTestOrchestrator();
    const sent: OutgoingEmail[] = [];
    const email = new EmailService({
      settings: context.settings,
      secrets: context.secrets,
      transport: () => ({
        verify: () => Promise.reject(new Error('535 Bad credentials')),
        send: (message) => {
          sent.push(message);
          return Promise.resolve({ messageId: null });
        },
      }),
    });
    return { context, email, sent };
  }
  const account = {
    kind: 'gmail' as const,
    host: '',
    port: 587,
    secure: false,
    user: '',
    from: 'sam@gmail.com',
    name: 'Sam at Surf Shop',
  };

  it('is ready once it has an address and its password is in the keychain', () => {
    const { context, email } = setup();
    expect(email.status()).toMatchObject({ ready: false, kind: 'none' });
    context.settings.update({ email: account });
    expect(email.status()).toMatchObject({
      ready: false,
      problem: "The account's password isn't saved.",
    });
    context.secrets.set(EMAIL_PASSWORD, 'abcdabcdabcdabcd');
    expect(email.status()).toEqual({
      ready: true,
      kind: 'gmail',
      from: '"Sam at Surf Shop" <sam@gmail.com>',
      problem: null,
    });
  });

  it('sends what it is given and nothing else, and never lets a subject start a header', async () => {
    const { context, email, sent } = setup();
    const draft = { to: ['kai@example.com'], cc: [], subject: 'Hi', body: 'Hello' };
    await expect(email.send(draft)).rejects.toThrow(/No email account is set up/);
    context.settings.update({ email: account });
    context.secrets.set(EMAIL_PASSWORD, 'abcdabcdabcdabcd');
    await email.send({
      to: ['Kai <kai@example.com>', 'KAI@example.com'],
      cc: ['lee@example.com'],
      subject: 'Hi\r\nBcc: everyone@example.com',
      body: 'Hello',
    });
    expect(sent).toEqual([
      {
        from: '"Sam at Surf Shop" <sam@gmail.com>',
        to: ['"Kai" <kai@example.com>'],
        cc: ['lee@example.com'],
        subject: 'Hi Bcc: everyone@example.com',
        text: 'Hello',
      },
    ]);
    await expect(email.send({ ...draft, to: [] })).rejects.toThrow(EmailError);
    await expect(email.send({ ...draft, to: ['not an address'] })).rejects.toThrow(
      '"not an address" isn\'t an email address.',
    );
    await expect(email.send({ ...draft, body: ' ' })).rejects.toThrow(/nothing in it/);
    await expect(email.test()).rejects.toThrow(
      'The mail server turned it down: 535 Bad credentials',
    );
  });
});

describe('drafting a custom clank', () => {
  it('asks for the doc with the tools it will have, and tidies what comes back', () => {
    const request = draftRequest({
      name: 'Sentinel',
      role: 'Security',
      description: 'Reviews every PR for security problems.',
      kind: 'checker',
      types: ['pr'],
      tools: ['git_diff', 'fs_read'],
    });
    expect(request).toContain('It is a checker');
    expect(request).toContain('`review_pass`');
    expect(request).toContain('`git_diff`, `fs_read`, `post_progress`');

    const reply =
      '```markdown\n---\nid: x\n---\nHere you go.\n\n# Sentinel\n\nYou are the reviewer. <!-- note -->\n```';
    const tidy = tidyDraft(reply, { name: 'Sentinel', kind: 'checker' });
    expect(tidy).toMatch(/^# Sentinel\n\nYou are the reviewer\./);
    expect(tidy).not.toContain('<!--');
    // A draft that forgot how to finish is given the ending.
    expect(tidy).toContain('## Output\n\nCall `review_pass`');
    expect(tidyDraft('You write docs.', { name: 'Quill 2', kind: 'maker' })).toMatch(
      /^# Quill 2\n\nYou write docs\.\n\n## Output\n\nCall `submit_output`/,
    );
  });
});
