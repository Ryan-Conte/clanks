import { type ClankBrowser, defaultClankBrowser } from '@clanks/core';
import { describe, expect, it } from 'vitest';
import { fakeBrowserHost } from './fake-host';
import { BrowserService, pageText } from './service';

const CHAT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const scout = { id: 'scout', name: 'Scout' };

const pages = {
  'https://boards.test/': {
    title: 'Boards',
    text: ['Soft tops are the easiest way to start.'],
    elements: [
      { role: 'link' as const, name: 'Prices', href: '/prices' },
      { role: 'textbox' as const, name: 'Search' },
      { role: 'textbox' as const, name: 'Password', type: 'password' },
    ],
  },
  'https://boards.test/prices': { title: 'Prices', text: ['Foamie 7ft: $399'] },
  'https://elsewhere.test/': { title: 'Elsewhere', text: ['Not for Scout'] },
  'https://html.duckduckgo.com/html/?q=soft%20tops': {
    title: 'soft tops at DuckDuckGo',
    results: [
      { title: 'Soft tops guide', url: 'https://boards.test/', snippet: 'Start here' },
      { title: 'Second', url: 'https://elsewhere.test/', snippet: 'More' },
    ],
  },
  'https://html.duckduckgo.com/html/?q=bot%20check': {
    title: 'Are you human?',
    text: ['Please confirm you are human'],
  },
};

function setup(settings: Partial<ClankBrowser> = {}) {
  const fake = fakeBrowserHost(pages);
  const service = new BrowserService({
    host: fake.host,
    settings: () => ({ ...defaultClankBrowser, ...settings }),
    userName: () => 'Sam',
  });
  const controller = new AbortController();
  const browser = service.access(CHAT, scout, { signal: controller.signal, maxChars: 4000 });
  return { fake, service, browser, controller };
}

describe('the browser service', () => {
  it('opens pages in tabs the user can watch, and reads them with refs', async () => {
    const { fake, service, browser } = setup();
    const page = [
      'Boards\nhttps://boards.test/',
      'Soft tops are the easiest way to start.\n[1] link "Prices" (/prices)\n[2] text box "Search"\n[3] text box "Password"',
    ].join('\n\n');
    // Opening a page reads it too, so its refs work straight away.
    const opened = await browser.open('https://boards.test/');
    expect(opened.content).toBe(`Opened t1, now the current tab.\n\n${page}`);
    expect(opened.image?.mediaType).toBe('image/jpeg');
    expect((await browser.read(1)).content).toBe(page);

    const clicked = await browser.click(1);
    expect(clicked.content).toBe(
      'Clicked [1]. It led to a new page:\n\nPrices\nhttps://boards.test/prices\n\nFoamie 7ft: $399',
    );
    expect(service.state(CHAT)).toMatchObject({
      available: true,
      current: fake.tabs[0]!.id,
      control: 'clank',
      busy: false,
      tabs: [{ handle: 't1', url: 'https://boards.test/prices', title: 'Prices', search: false }],
    });
    expect((await browser.back()).content).toBe(`Went back.\n\n${page}`);
  });

  it('types into fields, but never into a password field', async () => {
    const { browser } = setup();
    await browser.open('https://boards.test/');
    await browser.read(1);
    expect((await browser.type(2, 'soft top', false)).content).toBe(
      'Typed into [2]; it now holds "soft top".',
    );
    const refused = await browser.type(3, 'hunter2', false);
    expect(refused).toMatchObject({ error: true });
    expect(refused.content).toMatch(/password or payment field/);
  });

  it('keeps a clank to its sites, redirects included', async () => {
    const { fake, browser } = setup({ allow: ['boards.test'] });
    const refused = await browser.open('https://elsewhere.test/');
    expect(refused).toMatchObject({ error: true });
    expect(refused.content).toMatch(
      /elsewhere\.test isn't on the list of sites this clank may open/,
    );
    expect(fake.tabs).toHaveLength(0);

    await browser.open('https://boards.test/');
    expect(fake.redirect(fake.tabs[0]!, 'https://elsewhere.test/')).toBe(false);
    // Frames inside a page can still use about: and data: documents.
    expect(fake.tabs[0]!.guard('about:srcdoc', false)).toBe(true);
    expect((await browser.navigate('ftp://boards.test/')).content).toMatch(/Only http and https/);
  });

  it('says plainly when a page will not load', async () => {
    const { browser } = setup();
    const failed = await browser.open('https://nowhere.test/');
    expect(failed).toMatchObject({ error: true });
    expect(failed.content).toBe(
      "Couldn't open https://nowhere.test/: the address couldn't be found.",
    );
    expect((await browser.read(1)).content).toMatch(/^about:blank|\(no title\)/);
  });

  it('waits while the user has the browser, and says they had it', async () => {
    const { service, browser } = setup();
    await browser.open('https://boards.test/');
    service.takeOver(CHAT);
    let done = false;
    const read = browser.read(1).then((r) => {
      done = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    expect(service.state(CHAT)).toMatchObject({ control: 'user', waiting: true });
    service.handBack(CHAT);
    const result = await read;
    expect(result.content).toMatch(/Sam took over the browser and handed it back/);
    expect(service.state(CHAT).waiting).toBe(false);
  });

  it('stops waiting when the reply is stopped', async () => {
    const { service, browser, controller } = setup();
    await browser.open('https://boards.test/');
    service.takeOver(CHAT);
    const read = browser.read(1);
    controller.abort();
    expect(await read).toMatchObject({
      error: true,
      content: 'Stopped while waiting for the browser.',
    });
  });

  it('lets the user drive while they have control, off the site lists', async () => {
    const { service, browser, fake } = setup({ allow: ['boards.test'] });
    await browser.open('https://boards.test/');
    await expect(service.navigate(CHAT, 'elsewhere.test')).rejects.toThrow(/Take over/);
    service.takeOver(CHAT);
    await service.navigate(CHAT, 'elsewhere.test/');
    expect(fake.tabs[0]!.url).toBe('https://elsewhere.test/');
  });

  it('opens pop-ups as tabs, and holds downloads for the user', async () => {
    const { service, browser, fake } = setup();
    await browser.open('https://boards.test/');
    fake.popup(fake.tabs[0]!, 'https://boards.test/prices');
    fake.download(fake.tabs[0]!, {
      url: 'https://boards.test/catalog.pdf',
      filename: 'catalog.pdf',
      size: 2048,
      mimeType: 'application/pdf',
    });
    const next = await browser.read(1);
    expect(next.content).toMatch(
      /opened https:\/\/boards\.test\/prices in a new tab, t2, which is now the current tab/,
    );
    expect(next.content).toMatch(/started downloading catalog\.pdf\. Downloads wait for Sam/);
    const state = service.state(CHAT);
    expect(state.tabs.map((t) => t.handle)).toEqual(['t1', 't2']);
    expect(state.current).toBe(fake.tabs[1]!.id);
    expect(state.downloads).toMatchObject([{ filename: 'catalog.pdf', status: 'waiting' }]);

    await service.decideDownload(CHAT, state.downloads[0]!.id, true);
    expect(service.state(CHAT).downloads[0]).toMatchObject({
      status: 'saved',
      path: '/downloads/catalog.pdf',
    });
    expect((await browser.read(1)).content).toMatch(/Sam saved the download catalog\.pdf/);
    await expect(service.decideDownload(CHAT, state.downloads[0]!.id, false)).rejects.toThrow(
      /isn't waiting/,
    );
  });

  it('closes tabs, falling back to the one before', async () => {
    const { browser, fake } = setup();
    await browser.open('https://boards.test/');
    await browser.open('https://boards.test/prices');
    expect((await browser.close()).content).toBe(
      'Closed t2. The current tab is now t1: "Boards" (https://boards.test/).',
    );
    expect(fake.tabs[1]!.closed).toBe(true);
    expect((await browser.close()).content).toBe('Closed t1. No tabs are open now.');
    expect((await browser.read(1)).content).toMatch(/No tab is open/);
  });

  it('searches in a tab of its own, and falls back to the page when it must', async () => {
    const { browser, service } = setup({ allow: ['boards.test'] });
    expect(await browser.search('soft tops', 1)).toEqual({
      results: [{ title: 'Soft tops guide', url: 'https://boards.test/', snippet: 'Start here' }],
      page: null,
    });
    expect(service.state(CHAT).tabs).toMatchObject([{ handle: 't1', search: true }]);
    expect(await browser.search('bot check', 5)).toEqual({
      results: [],
      page: 'Please confirm you are human',
    });
    // The same tab is used again.
    expect(service.state(CHAT).tabs).toHaveLength(1);
  });

  it('gives each chat a fresh session, or the clank its kept one', async () => {
    const fresh = setup();
    await fresh.browser.open('https://boards.test/');
    expect(fresh.fake.tabs[0]!.session).toEqual({ key: CHAT, persistent: false });
    fresh.service.closeConversation(CHAT);
    expect(fresh.fake.tabs[0]!.closed).toBe(true);
    expect(fresh.fake.cleared).toEqual([{ key: CHAT, persistent: false }]);

    const kept = setup({ persistent: true });
    await kept.browser.open('https://boards.test/');
    const other = kept.service.access(OTHER, scout, {
      signal: new AbortController().signal,
      maxChars: 4000,
    });
    await other.open('https://boards.test/');
    expect(kept.fake.tabs.map((t) => t.session)).toEqual([
      { key: 'scout', persistent: true },
      { key: 'scout', persistent: true },
    ]);
    kept.service.closeConversation(CHAT);
    expect(kept.fake.cleared).toEqual([]);
  });

  it('shows one tab in the pane at a time', async () => {
    const { service, browser, fake } = setup();
    await browser.open('https://boards.test/');
    const tab = fake.tabs[0]!;
    const bounds = { x: 10, y: 20, width: 500, height: 400 };
    service.show(CHAT, tab.id, bounds);
    expect(fake.displayed()).toEqual({ tabId: tab.id, bounds });
    // Another chat hiding its pane doesn't hide this one.
    service.show(OTHER, null, null);
    expect(fake.displayed().tabId).toBe(tab.id);
    service.show(CHAT, tab.id, { ...bounds, width: 0 });
    expect(fake.displayed()).toEqual({ tabId: null, bounds: null });
  });
});

describe('pageText', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `Line ${i + 1} ${'x'.repeat(40)}`);

  it('reads a long page in parts, saying where to go on from', () => {
    const first = pageText('Title\nhttps://a.test/', lines, 1, 4000);
    expect(first).toMatch(/^Title\nhttps:\/\/a\.test\/\n\nLine 1 x+\n/);
    const next = /from_line (\d+)/.exec(first)![1]!;
    expect(first).toContain(`[Lines 1–${Number(next) - 1} of 300.`);
    const last = pageText('T', lines, 290, 4000);
    expect(last).toContain('[Lines 290–300 of 300: the end of the page.]');
  });

  it('reads a short page whole, with no note', () => {
    expect(pageText('T', ['a', 'b'], 1, 4000)).toBe('T\n\na\nb');
    expect(pageText('T', [], 1, 4000)).toMatch(/no text yet/);
  });
});
