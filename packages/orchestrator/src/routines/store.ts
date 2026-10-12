import type {
  Routine,
  RoutineRun,
  RoutineRunStatus,
  ScheduledAction,
  ScheduledActionStatus,
} from '@clanks/core';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import {
  routine as routineTable,
  routineRun as runTable,
  scheduledAction as actionTable,
} from '../store/schema';
import type { Db } from '../store/store';

type RunRow = typeof runTable.$inferSelect;
type ActionRow = typeof actionTable.$inferSelect;

/** A run with what only the scheduler needs to know of it. */
export type StoredRun = RoutineRun & Pick<RunRow, 'notified' | 'reminded'>;

/** An action with what only the scheduler needs to know of it. */
export type StoredAction = ScheduledAction & Pick<ActionRow, 'attemptId' | 'retryAt'>;

export type RoutineChanges = Partial<Omit<Routine, 'id' | 'projectId' | 'createdAt'>>;
export type RunChanges = Partial<Omit<StoredRun, 'id' | 'routineId' | 'projectId' | 'createdAt'>>;
export type ActionChanges = Partial<Omit<StoredAction, 'id' | 'projectId' | 'createdAt'>>;

/** Routines, their runs and scheduled actions, in SQLite. */
export class RoutineStore {
  constructor(private readonly db: Db) {}

  routines(projectId?: string): Routine[] {
    const query = this.db.select().from(routineTable);
    return (projectId ? query.where(eq(routineTable.projectId, projectId)) : query)
      .orderBy(asc(routineTable.createdAt))
      .all();
  }

  routine(id: string): Routine | undefined {
    return this.db.select().from(routineTable).where(eq(routineTable.id, id)).get();
  }

  insertRoutine(routine: Routine): void {
    this.db.insert(routineTable).values(routine).run();
  }

  updateRoutine(id: string, changes: RoutineChanges): void {
    this.db.update(routineTable).set(changes).where(eq(routineTable.id, id)).run();
  }

  deleteRoutine(id: string): void {
    this.db.delete(routineTable).where(eq(routineTable.id, id)).run();
  }

  /** A project's runs, or every project's, newest first. */
  runs(projectId: string | null, limit: number): StoredRun[] {
    const query = this.db.select().from(runTable);
    return (projectId ? query.where(eq(runTable.projectId, projectId)) : query)
      .orderBy(desc(runTable.scheduledFor), desc(runTable.createdAt))
      .limit(limit)
      .all();
  }

  run(id: string): StoredRun | undefined {
    return this.db.select().from(runTable).where(eq(runTable.id, id)).get();
  }

  runsOf(routineId: string, limit = 50): StoredRun[] {
    return this.db
      .select()
      .from(runTable)
      .where(eq(runTable.routineId, routineId))
      .orderBy(desc(runTable.scheduledFor), desc(runTable.createdAt))
      .limit(limit)
      .all();
  }

  runsWith(statuses: readonly RoutineRunStatus[], projectId?: string): StoredRun[] {
    return this.db
      .select()
      .from(runTable)
      .where(
        projectId
          ? and(eq(runTable.projectId, projectId), inArray(runTable.status, [...statuses]))
          : inArray(runTable.status, [...statuses]),
      )
      .orderBy(asc(runTable.scheduledFor), asc(runTable.createdAt))
      .all();
  }

  /** A routine's run for one scheduled time, if it has one: nothing runs twice for the same time. */
  runAt(routineId: string, scheduledFor: Date): StoredRun | undefined {
    return this.db
      .select()
      .from(runTable)
      .where(and(eq(runTable.routineId, routineId), eq(runTable.scheduledFor, scheduledFor)))
      .get();
  }

  /** A routine's runs since a time, for what it has spent this month. */
  runsSince(routineId: string, since: Date): StoredRun[] {
    return this.db
      .select()
      .from(runTable)
      .where(and(eq(runTable.routineId, routineId), gte(runTable.createdAt, since)))
      .all();
  }

  insertRun(run: StoredRun): void {
    this.db.insert(runTable).values(run).run();
  }

  updateRun(id: string, changes: RunChanges): void {
    this.db.update(runTable).set(changes).where(eq(runTable.id, id)).run();
  }

  deleteRun(id: string): void {
    this.db.delete(runTable).where(eq(runTable.id, id)).run();
  }

  action(id: string): StoredAction | undefined {
    return this.db.select().from(actionTable).where(eq(actionTable.id, id)).get();
  }

  actionsOf(runId: string): StoredAction[] {
    return this.db
      .select()
      .from(actionTable)
      .where(eq(actionTable.runId, runId))
      .orderBy(asc(actionTable.executeAt), asc(actionTable.createdAt))
      .all();
  }

  /** A campaign ticket's posts that were scheduled. */
  actionsOfTicket(ticketId: string): StoredAction[] {
    return this.db
      .select()
      .from(actionTable)
      .where(and(eq(actionTable.ticketId, ticketId), isNull(actionTable.runId)))
      .orderBy(asc(actionTable.executeAt))
      .all();
  }

  actionsWith(statuses: readonly ScheduledActionStatus[], projectId?: string): StoredAction[] {
    return this.db
      .select()
      .from(actionTable)
      .where(
        projectId
          ? and(eq(actionTable.projectId, projectId), inArray(actionTable.status, [...statuses]))
          : inArray(actionTable.status, [...statuses]),
      )
      .orderBy(asc(actionTable.executeAt))
      .all();
  }

  /** A project's actions that have ended one way or another, the latest first. */
  pastActions(projectId: string, limit: number): StoredAction[] {
    return this.db
      .select()
      .from(actionTable)
      .where(
        and(
          eq(actionTable.projectId, projectId),
          inArray(actionTable.status, ['done', 'failed', 'missed', 'cancelled']),
        ),
      )
      .orderBy(desc(actionTable.executeAt))
      .limit(limit)
      .all();
  }

  /** Approved actions whose time has come. */
  dueActions(now: Date): StoredAction[] {
    return this.db
      .select()
      .from(actionTable)
      .where(and(eq(actionTable.status, 'approved'), lte(actionTable.executeAt, now)))
      .orderBy(asc(actionTable.executeAt))
      .all();
  }

  insertAction(action: StoredAction): void {
    this.db.insert(actionTable).values(action).run();
  }

  updateAction(id: string, changes: ActionChanges): void {
    this.db.update(actionTable).set(changes).where(eq(actionTable.id, id)).run();
  }

  deleteAction(id: string): void {
    this.db.delete(actionTable).where(eq(actionTable.id, id)).run();
  }
}
