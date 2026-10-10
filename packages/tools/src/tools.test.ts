import type { ClankFrontmatter } from '@clanks/core';
import { git } from '@clanks/workspace';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { BUILTIN_TOOLS, builtinTool } from './index';
import { McpManager, mcpSlug, mcpToolName, mcpToolSpec } from './mcp';
import { docLevel, policyFor } from './policy';
import { redactCommand, redactUrl } from './redact';
import type { BrowserAccess, CommandResult, ToolContext, ToolSpec } from './spec';
import { htmlToText, searchWith } from './web';
import { tree } from './files';

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clanks-tools-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

const env = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function workspace(files: Record<string, string>) {
  const root = tempDir();
  await git(['init', '--quiet', '-b', 'main'], { cwd: root });
  await git(['config', 'core.autocrlf', 'false'], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '--quiet', '-m', 'Start'], { cwd: root, env });
  const base = await git(['rev-parse', 'HEAD'], { cwd: root });
  return { root, base };
}

function context(root: string, base: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace: { root, cwd: root, branch: 'clanks/test', baseCommit: base },
    shell: null,
    web: { fetch, search: null },
    browser: null,
    board: null,
    context: null,
    signal: new AbortController().signal,
    clank: { id: 'forge', name: 'Forge' },
    maxChars: 20_000,
    ...extra,
  };
}

async function call(name: string, args: unknown, ctx: ToolContext) {
  const tool = builtinTool(name)!;
  return tool.run(tool.parse(args), ctx);
}

describe('the file tools', () => {
  it('read files in parts', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const { root, base } = await workspace({ 'src/a.txt': `${lines}\n` });
    const ctx = context(root, base);
    expect((await call('fs_read', { path: 'src/a.txt' }, ctx)).content).toBe(
      `src/a.txt (50 lines)\n\n${lines}`,
    );
    const part = await call('fs_read', { path: 'src/a.txt', offset: 10, limit: 2 }, ctx);
    expect(part.content).toBe(
      'src/a.txt (lines 10–11 of 50. Read on with offset 12)\n\nline 10\nline 11',
    );
    const small = await call('fs_read', { path: 'src/a.txt' }, { ...ctx, maxChars: 30 });
    expect(small.content).toMatch(/^src\/a.txt \(lines 1–4 of 50. Read on with offset 5\)/);
    await expect(call('fs_read', { path: 'nope.txt' }, ctx)).rejects.toThrow(/no file at nope.txt/);
    await expect(call('fs_read', { path: '../x' }, ctx)).rejects.toThrow(/outside the workspace/);
  });

  it('list a tree without what git ignores', async () => {
    const { root, base } = await workspace({
      '.gitignore': 'node_modules/\n',
      'README.md': '#',
      'src/app.ts': '',
      'src/lib/deep.ts': '',
    });
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'x', 'index.js'), '');
    writeFileSync(join(root, 'new.ts'), '');
    const listed = await call('fs_list', {}, context(root, base));
    expect(listed.content).toBe(
      'The workspace:\n\nsrc/\n  lib/\n    … 1 file further down\n  app.ts\n.gitignore\nnew.ts\nREADME.md',
    );
    expect(tree(['a/b/c.ts', 'a/d.ts', 'e.ts'], 1)).toBe('a/\n  … 2 files further down\ne.ts');
  });

  it('search contents', async () => {
    const { root, base } = await workspace({
      'src/a.ts': 'const x = 1;\nconst yes = 2;\n',
      'b.md': 'yes\n',
    });
    const ctx = context(root, base);
    expect((await call('fs_search', { pattern: 'yes' }, ctx)).content).toBe(
      'b.md:1:yes\nsrc/a.ts:2:const yes = 2;',
    );
    expect((await call('fs_search', { pattern: 'yes', glob: '*.ts' }, ctx)).content).toBe(
      'src/a.ts:2:const yes = 2;',
    );
    expect((await call('fs_search', { pattern: '\\d;$' }, ctx)).content).toContain('src/a.ts:1:');
    expect((await call('fs_search', { pattern: 'zebra' }, ctx)).content).toBe(
      'No matches for zebra.',
    );
  });

  it('write and edit files', async () => {
    const { root, base } = await workspace({ 'a.ts': 'one\r\ntwo\r\nthree\r\n' });
    const ctx = context(root, base);
    expect((await call('fs_write', { path: 'new/b.ts', content: 'hi\n' }, ctx)).content).toBe(
      'Created new/b.ts (2 lines).',
    );
    expect(readFileSync(join(root, 'new', 'b.ts'), 'utf8')).toBe('hi\n');

    // The model writes \n; the file keeps its \r\n.
    const edited = await call(
      'fs_edit',
      { path: 'a.ts', old_string: 'two\nthree', new_string: 'TWO\nTHREE' },
      ctx,
    );
    expect(edited.content).toBe('Edited a.ts. Changed lines: 2–3.');
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('one\r\nTWO\r\nTHREE\r\n');

    await expect(
      call('fs_edit', { path: 'a.ts', old_string: 'missing', new_string: 'x' }, ctx),
    ).rejects.toThrow(/isn't in a.ts/);
    writeFileSync(join(root, 'c.ts'), 'x\nx\n');
    await expect(
      call('fs_edit', { path: 'c.ts', old_string: 'x', new_string: 'y' }, ctx),
    ).rejects.toThrow(/2 times/);
    await call(
      'fs_edit',
      { path: 'c.ts', old_string: 'x', new_string: 'y', replace_all: true },
      ctx,
    );
    expect(readFileSync(join(root, 'c.ts'), 'utf8')).toBe('y\ny\n');
  });

  it('describe their arguments for the model and check them', () => {
    const read = builtinTool('fs_read')!;
    expect(read.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' } },
      required: ['path'],
    });
    expect(() => read.parse({ path: 3 })).toThrow(/path/);
    expect(BUILTIN_TOOLS.every((t) => t.parameters.type === 'object')).toBe(true);
  });
});

describe('the git tools', () => {
  it('show status and diffs, and commit as the clank', async () => {
    const { root, base } = await workspace({ 'a.txt': 'one\n' });
    const ctx = context(root, base);
    writeFileSync(join(root, 'a.txt'), 'two\n');
    writeFileSync(join(root, 'b.txt'), 'new\n');
    expect((await call('git_status', {}, ctx)).content).toMatch(/M a.txt\n\?\? b.txt/);
    const diff = (await call('git_diff', {}, ctx)).content;
    expect(diff).toContain('-one\n+two');
    expect(diff).toContain('New files, not in the diff (read them with fs_read):\nb.txt');

    const committed = await call('git_commit', { message: 'Change a\n\nBecause.' }, ctx);
    expect(committed.content).toMatch(/^Committed on clanks\/test:\n\n[0-9a-f]{7} Change a/);
    expect(await git(['log', '-1', '--format=%an <%ae>'], { cwd: root })).toBe(
      'Forge (clanks) <forge@clanks.local>',
    );
    expect((await call('git_commit', { message: 'Again' }, ctx)).content).toMatch(
      /Nothing to commit/,
    );
    expect((await call('git_diff', { against: 'base' }, ctx)).content).toContain('+new');
    expect((await call('git_log', { limit: 1 }, ctx)).content).toMatch(
      /Forge \(clanks\): Change a$/,
    );
  });
});

describe('the shell tools', () => {
  it('report how a command ended', async () => {
    const result = (over: Partial<CommandResult>): CommandResult => ({
      handle: 'p1',
      sessionId: 's',
      output: 'out\n',
      running: false,
      exitCode: 0,
      reason: 'exited',
      ...over,
    });
    let next = result({});
    const ctx: ToolContext = {
      ...context(tempDir(), 'x'),
      shell: {
        name: 'bash',
        exec: () => Promise.resolve(next),
        start: () => Promise.resolve(next),
        output: () => next,
        stop: () => Promise.resolve(next),
      },
    };
    expect(await call('shell_exec', { command: 'ls' }, ctx)).toEqual({
      content: 'out\n\n[Exit code 0.]',
      error: false,
      sessionId: 's',
    });
    next = result({ reason: 'timeout', exitCode: null });
    expect(
      (await call('shell_exec', { command: 'sleep 9', timeout_seconds: 2 }, ctx)).content,
    ).toMatch(/Stopped after 2 seconds/);
    next = result({ running: true, reason: null, exitCode: null });
    expect((await call('shell_start', { command: 'npm run dev' }, ctx)).content).toMatch(
      /^Started as p1. Output so far:/,
    );
  });
});

describe('the web tools', () => {
  async function site(routes: Record<string, [string, string]>) {
    const server = createServer((req, res) => {
      const route = routes[req.url ?? ''];
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': route[0] });
      res.end(route[1]);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('fetch pages as text', async () => {
    const url = await site({
      '/page': [
        'text/html; charset=utf-8',
        '<html><head><title>Boards &amp; more</title><script>evil()</script></head><body><nav>Menu</nav><main><h1>Surf</h1><p>Fibreglass&nbsp;boards</p><ul><li>One</li><li><a href="https://x.test/two">Two</a></li></ul></main></body></html>',
      ],
      '/img': ['image/png', 'xx'],
    });
    const ctx = context(tempDir(), 'x');
    const page = await call('web_fetch', { url: `${url}/page` }, ctx);
    expect(page.content).toBe(
      `URL: ${url}/page\nStatus: 200\nTitle: Boards & more\n\n# Surf\n\nFibreglass boards\n\n- One\n- [Two](https://x.test/two)`,
    );
    await expect(call('web_fetch', { url: `${url}/img` }, ctx)).rejects.toThrow(
      /image\/png, not text/,
    );
    expect((await call('web_fetch', { url: `${url}/missing` }, ctx)).error).toBe(true);
  });

  it('search through the backend that is set up', async () => {
    const url = await site({
      '/search?q=surf+wax&format=json': [
        'application/json',
        JSON.stringify({
          results: [{ title: 'Wax <b>guide</b>', url: 'https://x.test', content: 'How to wax' }],
        }),
      ],
    });
    const search = searchWith({ kind: 'searxng', url });
    const ctx = context(tempDir(), 'x', { web: { fetch, search } });
    expect((await call('web_search', { query: 'surf wax' }, ctx)).content).toBe(
      '1. Wax guide\n   https://x.test\n   How to wax',
    );
  });

  it('turns HTML into readable text', () => {
    expect(
      htmlToText('<p>a &lt; b &#x2014; c</p><table><tr><td>1</td><td>2</td></tr></table>').text,
    ).toBe('a < b — c\n\n1 | 2 |');
  });
});

describe('the browser tools', () => {
  /** Records each step and answers it with the step's name. */
  function browser(): { access: BrowserAccess; steps: unknown[][] } {
    const steps: unknown[][] = [];
    const step =
      (name: string) =>
      (...args: unknown[]) => {
        steps.push([name, ...args]);
        return Promise.resolve({ content: `did ${name}` });
      };
    return {
      steps,
      access: {
        open: step('open'),
        navigate: step('navigate'),
        read: step('read'),
        click: step('click'),
        type: step('type'),
        press: step('press'),
        scroll: step('scroll'),
        screenshot: () =>
          Promise.resolve({
            content: 'A screenshot',
            image: { data: new Uint8Array([1]), mediaType: 'image/jpeg' as const },
          }),
        console: step('console'),
        back: step('back'),
        close: step('close'),
        search: (query: string) =>
          Promise.resolve(
            query === 'blocked'
              ? { results: [], page: 'Please prove you are human' }
              : {
                  results: [{ title: 'Surf', url: 'https://surf.test', snippet: 'Waves' }],
                  page: null,
                },
          ),
      },
    };
  }

  it('act through the browser, taking refs however the model writes them', async () => {
    const { access, steps } = browser();
    const ctx = context(tempDir(), 'x', { browser: access });
    expect((await call('browser_click', { ref: '[12]' }, ctx)).content).toBe('did click');
    await call('browser_type', { ref: 3, text: 'foam', submit: true }, ctx);
    await call('browser_read', {}, ctx);
    await call('browser_scroll', {}, ctx);
    await call('browser_scroll', { ref: '4' }, ctx);
    expect(steps).toEqual([
      ['click', 12],
      ['type', 3, 'foam', true],
      ['read', 1],
      ['scroll', 'down', null],
      ['scroll', 'down', 4],
    ]);
    expect(() => builtinTool('browser_click')!.parse({ ref: 'the button' })).toThrow();
  });

  it('show a screenshot to the model, and only to a model that can see', async () => {
    const { access } = browser();
    const ctx = context(tempDir(), 'x', { browser: access });
    const shot = await call('browser_screenshot', {}, ctx);
    expect(shot).toMatchObject({ content: 'A screenshot', showModel: true });
    expect(builtinTool('browser_screenshot')!.needs).toEqual(['browser', 'vision']);
    expect(builtinTool('browser_read')!.needs).toEqual(['browser']);
  });

  it('ask before opening a site, and always allow the whole site', () => {
    const open = builtinTool('browser_open')!;
    expect(open.approval(open.parse({ url: 'https://shop.test/a?b=1' }))).toEqual({
      kind: 'url',
      subject: 'https://shop.test/a?b=1',
      pattern: 'https://shop.test/*',
    });
    expect(open.label(open.parse({ url: 'https://shop.test/a?token=x' }))).toBe(
      'Opening `shop.test/a`',
    );
  });

  it('search in the browser when no backend is set up', async () => {
    const { access } = browser();
    const ctx = context(tempDir(), 'x', { browser: access });
    expect((await call('web_search', { query: 'surf' }, ctx)).content).toBe(
      '1. Surf\n   https://surf.test\n   Waves',
    );
    expect((await call('web_search', { query: 'blocked' }, ctx)).content).toMatch(
      /couldn't be picked off[\s\S]*prove you are human/,
    );
    await expect(call('web_search', { query: 'x' }, context(tempDir(), 'x'))).rejects.toThrow(
      /No web search/,
    );
  });
});

describe('the policy', () => {
  const doc: ClankFrontmatter['tools'] = {
    allow: ['fs_read', 'browser_screenshot'],
    ask: ['shell_exec', 'browser_*'],
    deny: ['web_fetch'],
  };

  it('follows the doc, an exact entry over a group', () => {
    expect(docLevel(doc, 'fs_read')).toBe('allow');
    expect(docLevel(doc, 'browser_open')).toBe('ask');
    expect(docLevel(doc, 'browser_screenshot')).toBe('allow');
    expect(docLevel(doc, 'web_fetch')).toBe('deny');
    expect(docLevel(doc, 'fs_write')).toBe('off');
  });

  it("lets the user's choice win, and starts MCP tools at ask", () => {
    expect(policyFor({ doc, overrides: { shell_exec: 'allow' }, name: 'shell_exec' })).toEqual({
      level: 'allow',
      defaultLevel: 'ask',
      overridden: true,
    });
    expect(policyFor({ doc, overrides: {}, name: 'mcp_x_y', mcp: true }).level).toBe('ask');
  });
});

describe('labels', () => {
  it('hide what looks like a secret', () => {
    expect(redactCommand('API_KEY=abc123 npm run deploy --token xyz')).toBe(
      'API_KEY=*** npm run deploy --token ***',
    );
    expect(redactCommand('curl -H "Authorization: Bearer sk-1" https://u:p@x.test')).toBe(
      'curl -H "Authorization: Bearer *** https://***@x.test',
    );
    expect(redactUrl('https://x.test/a/b?token=1')).toBe('x.test/a/b');
  });

  it('name every built-in tool', () => {
    for (const tool of BUILTIN_TOOLS as ToolSpec<Record<string, string>>[]) {
      const label = tool.label({
        path: 'a',
        pattern: 'p',
        command: 'c',
        url: 'https://x.test',
        query: 'q',
        handle: 'p1',
        message: 'Wiring up the cart',
        keys: 'Enter',
        ref: '1',
        text: 't',
        key: 'SURF-1',
        depends_on: 'SURF-2',
        title: 'Add checkout',
        type: 'pr',
        to: 'forge',
        clank: 'forge',
        body: 'Picked Zustand for the cart',
      });
      expect(label.length, tool.name).toBeGreaterThan(3);
    }
  });
});

describe('MCP servers', () => {
  const script = fileURLToPath(new URL('./test/mcp-server.mjs', import.meta.url));
  const config = {
    id: 'fixture',
    name: 'Fixture',
    slug: mcpSlug('Fixture!'),
    transport: 'stdio' as const,
    command: process.execPath,
    args: [script],
    url: '',
    secrets: { FIXTURE_SECRET: 'shh' },
  };

  it('names tools after their server', () => {
    expect(mcpSlug('My Tools 2!')).toBe('mytools2');
    expect(mcpToolName('gh', 'Create-Issue')).toBe('mcp_gh_create_issue');
  });

  it("lists and calls a server's tools", async () => {
    const manager = new McpManager({ name: 'clanks-test', version: '0' });
    onTestFinished(() => manager.closeAll());
    const tools = await manager.tools(config);
    expect(tools.map((t) => t.fullName)).toEqual([
      'mcp_fixture_add',
      'mcp_fixture_secret',
      'mcp_fixture_fails',
    ]);
    expect(manager.status('fixture').state).toBe('ready');

    const add = mcpToolSpec(manager, config, tools[0]!);
    expect(add.parameters).toMatchObject({ type: 'object', properties: { a: { type: 'number' } } });
    const ctx = context(tempDir(), 'x');
    expect(await add.run(add.parse({ a: 2, b: 3 }), ctx)).toEqual({ content: '5', error: false });
    const secret = mcpToolSpec(manager, config, tools[1]!);
    expect((await secret.run({}, ctx)).content).toBe('shh');
    const fails = mcpToolSpec(manager, config, tools[2]!);
    expect(await fails.run({}, ctx)).toEqual({ content: 'It broke', error: true });
  }, 30_000);

  it('says why a server failed to start', async () => {
    const manager = new McpManager({ name: 'clanks-test', version: '0' });
    onTestFinished(() => manager.closeAll());
    await expect(
      manager.tools({
        ...config,
        id: 'broken',
        args: ['-e', 'console.error("no such module"); process.exit(1)'],
      }),
    ).rejects.toThrow();
    expect(manager.status('broken')).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('no such module') as string,
    });
  }, 30_000);
});
