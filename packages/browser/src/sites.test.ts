import { describe, expect, it } from 'vitest';
import { parseKeys } from './keys';
import { matchesSite, parseSiteList, siteRefusal } from './sites';

describe('matchesSite', () => {
  it('matches a domain and its subdomains', () => {
    expect(matchesSite('example.com', 'https://example.com/a')).toBe(true);
    expect(matchesSite('example.com', 'https://shop.example.com/')).toBe(true);
    expect(matchesSite('example.com', 'https://notexample.com/')).toBe(false);
    expect(matchesSite('Example.COM', 'http://EXAMPLE.com')).toBe(true);
  });

  it('matches only subdomains with *.', () => {
    expect(matchesSite('*.example.com', 'https://a.example.com/')).toBe(true);
    expect(matchesSite('*.example.com', 'https://example.com/')).toBe(false);
  });

  it('matches ports and paths when given', () => {
    expect(matchesSite('localhost:3000', 'http://localhost:3000/x')).toBe(true);
    expect(matchesSite('localhost:3000', 'http://localhost:5173/')).toBe(false);
    expect(matchesSite('localhost', 'http://localhost:5173/')).toBe(true);
    expect(matchesSite('example.com:443', 'https://example.com/')).toBe(true);
    expect(matchesSite('https://example.com/docs', 'https://example.com/docs/intro')).toBe(true);
    expect(matchesSite('https://example.com/docs', 'https://example.com/blog')).toBe(false);
    expect(matchesSite('https://example.com', 'http://example.com/')).toBe(false);
    expect(matchesSite('example.com/docs/*', 'https://example.com/docs/a')).toBe(true);
    expect(matchesSite('https://*.example.com', 'https://a.example.com/')).toBe(true);
  });

  it('matches everything with *, and nothing with junk', () => {
    expect(matchesSite('*', 'https://anything.test/')).toBe(true);
    expect(matchesSite('', 'https://anything.test/')).toBe(false);
    expect(matchesSite('example.com', 'not a url')).toBe(false);
  });
});

describe('siteRefusal', () => {
  it('allows everything not denied when there is no allow list', () => {
    expect(siteRefusal({ allow: [], deny: [] }, 'https://a.test/')).toBeNull();
    expect(siteRefusal({ allow: [], deny: ['a.test'] }, 'https://www.a.test/')).toMatch(
      /may not open/,
    );
  });

  it('allows only the allow list when there is one, and deny wins', () => {
    const lists = { allow: ['docs.test', 'localhost'], deny: ['secret.docs.test'] };
    expect(siteRefusal(lists, 'https://docs.test/x')).toBeNull();
    expect(siteRefusal(lists, 'http://localhost:5173/')).toBeNull();
    expect(siteRefusal(lists, 'https://other.test/')).toMatch(/isn't on the list/);
    expect(siteRefusal(lists, 'https://secret.docs.test/')).toMatch(/may not open/);
  });

  it('only opens http and https pages', () => {
    const lists = { allow: [], deny: [] };
    expect(siteRefusal(lists, 'file:///etc/passwd')).toMatch(/Only http and https/);
    expect(siteRefusal(lists, 'chrome://settings')).toMatch(/Only http and https/);
    expect(siteRefusal(lists, 'about:blank')).toBeNull();
    expect(siteRefusal(lists, 'nonsense')).toMatch(/isn't a web address/);
  });
});

describe('parseSiteList', () => {
  it('splits lines and commas, dropping blanks and repeats', () => {
    expect(parseSiteList('a.test\n\n b.test , a.test\n')).toEqual(['a.test', 'b.test']);
  });
});

describe('parseKeys', () => {
  it('reads named keys, letters and shortcuts', () => {
    const [enter] = parseKeys('Enter');
    expect(enter).toMatchObject({ key: { key: 'Enter', keyCode: 13 }, mask: 0, printable: false });
    const [selectAll] = parseKeys('ctrl+a');
    expect(selectAll).toMatchObject({ mask: 2, printable: false, key: { code: 'KeyA' } });
    expect(parseKeys('Shift+Tab')[0]).toMatchObject({ mask: 8, key: { key: 'Tab' } });
    expect(parseKeys('x')[0]).toMatchObject({ printable: true, key: { text: 'x' } });
    expect(parseKeys('Tab Tab Return').map((p) => p.key.key)).toEqual(['Tab', 'Tab', 'Enter']);
    expect(parseKeys('pagedown')[0]!.key.key).toBe('PageDown');
    expect(parseKeys('+')[0]!.key.key).toBe('+');
    // A modifier on its own goes with the key after it.
    expect(parseKeys('Control r')).toMatchObject([
      { mask: 2, key: { code: 'KeyR' }, reload: true },
    ]);
    expect(parseKeys('ctrl shift k')).toMatchObject([{ mask: 10, key: { code: 'KeyK' } }]);
    expect(parseKeys('F5')[0]!.reload).toBe(true);
    expect(parseKeys('r')[0]!.reload).toBe(false);
  });

  it('says what it can press', () => {
    expect(() => parseKeys('')).toThrow(/which key/);
    expect(() => parseKeys('Hyper+A')).toThrow(/isn't a modifier/);
    expect(() => parseKeys('Smash')).toThrow(/isn't a key/);
  });
});
