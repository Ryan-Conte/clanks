import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

/**
 * Windows job objects, for stopping everything a command started. Windows keeps no process tree:
 * a process names the parent that started it, and when a launcher in the middle exits, as the
 * ones Git's bash and npm run scripts through do, nothing leads to what's under it any more. A job
 * holds every process started inside it, whoever its parent was, and ends them all at once.
 *
 * Node can't make one, so one small PowerShell process does it for the whole app, told what to do
 * a line at a time. Its jobs end with it, so when the app goes, however it goes, so does everything
 * its commands left running.
 */
const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ClanksJobs {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits info, int length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);

  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long PerProcessTime, PerJobTime; public uint Flags; public UIntPtr MinSet, MaxSet;
    public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public Basic Basic; public Counters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Entry {
    public uint Size, Usage, Pid; public IntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string File;
  }

  static readonly Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();

  static List<int> Children(int parent) {
    var found = new List<int>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return found;
    var entry = new Entry(); entry.Size = (uint)Marshal.SizeOf(typeof(Entry));
    if (Process32FirstW(snapshot, ref entry)) {
      do {
        if (entry.Parent == (uint)parent && !entry.File.Equals("conhost.exe", StringComparison.OrdinalIgnoreCase)) found.Add((int)entry.Pid);
      } while (Process32NextW(snapshot, ref entry));
    }
    CloseHandle(snapshot);
    return found;
  }

  static bool Assign(IntPtr job, int pid) {
    IntPtr process = OpenProcess(0x0101, false, pid);
    if (process == IntPtr.Zero) return false;
    bool done = AssignProcessToJobObject(job, process);
    CloseHandle(process);
    return done;
  }

  // Puts a process and the children it has by now in a new job. True when a child was there to take.
  public static bool Adopt(string id, int pid, int waitMs) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return false;
    var limits = new Limits(); limits.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Limits)))) { CloseHandle(job); return false; }
    jobs[id] = job;
    Assign(job, pid);
    var deadline = DateTime.UtcNow.AddMilliseconds(waitMs);
    for (;;) {
      var children = Children(pid);
      if (children.Count > 0) { bool all = true; foreach (int child in children) all &= Assign(job, child); return all; }
      if (DateTime.UtcNow > deadline) return false;
      System.Threading.Thread.Sleep(10);
    }
  }

  public static void End(string id) {
    IntPtr job;
    if (!jobs.TryGetValue(id, out job)) return;
    jobs.Remove(id);
    TerminateJobObject(job, 1);
    CloseHandle(job);
  }
}
"@
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ')
  try {
    if ($parts[0] -eq 'adopt') {
      $ok = [ClanksJobs]::Adopt($parts[1], [int]$parts[2], [int]$parts[3])
      [Console]::Out.WriteLine(($(if ($ok) { 'ok ' } else { 'no ' })) + $parts[1])
    } elseif ($parts[0] -eq 'end') {
      [ClanksJobs]::End($parts[1])
    }
  } catch {
    if ($parts[0] -eq 'adopt') { [Console]::Out.WriteLine('no ' + $parts[1]) }
  }
}
`;

/** How long the helper waits for a command's shell to appear under its launcher. */
const ADOPT_WAIT_MS = 1500;
/** How long a command waits for its job before it starts without one. */
const ADOPT_TIMEOUT_MS = 3000;

let helper: ChildProcessWithoutNullStreams | null = null;
let ready = false;
let failed = false;
let counter = 0;
const waiting = new Map<string, (adopted: boolean) => void>();

function start(): void {
  if (helper || failed) return;
  try {
    const encoded = Buffer.from(HELPER, 'utf16le').toString('base64');
    // Not detached: PowerShell started with no console at all exits at once, having done nothing.
    helper = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    failed = true;
    return;
  }
  const lost = () => {
    helper = null;
    ready = false;
    for (const resolve of waiting.values()) resolve(false);
    waiting.clear();
  };
  helper.on('error', () => {
    failed = true;
    lost();
  });
  helper.on('exit', () => {
    // One that goes before it was ever up can't work here, such as where scripts are locked
    // down: commands run without jobs from then on, rather than wait for it each time.
    if (!ready) failed = true;
    lost();
  });
  helper.stdin.on('error', () => {});
  let buffer = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end === -1) break;
      const [word, id] = buffer.slice(0, end).trim().split(' ');
      buffer = buffer.slice(end + 1);
      if (word === 'ready') ready = true;
      else if (id && (word === 'ok' || word === 'no')) {
        waiting.get(id)?.(word === 'ok');
        waiting.delete(id);
      }
    }
  });
  helper.stderr.resume();
  // It never keeps the app from quitting: when the app goes, so does it, and its jobs with it.
  helper.unref();
  for (const pipe of [helper.stdin, helper.stdout, helper.stderr]) {
    (pipe as unknown as { unref?: () => void }).unref?.();
  }
}

/** A job for one command. */
export interface CommandJob {
  /**
   * Puts the command's launcher, and the shell it has started by now, in the job. Resolves true
   * once they're in, so everything they start from then on is too; false when it couldn't be done,
   * and the command runs without one.
   */
  adopt(pid: number): Promise<boolean>;
  /** Ends every process in the job, and the job. */
  end(): void;
}

/**
 * A job for a command about to start, on Windows. Null elsewhere, and while the helper isn't up:
 * the first commands after the app starts run without one rather than wait for it.
 */
export function commandJob(): CommandJob | null {
  if (process.platform !== 'win32') return null;
  start();
  if (!helper || !ready) return null;
  const id = `j${++counter}`;
  let ended = false;
  return {
    adopt: (pid) =>
      new Promise((resolve) => {
        const pipe = helper;
        if (!pipe || ended) return resolve(false);
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve(false);
        }, ADOPT_TIMEOUT_MS);
        waiting.set(id, (adopted) => {
          clearTimeout(timer);
          resolve(adopted);
        });
        pipe.stdin.write(`adopt ${id} ${pid} ${ADOPT_WAIT_MS}\n`);
      }),
    end: () => {
      if (ended) return;
      ended = true;
      helper?.stdin.write(`end ${id}\n`);
    },
  };
}

/**
 * Starts the helper, and resolves once it can make jobs: true at once where none are needed, and
 * false if it isn't up in time, when commands run without one. The helper takes a second or two
 * to start, so the first command of a session waits here rather than run unprotected.
 */
export async function jobsReady(timeoutMs = 3000): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  start();
  const deadline = Date.now() + timeoutMs;
  while (!ready && !failed && helper && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return ready;
}
