import { type Design, type FrameNode, type Geometry, findNode, nodesNamed } from '@clanks/design';
import { ToolFailure } from '@clanks/tools';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test-helpers';
import { designAccess } from './access';
import { type DesignHost, DesignService } from './service';

const TOKENS = [
  { name: 'color.neutral.50', value: '#fafafa' },
  { name: 'color.neutral.900', value: '#111113' },
  { name: 'color.blue.500', value: '#0a6cff' },
  { name: 'color.bg', value: '{color.neutral.50}', modes: { dark: '{color.neutral.900}' } },
  { name: 'color.text', value: '{color.neutral.900}', modes: { dark: '{color.neutral.50}' } },
  { name: 'color.brand', value: '{color.blue.500}' },
  { name: 'color.on-brand', value: '#ffffff' },
  { name: 'space.2', value: 8 },
  { name: 'space.4', value: 16 },
  { name: 'radius.md', value: 8 },
  { name: 'font.family.sans', value: 'Inter' },
  {
    name: 'type.display',
    value: { font: '{font.family.sans}', size: 48, weight: 700, lineHeight: 1.1 },
  },
  { name: 'type.body', value: { font: '{font.family.sans}', size: 16, lineHeight: 1.5 } },
];

const HOME = `
<Frame name="Home / Desktop" w=1440 layout=col gap={space.4} pad={space.4} fill={color.bg}>
  <Text name="Headline" style={type.display} color={color.text}>Find your next board.</Text>
  <Frame name="Button" layout=row padX={space.4} padY={space.2} fill={color.brand} radius={radius.md}>
    <Text name="Label" style={type.body} color={color.on-brand}>Take the quiz</Text>
  </Frame>
</Frame>`;

function setup(host: DesignHost | null = null) {
  const dir = tempDir();
  const edits: { conversationId: string; file: string; lines: Record<string, string> }[] = [];
  const service = new DesignService({
    host,
    userName: () => 'Sam',
    userEdited: (conversationId, file, lines) => edits.push({ conversationId, file, lines }),
  });
  const access = designAccess(service, { dir, conversationId: 'run-1', maxChars: 20_000 });
  const design = (): Design => service.load(dir, 'design/site.design').state.design;
  const id = (name: string) => nodesNamed(design(), name)[0]!.id;
  return { dir, service, access, edits, design, id };
}

async function built(host: DesignHost | null = null) {
  const made = setup(host);
  await made.access.setTokens({ tokens: TOKENS, remove: [] });
  await made.access.create({ markup: HOME });
  return made;
}

describe('the design tools', () => {
  it('say where to start when there is no design', async () => {
    const { access } = setup();
    expect(await access.read({})).toMatch(/There's no design yet .* no tokens either/);
    await expect(access.lint({})).rejects.toThrow(/no design to check yet/);
  });

  it('set tokens, build frames and write them where git can read them', async () => {
    const { dir, access } = setup();
    expect(await access.setTokens({ tokens: TOKENS, remove: [] })).toMatch(
      /added 13\. The project now has 13: color 7, space 2, radius 1, font 1, type 2/,
    );
    const created = await access.create({ markup: HOME });
    expect(created).toMatch(/^Added 4 layers to the page "Page 1" in design\/site\.design\./);
    expect(created).toMatch(/\[n\d+\] Frame "Home \/ Desktop" x=0 y=0 w=1440 layout=col/);
    for (const file of [
      'tokens.tokens.json',
      'site.design/document.json',
      'site.design/pages/p1.json',
    ]) {
      expect(existsSync(join(dir, 'design', file)), file).toBe(true);
    }
    const page = JSON.parse(
      readFileSync(join(dir, 'design/site.design/pages/p1.json'), 'utf8'),
    ) as {
      children: FrameNode[];
    };
    expect(page.children[0]!.children).toHaveLength(2);
    const read = await access.read({});
    expect(read).toContain('design/site.design: 1 page, 0 components, 13 tokens');
    expect(read).toContain(
      'Text "Headline" style={type.display} color={color.text}: "Find your next board."',
    );
    expect(await access.read({ tokens: true })).toContain(
      '{color.bg} {color.neutral.50}, dark {color.neutral.900}',
    );
    expect(await access.read({ tokens: 'css' })).toContain('--color-brand: var(--color-blue-500);');
  });

  it('refuse a token, an icon or an image that is not there, saying what is', async () => {
    const { access } = await built();
    await expect(access.create({ markup: '<Frame fill={color.brnad} />' })).rejects.toThrow(
      /isn't a token \(did you mean \{color.brand\}\?\)/,
    );
    await expect(access.create({ markup: '<Frame gap={color.brand} />' })).rejects.toThrow(
      /gap takes a dimension token and \{color.brand\} is a color/,
    );
    await expect(access.create({ markup: '<Icon icon="shoping-cart" />' })).rejects.toThrow(
      /no icon called "shoping-cart"/,
    );
    await expect(
      access.create({ markup: '<Image src="design/assets/nope.png" />' }),
    ).rejects.toThrow(/isn't an image in the project/);
    await expect(access.create({ markup: '<Frame>' })).rejects.toBeInstanceOf(ToolFailure);
  });

  it('add the wireframe tokens the first time one is used', async () => {
    const { access, service, dir } = setup();
    await access.create({
      markup:
        '<Frame name="Wire" w=390 fill={wire.bg}><Rect name="Hero" w=fill h=120 fill={wire.fill} /></Frame>',
    });
    const { tokens } = service.load(dir, 'design/site.design').state;
    expect(tokens.tokens.map((t) => t.path)).toEqual(['wire.bg', 'wire.fill']);
  });

  it('put new frames side by side, and new pages where a new name is given', async () => {
    const { access, design } = await built();
    await access.create({
      markup: '<Frame name="Home / Mobile" w=390 layout=col fill={color.bg} />',
    });
    const made = await access.create({
      markup: '<Frame name="Flow" w=200 fill={color.bg} />',
      parent: 'Flows',
    });
    expect(made).toContain('Made the page "Flows"');
    const [first, second] = design().pages;
    expect(first!.children.map((n) => n.x)).toEqual([0, 1520]);
    expect(second).toMatchObject({ name: 'Flows', children: [{ name: 'Flow', x: 0 }] });
    await expect(access.create({ markup: '<Text>x</Text>', parent: 'n999' })).rejects.toThrow(
      /no layer or page n999/,
    );
  });

  it('update layers by id, with properties named as in markup', async () => {
    const { access, design, id } = await built();
    const said = await access.update({
      updates: [
        { id: id('Headline'), set: { text: 'Ride more.', fontSize: null, align: 'center' } },
        { id: id('Button'), set: { padding: '8px 24px', bg: '{color.text}' } },
      ],
    });
    expect(said).toMatch(/^Changed 2 layers\./);
    expect(findNode(design(), id('Headline'))).toMatchObject({
      text: 'Ride more.',
      textAlign: 'center',
    });
    expect(findNode(design(), id('Button'))).toMatchObject({
      pad: [8, 24, 8, 24],
      fill: '{color.text}',
    });
    await expect(
      access.update({ updates: [{ id: id('Headline'), set: { gap: 4 } }] }),
    ).rejects.toThrow(/\[n\d+\] "Headline": It has no "gap"/);
    await expect(access.update({ updates: [{ id: 'Nope', set: {} }] })).rejects.toThrow(
      /no layer "Nope"/,
    );
  });

  it('keep what the user changed by hand, and say so once', async () => {
    const { dir, service, access, edits, design, id } = await built();
    const button = id('Button');
    service.applyUser({
      dir,
      ops: [{ op: 'update', id: button, set: { fill: '{color.text}' } }],
      conversationId: 'run-1',
    });
    expect(edits.at(-1)).toMatchObject({
      conversationId: 'run-1',
      file: 'design/site.design',
      lines: { [`${button}.fill`]: `[${button}] "Button" fill → {color.text}` },
    });
    // The clank, not knowing, restyles the same button: its fill is kept, the rest goes through.
    const said = await access.update({
      updates: [{ id: button, set: { fill: '{color.brand}', radius: 0 } }],
    });
    expect(said).toContain('Sam changed these by hand while you worked');
    expect(said).toContain(`[${button}] "Button" fill → {color.text}`);
    expect(findNode(design(), button)).toMatchObject({ fill: '{color.text}', radius: 0 });
    // Now it knows, a second change is its own decision.
    await access.update({ updates: [{ id: button, set: { fill: '{color.brand}' } }] });
    expect(findNode(design(), button)).toMatchObject({ fill: '{color.brand}' });
  });

  it("won't delete what the user just changed without being told first", async () => {
    const { dir, service, access, design, id } = await built();
    const button = id('Button');
    service.applyUser({
      dir,
      ops: [{ op: 'update', id: id('Label'), set: { text: 'Start' } }],
      conversationId: 'run-1',
    });
    expect(await access.remove({ ids: [button] })).toMatch(
      /Nothing was deleted\.[\s\S]*"Label" text → Start/,
    );
    expect(findNode(design(), button)).not.toBeNull();
    service.told('run-1');
    expect(await access.remove({ ids: [button] })).toMatch(
      /Deleted \[n\d+\] "Button": 2 layers in all/,
    );
  });

  it('make a component with properties from its text, and add variants to it', async () => {
    const { access, design, id } = await built();
    const made = await access.makeComponent({
      node: id('Button'),
      name: 'Button',
      variant: 'primary',
    });
    expect(made).toMatch(
      /Made the component Button \(c\d+\) with the variant "primary"\. Its properties: text\./,
    );
    const component = design().components[0]!;
    expect(component.props).toEqual([{ name: 'text', type: 'text', default: 'Take the quiz' }]);
    const home = nodesNamed(design(), 'Home / Desktop')[0] as FrameNode;
    expect(home.children[1]).toMatchObject({
      type: 'instance',
      component: component.id,
      variant: 'primary',
    });

    await access.create({
      parent: home.id,
      markup:
        '<Instance of="Button" variant="primary" text="Shop boards" /><Frame name="Ghost" layout=row padX={space.4} padY={space.2}><Text style={type.body} color={color.text}>Later</Text></Frame>',
    });
    expect(
      await access.makeComponent({ node: id('Ghost'), name: 'button', variant: 'ghost' }),
    ).toMatch(/Added the variant "ghost" to Button/);
    expect(design().components[0]!.variants.map((v) => v.name)).toEqual(['primary', 'ghost']);
    expect(design().components[0]!.props).toHaveLength(1);
    expect(await access.read({ node: 'Button' })).toContain('Variant ghost:');
    await expect(
      access.create({ markup: '<Instance of="Button" variant="huge" />', parent: home.id }),
    ).rejects.toThrow(/has no variant "huge". Its variants: primary, ghost/);
  });

  it('link layers to frames for the prototype', async () => {
    const { access, design, id } = await built();
    await access.create({
      markup: '<Frame name="Quiz / Desktop" w=1440 layout=col fill={color.bg} />',
    });
    expect(await access.link({ from: id('Button'), to: 'Quiz / Desktop' })).toMatch(
      /Clicking \[n\d+\] "Button" now goes to "Quiz \/ Desktop"/,
    );
    expect(design().links).toEqual([{ from: id('Button'), to: id('Quiz / Desktop') }]);
    await access.link({ from: id('Button'), to: null });
    expect(design().links).toEqual([]);
  });

  it('refuse to delete a token that is still used', async () => {
    const { access } = await built();
    await expect(access.setTokens({ tokens: [], remove: ['color.brand'] })).rejects.toThrow(
      /\{color.brand\} is still used by \[n\d+\] "Button"/,
    );
    await expect(access.setTokens({ tokens: [], remove: ['color.blue.500'] })).rejects.toThrow(
      /still used by \{color.brand\}/,
    );
  });
});

describe('lint and hand-in', () => {
  it('check without measuring when there is no app to draw with', async () => {
    const { access } = await built();
    expect(await access.lint({})).toBe(
      "No problems in 1 frame. Sizes weren't measured here, so overflow and tap targets weren't checked.",
    );
    await expect(access.render({ frame: 'Home / Desktop' })).rejects.toThrow(/can't be drawn here/);
  });

  it('measure frames in the app, and picture them', async () => {
    const drawn: { width: number; capture: object | null; html: string }[] = [];
    const host: DesignHost = {
      draw: (input) => {
        drawn.push(input);
        const keys = [...input.html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]!);
        const boxes: Geometry = Object.fromEntries(
          keys.map((key, i) => [
            key,
            { x: 0, y: i * 10, w: i === 0 ? 390 : 500, h: 10, sw: 500, sh: 10 },
          ]),
        );
        return Promise.resolve({
          boxes,
          width: input.width,
          height: 800,
          png: input.capture ? new Uint8Array([137, 80, 78, 71]) : null,
        });
      },
    };
    const { access } = setup(host);
    await access.setTokens({ tokens: TOKENS, remove: [] });
    await access.create({
      markup:
        '<Frame name="Home / Mobile" w=390 layout=col fill={color.bg}><Text name="Wide" style={type.body} color={color.text}>Too wide</Text></Frame>',
    });
    expect(await access.lint({ frame: 'Home / Mobile' })).toMatch(
      /1 error and 0 warnings in 1 frame[\s\S]*"Wide" is 110px wider than the room in its frame "Home \/ Mobile"/,
    );
    expect(drawn[0]).toMatchObject({ width: 390, capture: null });
    expect(drawn[0]!.html).toContain('--color-bg: var(--color-neutral-50);');
    const picture = await access.render({ frame: 'Wide', mode: 'dark' });
    expect(picture.content).toMatch(
      /Drew "Home \/ Mobile" \(the frame \[n\d+\] is in\) in dark mode: 390×800/,
    );
    expect(picture.image?.mediaType).toBe('image/png');
    expect(drawn.at(-1)!.html).toContain('--color-bg: var(--color-neutral-900);');
    await expect(access.render({ frame: 'Wide', mode: 'sepia' })).rejects.toThrow(
      /no mode "sepia"/,
    );
  });

  it('let a design be handed in only when nothing in it is broken', async () => {
    const { dir, service, access, id } = setup();
    await expect(service.check(dir)).rejects.toThrow(/no design to hand in yet/);
    await access.setTokens({ tokens: TOKENS, remove: [] });
    await access.create({ markup: HOME });
    expect(await service.check(dir)).toEqual({
      file: 'design/site.design',
      frames: ['Home / Desktop'],
      lint: 'no problems',
    });
    // The user deletes a token the design uses: it's broken until that's fixed.
    service.applyUser({
      dir,
      ops: [{ op: 'token.remove', path: 'radius.md' }],
      conversationId: null,
    });
    await expect(service.check(dir)).rejects.toThrow(
      /isn't ready to hand in[\s\S]*radius uses \{radius.md\}/,
    );
    await access.update({ updates: [{ id: id('Button'), set: { radius: 6 } }] });
    expect((await service.check(dir)).lint).toBe('1 error and 0 warnings left');
  });
});

describe('what a builder is told of the design', () => {
  it('has the language, the tokens and the frames, within a budget', async () => {
    const { dir, service, access, id } = await built();
    await access.makeComponent({ node: id('Button'), name: 'Button' });
    mkdirSync(join(dir, 'design'), { recursive: true });
    writeFileSync(join(dir, 'design/DESIGN.md'), '# Surf shop\n\nCalm, bright, fast.\n');
    const text = service.handoff(dir, { frames: ['home / desktop'], budget: 3000 })!;
    expect(text).toContain('## Design');
    expect(text).toContain('Calm, bright, fast.');
    expect(text).toContain('{color.brand} {color.blue.500}');
    expect(text).toContain('`{color.brand}` is `var(--color-brand)`');
    expect(text).toContain('Frame "Home / Desktop" x=0 y=0 w=1440 layout=col');
    expect(text).toContain('Component Button');
    expect(service.handoff(dir, { frames: [], budget: 200 })!.length).toBeLessThan(2600);
    expect(service.handoff(tempDir(), { frames: [], budget: 3000 })).toBeNull();
  });
});

describe('Studio', () => {
  it('sees a design change by its revision, and the files it could show', async () => {
    const { dir, service, access, id } = await built();
    const before = service.snapshot(dir);
    expect(before).toMatchObject({
      files: ['design/site.design'],
      file: 'design/site.design',
      language: false,
    });
    const changes: string[] = [];
    service.on('change', (changed) => changes.push(changed));
    await access.update({ updates: [{ id: id('Headline'), set: { text: 'Hello' } }] });
    expect(changes).toEqual([dir]);
    expect(service.snapshot(dir).rev).not.toBe(before.rev);
    expect(service.snapshot(tempDir())).toMatchObject({
      files: [],
      design: null,
      rev: expect.any(String) as string,
    });
  });

  it('keeps images the user brings in under free names', () => {
    const { dir, service } = setup();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(service.addAsset(dir, 'Hero Shot.PNG', png).path).toBe('design/assets/hero-shot.png');
    expect(service.addAsset(dir, 'hero shot.png', png).path).toBe('design/assets/hero-shot-2.png');
    expect(service.asset(dir, 'design/assets/hero-shot.png')).toMatch(
      /^data:image\/png;base64,iVBORw/,
    );
    expect(service.asset(dir, '../outside.png')).toBeNull();
    expect(() => service.addAsset(dir, 'notes.txt', png)).toThrow(/isn't an image/);
  });

  it('exports the tokens beside them', async () => {
    const { dir, service } = await built();
    const { path, text } = service.exportTokens(dir, 'tailwind', true);
    expect(path).toBe('design/tokens.tailwind.css');
    expect(readFileSync(join(dir, path), 'utf8')).toBe(text);
    expect(text).toContain('--color-brand: #0a6cff;');
  });
});
