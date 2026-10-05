/** A search result as the browser read it off the results page. */
export interface BrowserSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Where `web_search` searches when no backend is set up: DuckDuckGo's plain HTML results, in a
 * tab the user can watch. It needs no account and no key, and has no scripts to wait for.
 */
export const SEARCH_HOST = 'html.duckduckgo.com';

export function searchUrl(query: string): string {
  return `https://${SEARCH_HOST}/html/?q=${encodeURIComponent(query)}`;
}

/**
 * Picks the results off the page. Ads are left out, and links are unwrapped from DuckDuckGo's
 * redirect to the address they lead to.
 */
export const SEARCH_RESULTS = `(() => {
  const results = [];
  for (const el of document.querySelectorAll('.result')) {
    if (el.classList.contains('result--ad')) continue;
    const link = el.querySelector('a.result__a');
    if (!link) continue;
    let url = link.href;
    try {
      const real = new URL(url).searchParams.get('uddg');
      if (real) url = real;
    } catch {}
    if (!/^https?:/.test(url)) continue;
    const snippet = el.querySelector('.result__snippet');
    results.push({
      title: (link.textContent || '').trim(),
      url,
      snippet: snippet ? (snippet.textContent || '').trim() : '',
    });
  }
  return results;
})()`;
