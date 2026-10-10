import { describe, expect, it } from 'vitest';
import { containerArgs, containerName, dockerStatus, markedExecArgs } from './docker';

describe('the Docker sandbox', () => {
  it('starts a container with only the worktree, and the network off unless allowed', () => {
    const args = containerArgs({
      name: 'clanks-run1',
      worktree: 'C:/wt/SURF-3',
      image: 'node:22-bookworm',
      network: false,
    });
    expect(args).toContain('--network');
    expect(args.slice(args.indexOf('--volume'), args.indexOf('--volume') + 2)).toEqual([
      '--volume',
      'C:/wt/SURF-3:/work',
    ]);
    expect(args.filter((a) => a === '--volume')).toHaveLength(1);
    expect(args.slice(-3)).toEqual(['node:22-bookworm', 'sleep', 'infinity']);
    expect(
      containerArgs({ name: 'x', worktree: '/w', image: 'node:22', network: true }),
    ).not.toContain('--network');
    expect(containerName('a1b2-c3!')).toBe('clanks-a1b2-c3');
  });

  it('runs each command marked, so it can be stopped inside the container', () => {
    expect(
      markedExecArgs(
        { container: 'clanks-run1', workdir: '/work/web' },
        'npm test',
        'clanks-cmd-1',
      ),
    ).toEqual([
      'exec',
      '--workdir',
      '/work/web',
      'clanks-run1',
      'setsid',
      'bash',
      '-lc',
      'npm test',
      'clanks-cmd-1',
    ]);
  });

  it("says when Docker isn't installed", async () => {
    expect(await dockerStatus('docker-that-is-not-here')).toMatchObject({
      installed: false,
      running: false,
      problem: "Docker isn't installed",
    });
  });
});
