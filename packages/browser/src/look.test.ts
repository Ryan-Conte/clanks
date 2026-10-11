import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BROKEN_IMAGES, PAGE_LOOK, type PageLook, brokenImagesText, lookText } from './look';

const look: PageLook = {
  url: 'https://scruka.test/',
  title: 'Planning poker and boards | Scruka',
  name: 'Scruka',
  description: 'Planning poker and agile boards for product teams.',
  dark: true,
  background: '#0a0a0b',
  text: '#a9adb5',
  backgrounds: [
    { hex: '#17181b', share: 0.49 },
    { hex: '#0a0a0b', share: 0.28 },
  ],
  texts: [
    { hex: '#a9adb5', share: 0.62 },
    { hex: '#f5f5f5', share: 0.37 },
  ],
  accents: [{ hex: '#01cc8e', share: 12, uses: ['logo', 'links', 'borders'] }],
  borders: [{ hex: '#1d1d1e', share: 0.86 }],
  gradients: ['linear-gradient(rgb(29, 31, 35) 0%, rgb(23, 24, 27) 100%)'],
  fonts: [
    { family: 'Manrope', web: true, roles: ['body', 'buttons'] },
    { family: 'Space Grotesk', web: true, roles: ['headings'] },
    { family: 'Arial', web: false, roles: ['code'] },
  ],
  type: [
    {
      tag: 'h1',
      family: 'Space Grotesk',
      size: 60,
      weight: 700,
      lineHeight: 1,
      colour: '#f5f5f5',
      sample: 'Connect planning poker and boards.',
    },
    {
      tag: 'body',
      family: 'Manrope',
      size: 16,
      weight: 400,
      lineHeight: 1.75,
      colour: '#a9adb5',
      sample: '',
    },
  ],
  buttons: [
    {
      text: 'Explore features',
      background: '#17181b',
      colour: '#f5f5f5',
      border: '1px #1d1d1e',
      radius: '10px',
      padding: '12.8px 17.6px',
      font: 'Manrope 600 16px',
    },
    {
      text: 'Sign in',
      background: null,
      colour: '#f5f5f5',
      border: null,
      radius: '10px',
      padding: '8px 12px',
      font: 'Manrope 600 14px',
    },
  ],
  cards: { radius: '16px', border: '1px #1d1d1e', shadow: null },
  images: [
    {
      kind: 'logo',
      note: 'in the header, "Scruka logo"',
      url: 'data:image/svg+xml,%3csvg%3e',
      svg: null,
      width: 71,
      height: 62,
    },
    {
      kind: 'icon',
      note: 'the site icon',
      url: 'https://scruka.test/logo.png',
      svg: null,
      width: 0,
      height: 0,
    },
    {
      kind: 'logo',
      note: 'on the page, drawn in the page',
      url: null,
      svg: '<svg/>',
      width: 24,
      height: 24,
    },
  ],
};

describe("a page's look", () => {
  it('reads as a designer would note it down, with its pictures numbered', () => {
    expect(lookText(look)).toBe(
      [
        'How Scruka, https://scruka.test/ looks, as the browser drew it.',
        'Planning poker and agile boards for product teams.',
        '',
        'Theme: dark. Page background #0a0a0b, main text #a9adb5.',
        '',
        'Fonts',
        '- Manrope (a web font the page loads): body, buttons. body 16px/400, line height 1.75',
        '- Space Grotesk (a web font the page loads): headings. h1 60px/700, line height 1',
        '- Arial: code',
        '',
        'Colours, most used first',
        '- Backgrounds: #17181b, #0a0a0b',
        '- Text: #a9adb5, #f5f5f5',
        '- Accents: #01cc8e (logo, links)',
        '- Borders: #1d1d1e',
        '- Gradient: linear-gradient(rgb(29, 31, 35) 0%, rgb(23, 24, 27) 100%)',
        '',
        'Buttons',
        '- "Explore features": background #17181b, text #f5f5f5, border 1px #1d1d1e, radius 10px, padding 12.8px 17.6px, Manrope 600 16px',
        '- "Sign in": no background, text #f5f5f5, radius 10px, padding 8px 12px, Manrope 600 14px',
        '',
        'Cards and panels: radius 16px, border 1px #1d1d1e, no shadow.',
        '',
        'Logo and pictures. Save one into the project with browser_save_image.',
        '[1] logo in the header, "Scruka logo", 71×62: embedded in the page',
        '[2] icon the site icon: https://scruka.test/logo.png',
        '[3] logo on the page, drawn in the page, 24×24: an SVG',
      ].join('\n'),
    );
  });

  it('says so when a page has nothing to go on', () => {
    const bare = lookText({
      ...look,
      name: '',
      description: '',
      fonts: [],
      type: [],
      accents: [],
      borders: [],
      gradients: [],
      buttons: [],
      cards: null,
      images: [],
    });
    expect(bare).toContain('How Planning poker and boards | Scruka, https://scruka.test/ looks');
    expect(bare).not.toContain('Fonts');
    expect(bare).toMatch(/No logo or pictures were found on the page\.$/);
  });

  it('is a script a page can run', () => {
    // Its syntax is checked here; what it finds is checked against real pages in the app.
    expect(() => new Script(PAGE_LOOK)).not.toThrow();
    expect(() => new Script(BROKEN_IMAGES)).not.toThrow();
  });

  it("says which pictures didn't load", () => {
    expect(brokenImagesText([])).toBeNull();
    expect(brokenImagesText({ top: 0 })).toBeNull();
    expect(brokenImagesText([{ alt: 'Fish 6', src: '/fish.jpg' }])).toBe(
      'A picture on this page didn\'t load: "Fish 6" (/fish.jpg).',
    );
    expect(
      brokenImagesText([
        { alt: 'Fish 6', src: '/fish.jpg' },
        { alt: '', src: 'https://cdn.test/x.png' },
      ]),
    ).toBe('2 pictures on this page didn\'t load: "Fish 6" (/fish.jpg), https://cdn.test/x.png.');
  });
});
