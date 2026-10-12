import { pad } from './zone';

/**
 * The small OS task that starts clanks a few minutes before its next run or action, when it isn't
 * running: a Task Scheduler task on Windows, a launchd agent on macOS, a systemd user timer on
 * Linux. It only starts the app. It holds no credentials, and it's removed when no routine is on.
 * This file only words the task; the desktop shell registers it.
 */

/** How long before a run or an action the app is started. */
export const LAUNCH_LEAD_MS = 3 * 60_000;

/** What the task is called, wherever the OS lists it. */
export const LAUNCH_TASK = {
  windows: 'clanks next routine',
  macos: 'si.clanks.app.routines',
  linux: 'clanks-routines',
} as const;

/** The switch the task starts the app with, so it stays in the tray instead of opening its window. */
export const BACKGROUND_SWITCH = '--background';

/** A local date and time, as this computer's own clock shows it. */
interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** An instant as this computer's clock shows it, which is what the OS's schedulers go by. */
export function localTime(at: Date): LocalTime {
  return {
    year: at.getFullYear(),
    month: at.getMonth() + 1,
    day: at.getDate(),
    hour: at.getHours(),
    minute: at.getMinutes(),
  };
}

const stamp = (t: LocalTime) =>
  `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:00`;

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A Task Scheduler task that starts the app once, at a time. Windows can wake the computer for it,
 * which is the only place routines can run with the computer asleep.
 */
export function windowsTaskXml(input: { exe: string; at: Date; wake: boolean }): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Starts clanks a few minutes before its next routine. It only starts the app.</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <TimeTrigger>',
    `      <StartBoundary>${stamp(localTime(input.at))}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    `    <WakeToRun>${input.wake ? 'true' : 'false'}</WakeToRun>`,
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xml(input.exe)}</Command>`,
    `      <Arguments>${BACKGROUND_SWITCH}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** The commands that register a task from its XML file, and that remove it. */
export function windowsTaskCommands(xmlFile: string): { register: string[]; remove: string[] } {
  return {
    register: ['schtasks', '/Create', '/TN', LAUNCH_TASK.windows, '/XML', xmlFile, '/F'],
    remove: ['schtasks', '/Delete', '/TN', LAUNCH_TASK.windows, '/F'],
  };
}

/**
 * A launchd agent that opens the app at a day and time. launchd has no "once", so it names the
 * month and day too, and the app replaces it after each run. It can't wake a sleeping Mac.
 */
export function launchdPlist(input: { app: string; at: Date }): string {
  const t = localTime(input.at);
  const entry = (key: string, value: number) =>
    `    <key>${key}</key>\n    <integer>${value}</integer>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCH_TASK.macos}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/usr/bin/open</string>',
    '    <string>-g</string>',
    '    <string>-a</string>',
    `    <string>${xml(input.app)}</string>`,
    '    <string>--args</string>',
    `    <string>${BACKGROUND_SWITCH}</string>`,
    '  </array>',
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    entry('Month', t.month),
    entry('Day', t.day),
    entry('Hour', t.hour),
    entry('Minute', t.minute),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The commands that load an agent from its plist for a user, and that unload it. */
export function launchdCommands(
  plist: string,
  uid: number,
): { register: string[][]; remove: string[] } {
  const domain = `gui/${uid}`;
  return {
    // Loading one that's loaded already fails, so the old one goes first.
    register: [
      ['launchctl', 'bootout', `${domain}/${LAUNCH_TASK.macos}`],
      ['launchctl', 'bootstrap', domain, plist],
    ],
    remove: ['launchctl', 'bootout', `${domain}/${LAUNCH_TASK.macos}`],
  };
}

function systemdQuote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** A systemd user timer and the service it starts. It can't wake a sleeping computer either. */
export function systemdUnits(input: { exe: string; at: Date }): { service: string; timer: string } {
  const t = localTime(input.at);
  return {
    service: [
      '[Unit]',
      'Description=Starts clanks before its next routine',
      '',
      '[Service]',
      'Type=oneshot',
      `ExecStart=${systemdQuote(input.exe)} ${BACKGROUND_SWITCH}`,
      '',
    ].join('\n'),
    timer: [
      '[Unit]',
      'Description=Starts clanks before its next routine',
      '',
      '[Timer]',
      `OnCalendar=${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}:00`,
      'AccuracySec=30s',
      'Persistent=false',
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n'),
  };
}

/** The commands that turn the timer on once its units are written, and that turn it off. */
export function systemdCommands(): { register: string[][]; remove: string[][] } {
  const timer = `${LAUNCH_TASK.linux}.timer`;
  return {
    register: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', timer],
    ],
    remove: [
      ['systemctl', '--user', 'disable', '--now', timer],
      ['systemctl', '--user', 'daemon-reload'],
    ],
  };
}

/** When to start the app for something due at a time. Null when that's too soon to bother. */
export function launchTime(due: Date, now: Date): Date | null {
  const at = new Date(+due - LAUNCH_LEAD_MS);
  // A task for the minute that's already here would never fire.
  return +at - +now < 90_000 ? null : at;
}

/** What each platform can and can't do about a sleeping computer, said plainly. */
export function sleepNote(platform: string): string {
  return platform === 'win32'
    ? 'Windows can wake this computer for it, if waking timers are allowed in its power settings.'
    : 'This computer has to be awake at the time: nothing can wake it without admin rights.';
}
