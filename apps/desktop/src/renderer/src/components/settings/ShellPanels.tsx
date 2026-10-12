import type { SettingsPatch, ShellArrangement, ShellStatus } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { formatAgo } from '../../lib/format';
import { useTRPC } from '../../lib/trpc';
import { Button, ErrorText, Panel, ProgressBar, Toggle } from '../ui';

function useSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const update = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (next) => queryClient.setQueryData(trpc.settings.get.queryKey(), next),
    }),
  );
  return {
    settings: settings.data,
    update: (patch: SettingsPatch) => update.mutate(patch),
    mutation: update,
  };
}

/** What the desktop shell has set up outside the app, kept live. */
function useShell(): ShellStatus | undefined {
  const trpc = useTRPC();
  return useSubscription(trpc.app.shell.subscriptionOptions()).data;
}

function lookedAgo(at: Date): string {
  const ago = formatAgo(at);
  return ago === 'now' ? 'just now' : `${ago} ago`;
}

function arrangement(state: ShellArrangement | undefined, on: string): string {
  if (state === 'on') return on;
  if (state === 'failed') return "It couldn't be set up on this computer.";
  if (state === 'unsupported') return 'Set up by the installed app, not when running from source.';
  return '';
}

/** Routines and the computer: pausing them all, notifications, staying awake, and starting up. */
export function RoutinesPanel() {
  const { settings, update, mutation } = useSettings();
  const shell = useShell();
  if (!settings) return null;
  const { launch } = shell ?? { launch: undefined };
  return (
    <Panel
      title="Routines"
      description="Routines run inside clanks, so it has to be running, and this computer awake, when a run starts or an action goes out. Closing the window leaves it in the tray."
    >
      <div className="flex flex-col gap-5">
        <Toggle
          label="Pause every routine"
          description="Nothing starts and nothing goes out until you turn this off. What would have run in between isn't made up afterwards."
          checked={settings.routinesPaused}
          onChange={(routinesPaused) => update({ routinesPaused })}
        />
        <Toggle
          label="Notifications"
          description="When something is ready for you to approve, a reminder before it's due, and when an action was missed or failed or a routine was paused. A notification opens its card; nothing is approved from it."
          checked={settings.notifications}
          onChange={(notifications) => update({ notifications })}
        />
        <Toggle
          label="Keep this computer awake while work is due"
          description="While a run is working, or an action is about to go out, the computer doesn't go to sleep on its own."
          checked={settings.keepAwake}
          onChange={(keepAwake) => update({ keepAwake })}
        />
        <Toggle
          label="Start clanks when you sign in"
          description={`It starts in the tray, without opening its window. ${settings.launchAtLogin ? arrangement(launch?.atLogin, '') : ''}`.trim()}
          checked={settings.launchAtLogin}
          onChange={(launchAtLogin) => update({ launchAtLogin })}
        />
        <Toggle
          label="Start clanks before a run, if it isn't running"
          description={`A small task with your operating system starts the app a few minutes before the next run or action. It only starts the app, holds no keys, and is removed when nothing is coming. ${launch?.note ?? ''} ${settings.launchForRuns ? arrangement(launch?.forRuns, launch?.next ? `It will next start the app ${launch.next.toLocaleString()}.` : 'Nothing is coming, so no task is set.') : ''}`.trim()}
          checked={settings.launchForRuns}
          onChange={(launchForRuns) => update({ launchForRuns })}
        />
        {mutation.error && <ErrorText>{mutation.error.message}</ErrorText>}
      </div>
    </Panel>
  );
}

/** Newer versions of clanks: whether to look, what was found, and installing it when asked. */
export function UpdatesPanel() {
  const trpc = useTRPC();
  const { settings, update } = useSettings();
  const shell = useShell();
  const check = useMutation(trpc.app.checkForUpdates.mutationOptions());
  const download = useMutation(trpc.app.downloadUpdate.mutationOptions());
  const install = useMutation(trpc.app.installUpdate.mutationOptions());
  if (!settings) return null;
  const status = shell?.update;
  const state = status?.state ?? 'unsupported';
  return (
    <Panel
      title="Updates"
      description="clanks looks for a newer version on its releases page. Nothing is fetched or installed until you say so."
    >
      <div className="flex flex-col gap-5">
        <Toggle
          label="Look for updates"
          description="When clanks starts, and a few times a day while it runs. The only thing sent is the request for the list of releases."
          checked={settings.autoUpdate}
          onChange={(autoUpdate) => update({ autoUpdate })}
        />
        {state === 'unsupported' ? (
          <p className="text-sm text-dim">
            This copy can't update itself: it's running from source, or its installer isn't one the
            updater covers. Get new versions from clanks.si.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {state === 'checking' && 'Looking for a newer version…'}
              {state === 'current' && "You're on the newest version."}
              {state === 'idle' && "Hasn't looked yet."}
              {state === 'available' && `clanks ${status?.version} is out.`}
              {state === 'downloading' && `Fetching clanks ${status?.version ?? ''}…`}
              {state === 'ready' &&
                `clanks ${status?.version} is ready. Restarting stops any run that's going; it picks up where it was.`}
              {state === 'error' && (status?.error ?? "It couldn't look.")}
              {status?.checkedAt && state !== 'checking' && (
                <span className="text-dim"> Looked {lookedAgo(status.checkedAt)}.</span>
              )}
            </p>
            {state === 'downloading' && <ProgressBar value={status?.progress ?? 0} />}
            {status?.notes && (state === 'available' || state === 'ready') && (
              <pre className="max-h-48 overflow-y-auto rounded-xl border border-line bg-black/20 p-3 text-[13px] whitespace-pre-wrap text-white/80">
                {status.notes}
              </pre>
            )}
            <span className="flex flex-wrap gap-2">
              {state === 'available' && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={download.isPending}
                  onClick={() => download.mutate()}
                >
                  Fetch it
                </Button>
              )}
              {state === 'ready' && (
                <Button size="sm" variant="primary" onClick={() => install.mutate()}>
                  Restart and update
                </Button>
              )}
              {state !== 'downloading' && state !== 'ready' && (
                <Button
                  size="sm"
                  disabled={check.isPending || state === 'checking'}
                  onClick={() => check.mutate()}
                >
                  Look now
                </Button>
              )}
            </span>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Crash reports: kept on this computer, and sent only if the user turns that on. */
export function CrashReportsPanel() {
  const trpc = useTRPC();
  const { settings, update } = useSettings();
  const shell = useShell();
  const open = useMutation(trpc.app.openCrashFolder.mutationOptions());
  if (!settings) return null;
  const reports = shell?.crashReports;
  return (
    <Panel
      title="Crash reports"
      description="When clanks crashes, a report of where in the app it happened is kept on this computer. It has no chats, files, prompts or keys in it."
    >
      <div className="flex flex-col gap-4">
        <Toggle
          label="Send crash reports"
          description={
            reports?.canSend === false
              ? 'This build has nowhere to send them, so they only ever stay on this computer. Attach one to an issue if you report a crash.'
              : 'Off unless you turn it on. A report says the version, your operating system and where the app was when it crashed.'
          }
          checked={settings.crashReports && reports?.canSend !== false}
          disabled={reports?.canSend === false}
          onChange={(crashReports) => update({ crashReports })}
        />
        {reports?.folder && (
          <span>
            <Button size="sm" variant="ghost" onClick={() => open.mutate()}>
              Open the folder they're kept in
            </Button>
          </span>
        )}
      </div>
    </Panel>
  );
}
