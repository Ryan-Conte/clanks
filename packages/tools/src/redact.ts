const SECRET_NAME = '[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|AUTH)[A-Za-z0-9_]*';

/**
 * A command as labels show it: values that look like secrets are hidden. The full command still
 * goes in the approval prompt, which only the user sees.
 */
export function redactCommand(command: string): string {
  return (
    command
      // API_KEY=abc, export TOKEN="abc"
      .replace(new RegExp(`\\b(${SECRET_NAME})=("[^"]*"|'[^']*'|\\S+)`, 'gi'), '$1=***')
      // --password abc, --token=abc
      .replace(
        /(--?(?:password|passwd|token|secret|api[-_]?key|auth)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi,
        '$1***',
      )
      // Authorization: Bearer abc
      .replace(/(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, '$1***')
      // https://user:pass@host
      .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@')
  );
}

/** A URL as labels show it: no credentials and no query, which is where tokens tend to be. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0]!;
  }
}
