import type {
  RoutineRunStatus,
  RoutineStatus,
  RoutinesSnapshot,
  ScheduledActionStatus,
} from '@clanks/core';
import { dateIn, timeIn, whenText, zoneAbbreviation } from '@clanks/routines';
import { useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useEffect, useState } from 'react';
import type { Tone } from '../components/ui';
import { useTRPC } from './trpc';

/** A project's routines, runs and scheduled actions, kept live. */
export function useRoutines(projectId: string): RoutinesSnapshot | undefined {
  const trpc = useTRPC();
  const initial = useQuery(trpc.routines.snapshot.queryOptions(projectId));
  const live = useSubscription(trpc.routines.live.subscriptionOptions(projectId));
  return live.data ?? initial.data;
}

/** The time now, refreshed each half minute, for what's said relative to it. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "Fri 14 Nov at 17:00 AEDT": a time in a routine's zone, with which zone that is. */
export function when(at: Date, zone: string, now: Date): string {
  return `${whenText(at, zone, now)} ${zoneAbbreviation(at, zone)}`;
}

export { dateIn, timeIn, whenText };

/** How long until a time, or since it: "in 3 h", "12 min ago". */
export function fromNow(at: Date, now: Date): string {
  const ms = +at - +now;
  const minutes = Math.round(Math.abs(ms) / 60_000);
  const text =
    minutes < 1
      ? 'a moment'
      : minutes < 60
        ? `${minutes} min`
        : minutes < 48 * 60
          ? `${Math.round(minutes / 60)} h`
          : `${Math.round(minutes / 1440)} days`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

export const ROUTINE_STATUS: Record<RoutineStatus, { text: string; tone: Tone }> = {
  draft: { text: 'Draft', tone: 'dim' },
  active: { text: 'On', tone: 'mint' },
  paused: { text: 'Paused', tone: 'amber' },
  done: { text: 'Done', tone: 'dim' },
};

export const RUN_STATUS: Record<RoutineRunStatus, { text: string; tone: Tone }> = {
  scheduled: { text: 'Waiting its turn', tone: 'dim' },
  working: { text: 'The crew is working', tone: 'mint' },
  awaiting_approval: { text: 'Needs your approval', tone: 'amber' },
  approved: { text: 'Approved, waiting for its time', tone: 'lavender' },
  done: { text: 'Done', tone: 'dim' },
  skipped: { text: 'Skipped', tone: 'dim' },
  missed: { text: 'Missed', tone: 'amber' },
  failed: { text: 'Failed', tone: 'rose' },
  cancelled: { text: 'Stopped', tone: 'dim' },
};

export const ACTION_STATUS: Record<ScheduledActionStatus, { text: string; tone: Tone }> = {
  pending_approval: { text: 'Needs approval', tone: 'amber' },
  approved: { text: 'Approved', tone: 'lavender' },
  executing: { text: 'Sending', tone: 'mint' },
  done: { text: 'Sent', tone: 'mint' },
  failed: { text: 'Failed', tone: 'rose' },
  unknown: { text: 'Outcome unknown', tone: 'amber' },
  missed: { text: 'Missed', tone: 'amber' },
  cancelled: { text: 'Taken off', tone: 'dim' },
};

/** A date and time as an `<input type="datetime-local">` holds it, in this computer's own zone. */
export function toLocalInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
