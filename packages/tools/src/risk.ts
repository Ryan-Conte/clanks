import { looksSecret } from '@clanks/core';

/**
 * How risky a tool call is. A low-risk call does the everyday work of a ticket inside the clank's
 * own worktree: reading, building, testing, installing the project's packages. A high-risk call
 * can reach past it: delete or write elsewhere, push, publish, deploy, send data out, run as an
 * administrator, or change the computer. With approvals set to risky calls only, a tool the
 * clank's policy says to ask about asks only when its call is high risk.
 */
export interface Risk {
  level: 'low' | 'high';
  /** Why it's high risk, worded for the approval card. */
  reason: string | null;
}

/** What a risk check knows besides the call's arguments. */
export interface RiskContext {
  /** The run's worktree, where the clank may do as it likes. */
  worktree: string | null;
  /** The page the clank's browser is on, for clicks and typing. */
  browserUrl: string | null;
}

export const LOW_RISK: Risk = { level: 'low', reason: null };

const high = (reason: string): Risk => ({ level: 'high', reason });

/** Hosts on this computer or the local network: a dev server, not the world. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * An address a clank reads. Reading the web is everyday work; what makes it risky is carrying
 * data out in the address, which injected instructions might ask for.
 */
export function urlRisk(url: string): Risk {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return LOW_RISK;
  }
  if (isLocalHost(parsed.hostname)) return LOW_RISK;
  const carried = `${parsed.search}${parsed.hash}${parsed.username}${parsed.password}`;
  if (parsed.username || parsed.password) return high('The address has a login in it');
  if (carried.length > 200 || looksSecret(decodeSafe(carried))) {
    return high('The address carries a lot of data to another site');
  }
  return LOW_RISK;
}

/** A click, a key or typing on the current page: everyday on a dev server, not on other sites. */
export function pageActionRisk(context: RiskContext, what: string): Risk {
  if (!context.browserUrl) return LOW_RISK;
  try {
    const { protocol, hostname } = new URL(context.browserUrl);
    if (protocol === 'about:' || protocol === 'file:' || isLocalHost(hostname)) return LOW_RISK;
    return high(`${what} on ${hostname}, which could send a form or change something there`);
  } catch {
    return LOW_RISK;
  }
}

/** Downloads piped straight into something that runs them. */
const PIPED_SCRIPT =
  /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|fish|python\d*|node|perl|ruby|php|pwsh|powershell|iex|invoke-expression)\b/i;
const SUBSTITUTED_SCRIPT =
  /\b(sh|bash|zsh|python\d*|node|eval|iex|invoke-expression)\b[^;&|]*[$`(]\(?\s*(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i;
const DECODED_SCRIPT = /\bbase64\s+(-d|--decode|-D)\b[^|;&]*\|\s*(sh|bash|zsh|python\d*|node)\b/i;
/** Redirected output to a path outside the worktree. `/dev/null` and the temp folder are fine. */
const REDIRECT_OUT =
  /(^|[^<>&\d])(>>?|\|\s*tee(\s+-a)?)\s*["']?(?!\/dev\/null\b|\/tmp\/|\$TMPDIR|\$TEMP)(\/|~|\$HOME|%USERPROFILE%|[A-Za-z]:[\\/]|\.\.[\\/])/;

/** Programs that, whatever their arguments, reach past the worktree. */
const ALWAYS: [RegExp, string][] = [
  [/^(sudo|su|doas|runas|pkexec|gsudo)$/, 'Runs as an administrator'],
  [/^(ssh|scp|sftp|ftp|telnet|nc|ncat|netcat|socat|mosh)$/, 'Connects to another machine'],
  [
    /^(shutdown|reboot|halt|poweroff|systemctl|service|launchctl|schtasks|crontab|reg|regedit|setx|mkfs(\..+)?|fdisk|diskpart|format|dd|mount|umount|bcdedit|sc)$/,
    'Changes how this computer runs',
  ],
  [
    /^(apt|apt-get|aptitude|yum|dnf|pacman|zypper|apk|brew|port|choco|winget|scoop|snap|flatpak|nix-env)$/,
    'Installs or removes software on this computer',
  ],
  [/^(killall|pkill|taskkill|kill-port)$/, 'Stops programs by name, which may be yours'],
  [
    /^(kubectl|helm|terraform|tofu|pulumi|aws|gcloud|gsutil|az|doctl|vercel|netlify|firebase|fly|flyctl|heroku|wrangler|serverless|sls|eb|railway|render|surge|ansible|ansible-playbook)$/,
    'Deploys, or changes cloud resources',
  ],
  [/^(gh|hub|glab)$/, 'Acts on GitHub or GitLab as you'],
  [/^(docker|podman|nerdctl)$/, 'Runs containers, which can reach past the worktree'],
];

/** Programs that write or delete files, for which a path outside the worktree is risky. */
const WRITERS =
  /^(rm|rmdir|del|erase|rd|remove-item|shred|unlink|mv|move|move-item|cp|copy|copy-item|xcopy|robocopy|ln|mkdir|md|touch|chmod|chown|chgrp|icacls|attrib|truncate|tee|set-content|out-file|new-item|rename-item|ren|install)$/;
const DELETERS = /^(rm|rmdir|del|erase|rd|remove-item|shred|unlink)$/;

/** Files that tend to hold secrets. Example and template files don't. */
const SECRET_FILE =
  /(^|[\\/])(\.env(\.(?!example\b|sample\b|template\b|dist\b|defaults?\b)[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(\.json)?|[\w.-]+\.(pem|key|p12|pfx|keystore|jks))$/i;

/**
 * How risky a shell command is. It's read the way a shell would split it: each command in a chain
 * or pipeline, and those in `$(…)`, is checked, and any risky one makes the whole command risky.
 * This catches the usual ways of reaching past the worktree, not every conceivable one, which is
 * why the clank's command also runs in a scrubbed environment and, optionally, in Docker.
 */
export function commandRisk(
  command: string,
  context: Pick<RiskContext, 'worktree'> = { worktree: null },
): Risk {
  const text = command.trim();
  if (PIPED_SCRIPT.test(text) || SUBSTITUTED_SCRIPT.test(text) || DECODED_SCRIPT.test(text)) {
    return high('Runs a script it downloads or decodes, without you seeing it');
  }
  if (REDIRECT_OUT.test(text) && !insideOnly(text, context.worktree)) {
    return high('Writes to a file outside its worktree');
  }
  for (const inner of substitutions(text)) {
    const risk = commandRisk(inner, context);
    if (risk.level === 'high') return risk;
  }
  for (const segment of segments(text)) {
    const risk = segmentRisk(segment, context.worktree);
    if (risk.level === 'high') return risk;
  }
  return LOW_RISK;
}

function segmentRisk(segment: string, worktree: string | null): Risk {
  const words = shellWords(segment);
  // Leading variable assignments and wrappers don't change what runs.
  while (
    words.length > 0 &&
    (/^\w+=/.test(words[0]!) ||
      /^(env|time|nice|nohup|command|exec|builtin|xargs)$/.test(words[0]!))
  ) {
    words.shift();
  }
  if (words.length === 0) return LOW_RISK;
  const program = programName(words[0]!);
  const args = words.slice(1);
  const lower = args.map((a) => a.toLowerCase());

  for (const [pattern, reason] of ALWAYS) {
    if (pattern.test(program)) {
      if (program === 'docker' && /^(ps|images|version|info|logs)$/.test(lower[0] ?? '')) continue;
      return high(reason);
    }
  }
  if (
    /^(powershell|pwsh)$/.test(program) &&
    lower.some((a) => /^-(e|enc|encodedcommand)$/.test(a))
  ) {
    return high('Runs hidden code');
  }
  if (program === 'cd' || program === 'pushd' || program === 'set-location') {
    const target = args[0] ?? '~';
    if (outside(target, worktree)) return high('Works in a folder outside its worktree');
  }
  if (program === 'git') return gitRisk(lower);
  if (/^(npm|pnpm|yarn|bun|npx|pnpx)$/.test(program)) return packageRisk(program, lower);
  if (/^(pip\d*|pipx|uv|poetry|conda|mamba)$/.test(program)) {
    if (
      program === 'pipx' ||
      lower.includes('--user') ||
      lower.includes('--break-system-packages')
    ) {
      return high('Installs Python packages for your whole account');
    }
    if (
      /^(conda|mamba)$/.test(program) &&
      lower[0] === 'install' &&
      !lower.some((a) => a === '-p' || a === '--prefix')
    ) {
      return high('Installs into a shared conda environment');
    }
    if (lower.includes('publish') || lower.includes('upload')) return high('Publishes a package');
  }
  if (/^(cargo|go|gem|dotnet)$/.test(program)) {
    const sub = lower[0] ?? '';
    if (sub === 'publish' || sub === 'push' || (program === 'dotnet' && sub === 'nuget')) {
      return high('Publishes a package');
    }
    if (sub === 'install' && (program !== 'gem' || !lower.includes('--install-dir'))) {
      return high('Installs a program for your whole account');
    }
    if (program === 'dotnet' && sub === 'tool' && lower.includes('-g')) {
      return high('Installs a program for your whole account');
    }
  }
  if (/^(twine)$/.test(program)) return high('Publishes a package');
  if (/^(curl|wget|http|https|invoke-webrequest|iwr|invoke-restmethod|irm)$/.test(program)) {
    const remote = args.some((a) => /^https?:\/\//i.test(a) && !isLocalUrl(a));
    const sends = lower.some(
      (a) =>
        /^(-d|--data.*|-f|--form.*|-t|--upload-file|--json|-method|-body|-infile)$/.test(a) ||
        /^-x(post|put|patch|delete)$/.test(a),
    );
    const method = lower.findIndex((a) => a === '-x' || a === '--request');
    const writes = method !== -1 && /^(post|put|patch|delete)$/.test(lower[method + 1] ?? '');
    if (remote && (sends || writes)) return high('Sends data to a server');
  }
  if (
    /^rsync$/.test(program) &&
    args.some((a) => /^[\w.-]+@?[\w.-]*:/.test(a) && !/^[A-Za-z]:[\\/]/.test(a))
  ) {
    return high('Copies files to another machine');
  }
  if (WRITERS.test(program)) {
    const paths = args.filter((a) => !a.startsWith('-') || a === '-');
    if (DELETERS.test(program) && paths.some((p) => /^(\.|\.\/|\*|\.\/\*|\/\*|\.\\)$/.test(p))) {
      return high('Deletes everything in its worktree');
    }
    if (paths.some((p) => outside(p, worktree))) {
      return high(
        DELETERS.test(program)
          ? 'Deletes files outside its worktree'
          : 'Changes files outside its worktree',
      );
    }
  }
  if (args.some((a) => SECRET_FILE.test(a.replace(/["']/g, '')))) {
    return high('Touches a file that may hold secrets');
  }
  return LOW_RISK;
}

function gitRisk(args: string[]): Risk {
  const sub = args.find((a) => !a.startsWith('-')) ?? '';
  const rest = args.slice(args.indexOf(sub) + 1);
  switch (sub) {
    case 'push':
      return high('Pushes to a remote');
    case 'remote':
      return /^(add|set-url|remove|rm|rename)$/.test(rest[0] ?? '')
        ? high('Changes where the repository pushes and pulls')
        : LOW_RISK;
    case 'config':
      return args.some((a) => a === '--global' || a === '--system')
        ? high('Changes your git settings for every repository')
        : LOW_RISK;
    case 'switch':
      return high('Switches branches; its work belongs on its own branch');
    case 'checkout':
      // `git checkout -- file` puts a file back; anything else switches branches.
      return rest.includes('--') || rest.some((a) => a === '.' || a.includes('.'))
        ? LOW_RISK
        : high('Switches branches; its work belongs on its own branch');
    case 'branch':
      return rest.some((a) => /^-(d|D|-delete|m|M|-move)$/.test(a))
        ? high('Deletes or renames a branch')
        : LOW_RISK;
    case 'worktree':
    case 'filter-branch':
    case 'filter-repo':
    case 'update-ref':
    case 'symbolic-ref':
      return high('Changes the repository itself, beyond its own branch');
    case 'credential':
      return high('Reads your git credentials');
    default:
      return LOW_RISK;
  }
}

function packageRisk(program: string, args: string[]): Risk {
  if (args.some((a) => a === '-g' || a === '--global' || a === '--location=global')) {
    return high('Installs packages for your whole account');
  }
  const sub = args.find((a) => !a.startsWith('-')) ?? '';
  if (
    /^(publish|unpublish|deprecate|owner|dist-tag|access|team|org|adduser|login|logout|token|star|hook)$/.test(
      sub,
    )
  ) {
    return high(
      sub === 'login' || sub === 'adduser' || sub === 'token'
        ? 'Signs in to a registry'
        : 'Publishes or changes a package on its registry',
    );
  }
  if (sub === 'config' && /^(set|delete|edit)$/.test(args[args.indexOf(sub) + 1] ?? '')) {
    return high('Changes your package manager settings');
  }
  if (sub === 'link' && program !== 'npx') return high('Links a package for your whole account');
  return LOW_RISK;
}

/** Whether a path is outside the worktree: absolute elsewhere, in the home folder, or above it. */
function outside(path: string, worktree: string | null): boolean {
  const p = path.replace(/^["']|["']$/g, '');
  if (!p) return false;
  if (/^(\/dev\/null|\/tmp\/|\$TMPDIR|\$TEMP|%TEMP%|nul)$/i.test(p) || p.startsWith('/tmp/'))
    return false;
  if (/^(~|\$HOME|%USERPROFILE%|\$env:USERPROFILE)/i.test(p)) return true;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return true;
  if (/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p)) {
    if (!worktree) return true;
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const root = norm(worktree);
    // Git Bash writes C:\x as /c/x.
    const bash = root.replace(/^([a-z]):/, (_m, d: string) => `/${d}`);
    const target = norm(p);
    return !(
      target === root ||
      target.startsWith(`${root}/`) ||
      target === bash ||
      target.startsWith(`${bash}/`)
    );
  }
  return false;
}

/** Whether every path a command writes to outside of plain words is inside the worktree. */
function insideOnly(text: string, worktree: string | null): boolean {
  if (!worktree) return false;
  const targets = [...text.matchAll(/(?:>>?|\|\s*tee(?:\s+-a)?)\s*["']?([^\s"';&|]+)/g)].map(
    (m) => m[1]!,
  );
  return targets.every((t) => !outside(t, worktree));
}

function isLocalUrl(url: string): boolean {
  try {
    return isLocalHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A program's name, lowercase, without its folder or `.exe`. */
function programName(word: string): string {
  return word
    .replace(/^["']|["']$/g, '')
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** The commands in a chain or pipeline: split on `&&`, `||`, `;`, `|`, `&` and new lines. */
function segments(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** What's inside `$(…)` and backticks, which runs too. */
function substitutions(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) found.push(m[1]!);
  for (const m of text.matchAll(/`([^`]+)`/g)) found.push(m[1]!);
  return found;
}

/** A command's words, with quotes taken off, roughly as a shell would split them. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || has) words.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
  }
  if (current || has) words.push(current);
  return words;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
