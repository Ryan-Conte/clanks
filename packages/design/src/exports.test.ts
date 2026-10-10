import { describe, expect, it } from 'vitest';
import { codeName, componentCode } from './code';
import { makeComponent } from './components';
import { parseMarkup } from './markup';
import { type Op, type Studio, applyOps } from './ops';
import { type Painted, paintSvg, svgColor, svgFontFamily } from './paint';
import { emptyDesign } from './schema';
import { emptyTokens, makeToken } from './tokens';
import { Ids, findComponent } from './tree';

function studio(markup: string): Studio {
  const set = emptyTokens();
  for (const [name, value] of [
    ['color.brand', '#0a6cff'],
    ['color.on-brand', '#ffffff'],
    ['space.2', 8],
    ['space.4', 16],
    ['radius.md', 8],
  ] as const) {
    set.tokens.push(makeToken(set, { name, value }));
  }
  const design = emptyDesign('Test');
  const nodes = parseMarkup(markup, { ids: new Ids(design), design });
  const ops: Op[] = nodes.map((node) => ({ op: 'insert', parent: 'p1', node }));
  return applyOps({ design, tokens: set }, ops).state;
}

const BUTTON = `
<Frame name="Button" layout=row gap={space.2} padX={space.4} padY={space.2} fill={color.brand} radius={radius.md}>
  <Icon name="Arrow" icon="arrow-right" color={color.on-brand} />
  <Text name="Label" color={color.on-brand}>Take the quiz</Text>
</Frame>`;

describe('component code', () => {
  it('names a component as code would', () => {
    expect(codeName('Product card')).toBe('ProductCard');
    expect(codeName('button/primary')).toBe('ButtonPrimary');
    expect(codeName('3 up')).toBe('Component3Up');
  });

  it('writes a React component and CSS that keep the tokens', () => {
    let state = studio(BUTTON);
    const frame = state.design.pages[0]!.children[0]!;
    state = applyOps(state, makeComponent(state.design, frame.id, 'Button', 'primary').ops).state;
    const component = findComponent(state.design, 'Button')!;
    const code = componentCode(component, state.design);
    expect(code.name).toBe('Button');
    expect(code.tsx).toContain("import './Button.css';");
    expect(code.tsx).toContain('export interface ButtonProps {\n  text?: string;\n}');
    expect(code.tsx).toContain('export function Button({ text = "Take the quiz" }: ButtonProps) {');
    expect(code.tsx).toContain('<div className="button">');
    expect(code.tsx).toContain('<div className="button__label">{text}</div>');
    expect(code.tsx).toContain('strokeWidth="2"');
    // Layout is flexbox, and every value is still its token.
    expect(code.css).toContain('.button {');
    expect(code.css).toContain('display: flex;');
    expect(code.css).toContain('background: var(--color-brand);');
    expect(code.css).toContain('gap: var(--space-2);');
    expect(code.css).toContain('.button__label {');
    expect(code.css).not.toContain('left:');
  });

  it('branches on the variant when there are several, and switches what a boolean hides', () => {
    let state = studio(`${BUTTON}
<Frame name="Ghost" layout=row padX={space.4} padY={space.2} radius={radius.md}>
  <Text name="Label" color={color.brand}>Learn more</Text>
</Frame>`);
    const [first, second] = state.design.pages[0]!.children;
    state = applyOps(state, makeComponent(state.design, first!.id, 'Button', 'primary').ops).state;
    state = applyOps(state, makeComponent(state.design, second!.id, 'Button', 'ghost').ops).state;
    const component = findComponent(state.design, 'Button')!;
    // The arrow shows only when asked.
    component.props.push({ name: 'showArrow', type: 'boolean', default: false });
    const root = component.variants[0]!.root;
    if (root.type === 'frame') root.children[0]!.showIf = 'showArrow';
    const code = componentCode(component, state.design);
    expect(code.tsx).toContain('variant?: "primary" | "ghost";');
    expect(code.tsx).toContain('showArrow?: boolean;');
    expect(code.tsx).toContain('if (variant === "ghost") {');
    expect(code.tsx).toContain('{showArrow && (');
    expect(code.tsx).toContain('<div className="button button--primary">');
    expect(code.css).toContain('.button.button--ghost {');
    expect(code.css).toContain('.button--primary .button__label {');
  });
});

const box = (extra: Partial<Painted>): Painted => ({
  key: 'n1',
  x: 0,
  y: 0,
  w: 200,
  h: 100,
  background: '',
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
  ...extra,
});

describe('frames as SVG', () => {
  it('reads computed colours', () => {
    expect(svgColor('rgb(10, 108, 255)')).toEqual({ color: '#0a6cff', opacity: 1 });
    expect(svgColor('rgba(0, 0, 0, 0.5)')).toEqual({ color: '#000000', opacity: 0.5 });
    expect(svgColor('rgba(0, 0, 0, 0)')).toBeNull();
    expect(svgColor('oklch(0.7 0.1 200)')).toEqual({ color: 'oklch(0.7 0.1 200)', opacity: 1 });
  });

  it('names fonts as another computer has them', () => {
    expect(svgFontFamily('"Inter Variable", "Inter", system-ui, sans-serif')).toBe(
      "'Inter', 'Inter Variable', system-ui, sans-serif",
    );
    expect(svgFontFamily('Georgia')).toBe("'Georgia'");
  });

  it('draws boxes as shapes and text as text, line by line', () => {
    const border = { w: 2, color: 'rgb(0, 0, 0)' };
    const svg = paintSvg(
      box({
        background: 'rgb(250, 250, 250)',
        radius: [8, 8],
        shadow: 'rgba(0, 0, 0, 0.12) 0px 4px 12px 0px',
        children: [
          box({
            key: 'n2',
            x: 16,
            y: 16,
            w: 168,
            h: 40,
            borders: [border, border, border, border],
            text: {
              lines: [
                { text: 'Find your <next>', x: 16, baseline: 32, w: 120 },
                { text: 'board & more.', x: 16, baseline: 52, w: 90 },
              ],
              color: 'rgba(17, 17, 19, 0.8)',
              family: 'Inter, sans-serif',
              size: 16,
              weight: '700',
              italic: false,
              spacing: 0,
              underline: false,
            },
          }),
        ],
      }),
      { title: 'Home / Desktop' },
    );
    expect(svg).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
    );
    expect(svg).toContain('<title>Home / Desktop</title>');
    expect(svg).toContain(
      '<rect x="0" y="0" width="200" height="100" rx="8" ry="8" fill="#fafafa" filter="url(#s1)"/>',
    );
    expect(svg).toContain(
      '<feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="0.12"/>',
    );
    expect(svg).toContain('<tspan x="16" y="32">Find your &lt;next&gt;</tspan>');
    expect(svg).toContain('<tspan x="16" y="52">board &amp; more.</tspan>');
    expect(svg).toContain('font-weight="700" fill="#111113" fill-opacity="0.8"');
    // A border sits inside its box.
    expect(svg).toContain(
      '<rect x="17" y="17" width="166" height="38" fill="none" stroke="#000000" stroke-width="2"/>',
    );
  });

  it('clips, fades, embeds images and keeps icons as strokes', () => {
    const svg = paintSvg(
      box({
        clip: true,
        opacity: 0.5,
        children: [
          box({
            key: 'n2',
            image: { src: 'data:image/png;base64,AAAA', fit: 'cover' },
            radius: [12, 12],
          }),
          box({
            key: 'n3',
            w: 24,
            h: 24,
            icon: {
              viewBox: '0 0 24 24',
              inner: '<path d="M5 12h14"/>',
              stroke: 'rgb(255, 255, 255)',
              strokeWidth: '2',
              fill: 'none',
            },
          }),
          box({ key: 'n4', placeholder: true }),
        ],
      }),
    );
    expect(svg).toContain('<g opacity="0.5">');
    expect(svg).toContain(
      'preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,AAAA" clip-path="url(#c1)"',
    );
    expect(svg).toContain('stroke="#ffffff" stroke-width="2"');
    expect(svg).toContain('<path d="M5 12h14"/>');
    expect(svg).toContain('fill="#808080" fill-opacity="0.14"');
    expect(svg).toMatch(/<g clip-path="url\(#c\d\)">/);
  });
});
