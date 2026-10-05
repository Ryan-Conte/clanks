/**
 * Which sites a clank may open. With an empty allow list it may open any site its deny list
 * doesn't name; otherwise only the sites its allow list names. Deny wins.
 */
export interface SiteLists {
  allow: string[];
  deny: string[];
}

/**
 * A site pattern as the user writes it, one per line:
 * - `example.com` matches example.com and every subdomain, such as shop.example.com;
 * - `*.example.com` matches only the subdomains;
 * - `localhost:3000` matches that host on that port only;
 * - a full address such as `https://example.com/docs` matches that host, under that path.
 */
export function matchesSite(pattern: string, url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const entry = pattern.trim().toLowerCase();
  if (!entry) return false;
  if (entry === '*') return true;
  let host = entry;
  let port: string | null = null;
  let path = '';
  let protocol: string | null = null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(entry);
  if (scheme) {
    try {
      const parsed = new URL(entry.replace(/^([a-z]+:\/\/)\*\./, '$1wildcard-subdomain.'));
      protocol = parsed.protocol;
      host = parsed.hostname.replace(/^wildcard-subdomain\./, '*.');
      port = parsed.port || null;
      path = parsed.pathname === '/' ? '' : parsed.pathname;
    } catch {
      return false;
    }
  } else {
    const slash = entry.indexOf('/');
    if (slash !== -1) {
      path = entry.slice(slash);
      host = entry.slice(0, slash);
    }
    const colon = /^(.*):(\d+)$/.exec(host);
    if (colon) {
      host = colon[1]!;
      port = colon[2]!;
    }
  }
  if (protocol && target.protocol !== protocol) return false;
  const targetHost = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
  if (port && port !== targetPort) return false;
  if (host.startsWith('*.')) {
    const base = host.slice(2);
    if (!targetHost.endsWith(`.${base}`)) return false;
  } else if (targetHost !== host && !targetHost.endsWith(`.${host}`)) {
    return false;
  }
  if (path) {
    const want = path.replace(/\*$/, '');
    if (!target.pathname.toLowerCase().startsWith(want)) return false;
  }
  return true;
}

/** Why a clank may not open `url`, or null if it may. Only http and https pages ever open. */
export function siteRefusal(lists: SiteLists, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url} isn't a web address.`;
  }
  if (parsed.protocol === 'about:' && parsed.href === 'about:blank') return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Only http and https pages open in the browser, not ${parsed.protocol} ones.`;
  }
  if (lists.deny.some((pattern) => matchesSite(pattern, url))) {
    return `${parsed.host} is on the list of sites this clank may not open.`;
  }
  const allow = lists.allow.filter((p) => p.trim());
  if (allow.length > 0 && !allow.some((pattern) => matchesSite(pattern, url))) {
    return `${parsed.host} isn't on the list of sites this clank may open.`;
  }
  return null;
}

/** A site list as typed: one pattern per line or comma, blanks and duplicates dropped. */
export function parseSiteList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}
