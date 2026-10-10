import { describe, expect, it } from 'vitest';
import { contrast, parseColor } from './color';
import { makeComponent } from './components';
import { changeText, diffDesigns } from './diff';
import { tokensCss, tokensJson, tokensTailwind } from './exports';
import { designPath, parseDesign, serializeDesign } from './files';
import { fontStack } from './fonts';
import { frameHtml } from './html';
import { iconNames, iconShapes } from './icons';
import { type Geometry, issuesText, lint } from './lint';
import { MarkupError, parseMarkup } from './markup';
import { type Op, OpError, type Studio, applyOps } from './ops';
import { renderFrame } from './render';
import { type FrameNode, type Node, emptyDesign } from './schema';
import { designText, nodeLine } from './text';
import {
  type TokenSet,
  WIRE_TOKENS,
  emptyTokens,
  makeToken,
  parseTokens,
  resolveToken,
  serializeTokens,
  tokenCss,
} from './tokens';
import { Ids, findNode, locate, nodesNamed } from './tree';

function tokens(): TokenSet {
  const set = emptyTokens();
  const add = (name: string, value: unknown, dark?: unknown) =>
    set.tokens.push(makeToken(set, { name, value, ...(dark ? { modes: { dark } } : {}) }));
  add('color.neutral.50', '#fafafa');
  add('color.neutral.900', '#111113');
  add('color.blue.500', '#0a6cff');
  add('color.bg', '{color.neutral.50}', '{color.neutral.900}');
  add('color.text', '{color.neutral.900}', '{color.neutral.50}');
  add('color.brand', '{color.blue.500}');
  add('color.on-brand', '#ffffff');
  add('space.2', 8);
  add('space.4', '16px');
  add('radius.md', 8);
  add('font.family.sans', 'Inter');
  add('type.display', { font: '{font.family.sans}', size: 48, weight: 'bold', lineHeight: 1.1 });
  add('type.body', { font: '{font.family.sans}', size: 16, weight: 400, lineHeight: 1.5 });
  add('shadow.card', '0 4px 12px rgba(0,0,0,0.12)');
  return set;
}

function build(markup: string, set = tokens()): { state: Studio; nodes: Node[] } {
  const design = emptyDesign('Test');
  const nodes = parseMarkup(markup, { ids: new Ids(design), design });
  const ops: Op[] = nodes.map((node) => ({ op: 'insert', parent: 'p1', node }));
  return { state: applyOps({ design, tokens: set }, ops).state, nodes };
}

const HOME = `
<Frame name="Home / Desktop" w=1440 layout=col gap={space.4} pad={space.4} fill={color.bg}>
  <Text name="Headline" style={type.display} color={color.text}>Find your next board.</Text>
  <Frame name="Button" layout=row padX={space.4} padY={space.2} fill={color.brand} radius={radius.md}>
    <Text style={type.body} color={color.on-brand}>Take the quiz</Text>
  </Frame>
</Frame>`;

describe('markup', () => {
  it('reads frames, text and tokens, and gives every layer an id', () => {
    const { nodes } = build(HOME);
    const frame = nodes[0] as FrameNode;
    expect(frame).toMatchObject({
      type: 'frame',
      name: 'Home / Desktop',
      w: 1440,
      layout: 'col',
      gap: '{space.4}',
      fill: '{color.bg}',
    });
    expect(frame.children[0]).toMatchObject({
      type: 'text',
      name: 'Headline',
      text: 'Find your next board.',
      style: '{type.display}',
    });
    const button = frame.children[1] as FrameNode;
    expect(button.pad).toEqual(['{space.2}', '{space.4}', '{space.2}', '{space.4}']);
    expect(
      new Set(nodes.flatMap((n) => [n.id, ...(n as FrameNode).children.map((c) => c.id)])).size,
    ).toBe(3);
  });

  it('takes the names people write from habit', () => {
    const [node] = build(
      '<Row width="fill" padding={16} gap="8px" alignItems="center" justifyContent="space-between" bg="#fff"><Icon name="search" /><Text fontSize={14} fontWeight="bold">Hi</Text></Row>',
    ).nodes;
    expect(node).toMatchObject({
      layout: 'row',
      w: 'fill',
      pad: 16,
      gap: 8,
      align: 'center',
      justify: 'between',
      fill: '#fff',
    });
    const [icon, text] = (node as FrameNode).children;
    expect(icon).toMatchObject({ type: 'icon', icon: 'search' });
    expect(text).toMatchObject({ size: 14, weight: 700 });
  });

  it('lays a frame out as a column unless its layers are placed', () => {
    expect((build('<Frame><Text>a</Text></Frame>').nodes[0] as FrameNode).layout).toBe('col');
    expect((build('<Frame><Rect x=10 y=20 /></Frame>').nodes[0] as FrameNode).layout).toBe('none');
  });

  it('keeps an svg as written', () => {
    const [node] = build('<svg viewBox="0 0 10 10" width="40"><path d="M0 0h10"/></svg>').nodes;
    expect(node).toMatchObject({ type: 'vector', w: 40 });
    expect((node as { svg: string }).svg).toContain('<path d="M0 0h10"/>');
  });

  it('says what is wrong and where', () => {
    const fails = (markup: string) => {
      try {
        build(markup);
      } catch (error) {
        expect(error).toBeInstanceOf(MarkupError);
        return (error as Error).message;
      }
      throw new Error('It parsed');
    };
    expect(fails('<Frame>\n  <Blob />\n</Frame>')).toMatch(/Line 2, <Blob>: There's no such tag/);
    expect(fails('<Frame className="x" />')).toMatch(/has no "className". It takes: name/);
    expect(fails('<Frame><Text>a</Frame>')).toMatch(/<\/Frame> closes <Text>/);
    expect(fails('<Frame w="50%" />')).toMatch(/Percentages/);
    expect(fails('<Instance of="Button" />')).toMatch(/no component called "Button"/);
    expect(fails('hello')).toMatch(/outside any tag/);
  });
});

describe('operations', () => {
  it('apply, and undo with what they return', () => {
    const { state, nodes } = build(HOME);
    const headline = (nodes[0] as FrameNode).children[0]!;
    const { state: next, inverse } = applyOps(state, [
      { op: 'update', id: headline.id, set: { text: 'Ride more.', color: null } },
      { op: 'remove', id: (nodes[0] as FrameNode).children[1]!.id },
    ]);
    expect(findNode(next.design, headline.id)).toMatchObject({ text: 'Ride more.' });
    expect(findNode(next.design, headline.id)).not.toHaveProperty('color');
    expect((findNode(next.design, nodes[0]!.id) as FrameNode).children).toHaveLength(1);
    expect(applyOps(next, inverse).state.design).toEqual(state.design);
  });

  it('share what they leave alone', () => {
    const { state, nodes } = build(`${HOME}<Frame name="Other" w=100 h=100 />`);
    const other = findNode(state.design, nodes[1]!.id);
    const { state: next } = applyOps(state, [{ op: 'update', id: nodes[0]!.id, set: { w: 1280 } }]);
    expect(findNode(next.design, nodes[1]!.id)).toBe(other);
    expect(next.tokens).toBe(state.tokens);
  });

  it('refuse what makes no sense', () => {
    const { state, nodes } = build(HOME);
    const frame = nodes[0] as FrameNode;
    expect(() => applyOps(state, [{ op: 'update', id: 'n999', set: {} }])).toThrow(OpError);
    expect(() =>
      applyOps(state, [{ op: 'update', id: frame.children[0]!.id, set: { gap: 4 } }]),
    ).toThrow(/A text layer has no "gap"/);
    expect(() =>
      applyOps(state, [{ op: 'move', id: frame.id, parent: frame.children[1]!.id }]),
    ).toThrow(/into itself/);
    expect(() => applyOps(state, [{ op: 'insert', parent: 'p1', node: frame }])).toThrow(
      /already something with the id/,
    );
    expect(() => applyOps(state, [{ op: 'page.remove', id: 'p1' }])).toThrow(/at least one page/);
  });

  it('make components, whose instances draw them with their properties', () => {
    const { state, nodes } = build(HOME);
    const button = (nodes[0] as FrameNode).children[1] as FrameNode;
    const label = button.children[0]!;
    const { state: next } = applyOps(state, [
      { op: 'remove', id: button.id },
      { op: 'update', id: nodes[0]!.id, set: {} },
      {
        op: 'component.add',
        component: {
          id: 'c50',
          name: 'Button',
          props: [{ name: 'text', type: 'text', default: 'Take the quiz' }],
          variants: [
            {
              name: 'primary',
              root: { ...button, children: [{ ...label, bind: 'text' } as Node] },
            },
          ],
        },
      },
      {
        op: 'insert',
        parent: nodes[0]!.id,
        node: {
          id: 'n60',
          type: 'instance',
          name: 'CTA',
          component: 'c50',
          props: { text: 'Shop boards' },
        },
      },
    ]);
    expect(next.design.nextId).toBe(61);
    const drawn = renderFrame(findNode(next.design, nodes[0]!.id)!, { design: next.design })!;
    const instance = drawn.children[1]!;
    expect(instance).toMatchObject({ key: 'n60', id: 'n60' });
    expect(instance.children[0]).toMatchObject({ id: 'n60', text: 'Shop boards' });
    expect(nodeLine(findNode(next.design, 'n60')!, next.design)).toBe(
      '[n60] Instance "CTA" of=Button text="Shop boards"',
    );
  });

  it('rename a token everywhere it is used', () => {
    const { state, nodes } = build(HOME);
    const { state: next, inverse } = applyOps(state, [
      { op: 'token.rename', path: 'color.brand', to: 'color.primary' },
    ]);
    const button = (findNode(next.design, nodes[0]!.id) as FrameNode).children[1]!;
    expect(button).toMatchObject({ fill: '{color.primary}' });
    expect(resolveToken(next.tokens, 'color.primary', 'light')?.value).toBe('#0a6cff');
    expect(applyOps(next, inverse).state).toEqual(state);
  });

  it("drop a removed frame's prototype links, and bring them back on undo", () => {
    const { state, nodes } = build(`${HOME}<Frame name="Quiz" w=100 h=100 fill={color.bg} />`);
    const button = (nodes[0] as FrameNode).children[1]!;
    const linked = applyOps(state, [{ op: 'link', from: button.id, to: nodes[1]!.id }]).state;
    expect(linked.design.links).toEqual([{ from: button.id, to: nodes[1]!.id }]);
    const { state: gone, inverse } = applyOps(linked, [{ op: 'remove', id: nodes[1]!.id }]);
    expect(gone.design.links).toEqual([]);
    expect(applyOps(gone, inverse).state.design.links).toEqual(linked.design.links);
  });
});

describe('tokens', () => {
  it('read values the way people write them', () => {
    const set = tokens();
    expect(resolveToken(set, 'space.4', 'light')?.value).toBe(16);
    expect(resolveToken(set, 'color.bg', 'dark')?.value).toBe('#111113');
    expect(resolveToken(set, 'type.display', 'light')?.value).toMatchObject({
      fontSize: 48,
      fontWeight: 700,
    });
    expect(resolveToken(set, 'shadow.card', 'light')?.value).toEqual([
      { color: 'rgba(0,0,0,0.12)', offsetX: 0, offsetY: 4, blur: 12, spread: 0 },
    ]);
  });

  it('read a text style a model wrote as JSON inside a string', () => {
    const set = tokens();
    const token = makeToken(set, {
      name: 'type.label',
      value: '{ "font": "{font.family.sans}", "size": 12, "weight": 600, "lineHeight": 1.0 }',
    });
    expect(token).toMatchObject({
      type: 'typography',
      value: { fontFamily: '{font.family.sans}', fontSize: 12, fontWeight: 600, lineHeight: 1 },
    });
    expect(makeToken(set, { name: 'motion.ease.out', value: '[0.2, 0, 0, 1]' }).value).toEqual([
      0.2, 0, 0, 1,
    ]);
  });

  it('refuse a bad name, a bad value and a token that is not there', () => {
    const set = tokens();
    expect(() => makeToken(set, { name: 'Brand Colour', value: '#fff' })).toThrow(
      /isn't a token name/,
    );
    expect(() => makeToken(set, { name: 'color.x', value: 'bluish' })).toThrow(/needs a colour/);
    expect(() => makeToken(set, { name: 'color.x', value: '{color.brnad}' })).toThrow(
      /did you mean \{color.brand\}/,
    );
  });

  it('keep a name a token or a group, never both, and say what to call it instead', () => {
    const set = tokens();
    expect(() => makeToken(set, { name: 'color.text.secondary', value: '#555' })).toThrow(
      /\{color.text\} is a token, so nothing can be named inside it\. Name this one color.text-secondary instead/,
    );
    expect(() => makeToken(set, { name: 'color.neutral', value: '#888' })).toThrow(
      /color.neutral is a group that holds \{color.neutral.50\}/,
    );
    // A file that has one inside the other anyway is read whole.
    const { set: read } = parseTokens({
      color: {
        $type: 'color',
        text: { $value: '#222222', secondary: { $value: '#555555' } },
      },
    });
    expect(read.tokens.map((t) => t.path).sort()).toEqual(['color.text', 'color.text.secondary']);
  });

  it('survive a round trip through the Design Tokens format', () => {
    const set = tokens();
    const json = serializeTokens(set);
    expect(json).toMatchObject({
      color: { blue: { 500: { $type: 'color', $value: { colorSpace: 'srgb', hex: '#0a6cff' } } } },
      space: { 4: { $type: 'dimension', $value: { value: 16, unit: 'px' } } },
    });
    const { set: read, problems } = parseTokens(JSON.parse(JSON.stringify(json)));
    expect(problems).toEqual([]);
    const byPath = (s: TokenSet) => [...s.tokens].sort((a, b) => a.path.localeCompare(b.path));
    expect(byPath(read).map((t) => ({ ...t, value: undefined }))).toEqual(
      byPath(set).map((t) => ({ ...t, value: undefined })),
    );
    expect(resolveToken(read, 'color.bg', 'dark')?.value).toBe('#111113');
    expect(resolveToken(read, 'shadow.card', 'light')?.value).toMatchObject([{ blur: 12 }]);
  });

  it('read the older, plain way of writing values too', () => {
    const { set, problems } = parseTokens({
      color: { $type: 'color', brand: { $value: '#ff0000' } },
      space: { sm: { $type: 'dimension', $value: '8px' } },
      broken: { $type: 'color', $value: 'nope' },
    });
    expect(set.tokens.map((t) => [t.path, t.value])).toEqual([
      ['color.brand', '#ff0000'],
      ['space.sm', 8],
    ]);
    expect(problems).toHaveLength(1);
  });

  it('become CSS custom properties that follow their aliases', () => {
    const set = tokens();
    expect(
      tokenCss(
        set.tokens.find((t) => t.path === 'color.bg')!,
        'dark',
      ),
    ).toEqual([['--color-bg', 'var(--color-neutral-900)']]);
    const css = tokensCss(set);
    expect(css).toContain('--space-4: 16px;');
    expect(css).toContain('--type-display-font-family: var(--font-family-sans);');
    expect(css).toContain("[data-theme='dark'] {\n  --color-bg: var(--color-neutral-900);");
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  it('export as a Tailwind theme and as JSON', () => {
    const set = tokens();
    const tailwind = tokensTailwind(set);
    expect(tailwind).toContain('--color-brand: #0a6cff;');
    expect(tailwind).toContain('--spacing-4: 16px;');
    expect(tailwind).toContain('--text-display: 48px;');
    expect(tailwind).toContain('--text-display--line-height: 1.1;');
    expect(tailwind).toContain("[data-theme='dark'] {\n  --color-bg: #111113;");
    const json = JSON.parse(tokensJson(set)) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(json.dark!.color!.bg).toBe('#111113');
    expect(json.light!.type!.display).toMatchObject({ fontSize: '48px', fontWeight: 700 });
  });
});

describe('drawing', () => {
  it('maps auto layout onto flexbox and tokens onto custom properties', () => {
    const { state, nodes } = build(HOME);
    const drawn = renderFrame(nodes[0]!, { design: state.design })!;
    expect(drawn.style).toMatchObject({
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-4)',
      padding: 'var(--space-4)',
      background: 'var(--color-bg)',
      width: '1440px',
    });
    expect(drawn.children[0]!.style).toMatchObject({
      fontSize: 'var(--type-display-font-size)',
      color: 'var(--color-text)',
    });
    expect(drawn.children[1]!.style.padding).toBe(
      'var(--space-2) var(--space-4) var(--space-2) var(--space-4)',
    );
  });

  it('escapes everything a design holds', () => {
    const { state, nodes } = build(
      '<Frame name="x" w=10><Text>a &lt;script&gt; "b"</Text></Frame>',
    );
    const html = frameHtml(nodes[0]!, {
      design: state.design,
      tokens: state.tokens,
      mode: 'light',
    });
    expect(html).toContain('a &lt;script&gt; "b"');
    expect(html).not.toContain('<script');
    expect(html).toContain('--color-bg: var(--color-neutral-50);');
  });

  it('draws bundled fonts from the bundled files, however the family is written', () => {
    expect(fontStack('Inter')).toBe('"Inter Variable", "Inter", system-ui, sans-serif');
    // As a model writes it: a CSS list, where "Inter" alone would not be found.
    expect(fontStack('Inter, sans-serif')).toBe('"Inter Variable", "Inter", sans-serif');
    expect(fontStack("'Fraunces', Georgia")).toBe(
      '"Fraunces Variable", "Fraunces", "Georgia", serif',
    );
    expect(fontStack('Comic Neue')).toBe('"Comic Neue", system-ui, sans-serif');
    expect(fontStack('monospace')).toBe('monospace');
  });

  it('has the Lucide icons by their names', () => {
    expect(iconNames().length).toBeGreaterThan(1000);
    expect(iconShapes('shopping-cart')).toContain('<circle');
    expect(iconShapes('nope')).toBeNull();
  });
});

describe('lint', () => {
  it('passes a design made of tokens', () => {
    const { state } = build(HOME);
    expect(lint(state.design, state.tokens)).toEqual([]);
  });

  it('finds raw values, unknown tokens, low contrast and unnamed layers', () => {
    const { state } = build(`
      <Frame w=390 layout=col fill="#ffffff" gap=12>
        <Text name="Faint" style={type.body} color="#bbbbbb">Hard to read</Text>
        <Text style={type.body} color={color.nope}>x</Text>
        <Icon icon="definitely-not-an-icon" />
      </Frame>`);
    const issues = lint(state.design, state.tokens);
    const rules = issues.map((i) => i.rule);
    expect(rules).toEqual(
      expect.arrayContaining(['raw-value', 'missing-token', 'contrast', 'unnamed', 'icon']),
    );
    const text = issuesText(issues, { frames: 1, measured: false });
    expect(text).toMatch(/error \[n\d+\] "Faint" is hard to read: contrast 1\.\d:1 in light/);
    expect(text).toContain("Sizes weren't measured");
  });

  it('checks contrast in every mode, through instances', () => {
    const set = tokens();
    // Dark text that stays dark: fine on the light background, unreadable on the dark one.
    const { state } = build(
      '<Frame name="Card" w=300 layout=col fill={color.bg}><Text name="Title" style={type.body} color={color.neutral.900}>Hello</Text></Frame>',
      set,
    );
    const issue = lint(state.design, state.tokens).find((i) => i.rule === 'contrast');
    expect(issue?.message).toMatch(/1\.0:1 in dark/);
    expect(issue?.message).not.toMatch(/in light/);
  });

  it('reads text in an instance against its component, not the page behind it', () => {
    const { state, nodes } = build(HOME);
    const button = (nodes[0] as FrameNode).children[1]!;
    const made = makeComponent(state.design, button.id, 'Button');
    const next = applyOps(state, made.ops).state;
    // White on the brand colour is fine; it only looks wrong against the page.
    expect(lint(next.design, next.tokens).filter((i) => i.rule === 'contrast')).toEqual([]);
  });

  it('uses measured boxes for overflow and tap targets', () => {
    const { state, nodes } = build(`
      <Frame name="Home / Mobile" w=390 layout=col fill={color.bg}>
        <Frame name="Buy button" layout=row fill={color.brand}><Text style={type.body} color={color.on-brand}>Buy</Text></Frame>
        <Text name="Long" style={type.body} color={color.text} w=500>Too wide</Text>
      </Frame>`);
    const frame = nodes[0] as FrameNode;
    const [button, long] = frame.children;
    const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, sw: w, sh: h });
    const geometry: Geometry = {
      [frame.id]: box(0, 0, 390, 200),
      [button!.id]: box(0, 0, 60, 24),
      [(button as FrameNode).children[0]!.id]: box(0, 0, 60, 24),
      [long!.id]: box(0, 24, 500, 24),
    };
    const issues = lint(state.design, state.tokens, { geometry: { [frame.id]: geometry } });
    expect(issues.find((i) => i.rule === 'tap-target')?.message).toMatch(/60×24/);
    expect(issues.find((i) => i.rule === 'overflow')?.message).toMatch(/110px wider/);
  });
});

describe('reading a design as text', () => {
  it('lists layers as markup attributes, and finds them by id or name', () => {
    const { state, nodes } = build(HOME);
    const text = designText('design/site.design', state.design, state.tokens, 6);
    expect(text).toContain(
      `[${nodes[0]!.id}] Frame "Home / Desktop" w=1440 layout=col gap={space.4} pad={space.4} fill={color.bg}`,
    );
    expect(text).toContain(
      'Text "Headline" style={type.display} color={color.text}: "Find your next board."',
    );
    expect(nodesNamed(state.design, 'home / desktop')).toHaveLength(1);
    expect(nodesNamed(state.design, `[${nodes[0]!.id}]`)[0]).toBe(
      findNode(state.design, nodes[0]!.id),
    );
    expect(locate(state.design, (nodes[0] as FrameNode).children[0]!.id)?.ancestors).toHaveLength(
      1,
    );
  });
});

describe('diff', () => {
  it('lists changes down to the property', () => {
    const { state, nodes } = build(HOME);
    const button = (nodes[0] as FrameNode).children[1]!;
    const after = applyOps(state, [
      { op: 'update', id: button.id, set: { fill: '{color.text}' } },
      {
        op: 'token.set',
        token: makeToken(state.tokens, { name: 'color.brand', value: '#ff0066' }),
      },
      {
        op: 'insert',
        parent: nodes[0]!.id,
        node: { id: 'n90', type: 'rect', name: 'Rule', w: 'fill', h: 1 },
      },
    ]).state;
    const lines = diffDesigns(state, after).map(changeText);
    expect(lines).toEqual([
      'Home / Desktop › Button fill {color.brand} → {color.text}',
      'Home / Desktop › Rule: added (rect)',
      '{color.brand} {color.blue.500} → #ff0066',
    ]);
  });
});

describe('design files', () => {
  it('round-trip through the folder layout with stable, readable JSON', () => {
    const { state } = build(HOME);
    const files = serializeDesign(state.design);
    expect(Object.keys(files)).toEqual(['document.json', 'pages/p1.json']);
    expect(files['pages/p1.json']).toMatch(
      /^\{\n {2}"id": "p1",\n {2}"name": "Page 1",\n {2}"children"/,
    );
    expect(parseDesign(files)).toEqual(state.design);
    expect(() => parseDesign({ 'document.json': '{"version": 99}' })).toThrow(/newer clanks/);
  });

  it('name a design file from what someone types', () => {
    expect(designPath('Site')).toBe('design/site.design');
    expect(designPath('design/Promo Graphics.design')).toBe('design/promo-graphics.design');
  });
});

describe('colour', () => {
  it('parses what CSS allows and measures contrast as WCAG does', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('hsl(0, 100%, 50%)')).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(contrast(parseColor('#000')!, parseColor('#fff')!)).toBeCloseTo(21, 5);
  });
});

describe('the wireframe tokens', () => {
  it('are greys that read on each other', () => {
    const colour = (path: string) =>
      parseColor(WIRE_TOKENS.find((t) => t.path === path)!.value as string)!;
    const text = colour('wire.text');
    const bg = colour('wire.bg');
    expect(contrast(text, bg)).toBeGreaterThan(7);
  });
});
