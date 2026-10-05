import { describe, expect, it } from 'vitest';
import { RefTable, formatSnapshot, shortUrl } from './snapshot';
import { ax, axTree } from './test/fake-cdp';

const page = ax('RootWebArea', 'Wave Shop', {
  children: [
    ax('banner', '', {
      children: [
        ax('link', 'Wave Shop', {
          backend: 10,
          props: { url: 'https://waveshop.test/', focusable: true },
          children: [ax('StaticText', 'Wave Shop')],
        }),
        ax('navigation', '', {
          children: [
            ax('list', '', {
              children: [
                ax('listitem', '', {
                  children: [
                    ax('link', 'Boards', {
                      backend: 11,
                      props: { url: 'https://waveshop.test/boards?sort=new' },
                      children: [ax('StaticText', 'Boards')],
                    }),
                  ],
                }),
                ax('listitem', '', {
                  children: [
                    ax('link', 'Forecast', {
                      backend: 12,
                      props: { url: 'https://surf-forecast.example/au' },
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
    ax('main', '', {
      children: [
        ax('heading', 'Soft tops', {
          props: { level: 1 },
          children: [ax('StaticText', 'Soft tops')],
        }),
        ax('paragraph', '', {
          children: [
            ax('StaticText', 'The easiest way to start'),
            ax('StaticText', ','),
            ax('StaticText', 'read our'),
            ax('link', 'guide', { backend: 13, props: { url: '/guide' } }),
            ax('StaticText', '.'),
          ],
        }),
        ax('generic', '', {
          ignored: true,
          children: [ax('image', 'A blue soft top board'), ax('image', '')],
        }),
        ax('textbox', 'Search boards', { backend: 20, value: 'foam', props: { focused: true } }),
        ax('checkbox', 'In stock only', { backend: 21, props: { checked: 'true' } }),
        ax('combobox', 'Sort by', {
          backend: 22,
          value: 'Price',
          children: [
            ax('MenuListPopup', '', {
              children: [ax('MenuListOption', 'Price'), ax('MenuListOption', 'Newest')],
            }),
          ],
        }),
        ax('button', 'Add to cart', { backend: 23, props: { disabled: true } }),
        ax('table', '', {
          children: [
            ax('row', '', {
              children: [
                ax('columnheader', 'Board', { children: [ax('StaticText', 'Board')] }),
                ax('columnheader', 'Price', { children: [ax('StaticText', 'Price')] }),
              ],
            }),
            ax('row', '', {
              children: [
                ax('cell', '', { children: [ax('StaticText', 'Foamie 7ft')] }),
                ax('cell', '', { children: [ax('StaticText', '$399')] }),
              ],
            }),
          ],
        }),
        ax('heading', 'Hidden label', { props: { level: 2 } }),
        ax('generic', 'Open card', { backend: 30, props: { focusable: true } }),
        ax('Iframe', 'Chat'),
      ],
    }),
  ],
});

describe('formatSnapshot', () => {
  it('reads a page as lines, numbering what can be acted on', () => {
    const refs = new RefTable();
    const lines = formatSnapshot(axTree(page), refs, { url: 'https://waveshop.test/boards' });
    expect(lines).toEqual([
      '[1] link "Wave Shop" (/)',
      '- [2] link "Boards" (/boards?sort=new)',
      '- [3] link "Forecast" (https://surf-forecast.example/au)',
      '# Soft tops',
      'The easiest way to start, read our [4] link "guide" (/guide).',
      '[image: A blue soft top board]',
      '[5] text box "Search boards" value="foam" (focused)',
      '[6] checkbox "In stock only" (checked)',
      '[7] combo box "Sort by" value="Price" options: Price | Newest',
      '[8] button "Add to cart" (disabled)',
      'Board | Price',
      'Foamie 7ft | $399',
      '## Hidden label',
      '[9] clickable "Open card"',
      '[frame "Chat": not read]',
    ]);
    expect(refs.node(5)).toBe(20);
    expect(refs.node(99)).toBeUndefined();
  });

  it('keeps refs stable from one read to the next, until the page changes', () => {
    const refs = new RefTable();
    const nodes = axTree(page);
    formatSnapshot(nodes, refs);
    // A smaller page that still has the button: it keeps its number.
    const lines = formatSnapshot(
      axTree(ax('RootWebArea', '', { children: [ax('button', 'Add to cart', { backend: 23 })] })),
      refs,
    );
    expect(lines).toEqual(['[8] button "Add to cart"']);
    refs.reset();
    expect(formatSnapshot(nodes, refs)[0]).toBe('[1] link "Wave Shop" (https://waveshop.test/)');
  });

  it('says nothing for an empty page', () => {
    expect(formatSnapshot([], new RefTable())).toEqual([]);
    expect(formatSnapshot(axTree(ax('RootWebArea')), new RefTable())).toEqual([]);
  });

  it('shortens long names and quotes quotes', () => {
    const lines = formatSnapshot(
      axTree(
        ax('RootWebArea', '', {
          children: [ax('button', `Say "hi" ${'x'.repeat(200)}`, { backend: 1 })],
        }),
      ),
      new RefTable(),
    );
    expect(lines[0]).toMatch(/^\[1\] button "Say \\"hi\\" x+…"$/);
    expect(lines[0]!.length).toBeLessThan(140);
  });
});

describe('shortUrl', () => {
  it('shows paths on the same site and whole addresses elsewhere', () => {
    expect(shortUrl('https://a.test/x?y=1#z', 'https://a.test/page')).toBe('/x?y=1#z');
    expect(shortUrl('/docs', 'https://a.test/page')).toBe('/docs');
    expect(shortUrl('https://b.test/', 'https://a.test/')).toBe('https://b.test/');
    expect(shortUrl('javascript:void(0)', 'https://a.test/')).toBeNull();
    expect(shortUrl('mailto:hi@a.test', 'https://a.test/')).toBeNull();
  });
});
