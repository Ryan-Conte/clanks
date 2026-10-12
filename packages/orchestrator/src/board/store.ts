import type { BoardEvent, Bounce, SpecVersion, Ticket } from '@clanks/core';
import { and, asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import {
  boardEvent,
  bounce as bounceTable,
  spec as specTable,
  ticketDependency,
  ticket as ticketTable,
} from '../store/schema';
import type { Db } from '../store/store';

type TicketRow = typeof ticketTable.$inferSelect;

/** The columns a ticket's update can change. */
export type TicketChanges = Partial<Omit<TicketRow, 'id' | 'projectId' | 'number' | 'key'>>;

function toTicket(row: TicketRow, dependsOn: string[]): Ticket {
  return {
    ...row,
    reviews: row.reviews ?? [],
    skipped: row.skipped ?? [],
    routine: row.routine ?? null,
    dependsOn,
  };
}

/** Model use in a project, added up per ticket, clank and provider. */
export interface UsageRow {
  projectId: string;
  /** Null for chats. */
  ticketId: string | null;
  clankId: string;
  provider: string | null;
  promptTokens: number;
  completionTokens: number;
  ms: number;
  /** Replies counted. */
  calls: number;
}

/** Tickets, their dependencies and bounces, specs and the activity feed, in SQLite. */
export class BoardStore {
  constructor(private readonly db: Db) {}

  /** A project's tickets, in backlog order. */
  tickets(projectId: string): Ticket[] {
    const rows = this.db
      .select()
      .from(ticketTable)
      .where(eq(ticketTable.projectId, projectId))
      .orderBy(asc(ticketTable.rank), asc(ticketTable.number))
      .all();
    const deps = this.dependencies(rows.map((r) => r.id));
    return rows.map((row) => toTicket(row, deps.get(row.id) ?? []));
  }

  ticket(id: string): Ticket | undefined {
    const row = this.db.select().from(ticketTable).where(eq(ticketTable.id, id)).get();
    return row ? toTicket(row, this.dependencies([id]).get(id) ?? []) : undefined;
  }

  byNumber(projectId: string, number: number): Ticket | undefined {
    const row = this.db
      .select()
      .from(ticketTable)
      .where(and(eq(ticketTable.projectId, projectId), eq(ticketTable.number, number)))
      .get();
    return row ? toTicket(row, this.dependencies([row.id]).get(row.id) ?? []) : undefined;
  }

  insertTicket(ticket: Ticket): void {
    const { dependsOn, ...row } = ticket;
    this.db.transaction((tx) => {
      tx.insert(ticketTable).values(row).run();
      for (const id of dependsOn) {
        tx.insert(ticketDependency).values({ ticketId: ticket.id, dependsOn: id }).run();
      }
    });
  }

  updateTicket(id: string, changes: TicketChanges): void {
    this.db.update(ticketTable).set(changes).where(eq(ticketTable.id, id)).run();
  }

  deleteTicket(id: string): void {
    this.db.delete(ticketTable).where(eq(ticketTable.id, id)).run();
  }

  /** The lowest rank in a project, so a new ticket can go first, or the highest to go last. */
  rankBounds(projectId: string): { min: number; max: number } | null {
    const rows = this.db
      .select({ rank: ticketTable.rank })
      .from(ticketTable)
      .where(eq(ticketTable.projectId, projectId))
      .all();
    if (rows.length === 0) return null;
    const ranks = rows.map((r) => r.rank);
    return { min: Math.min(...ranks), max: Math.max(...ranks) };
  }

  addDependency(ticketId: string, dependsOn: string): void {
    this.db.insert(ticketDependency).values({ ticketId, dependsOn }).onConflictDoNothing().run();
  }

  removeDependency(ticketId: string, dependsOn: string): void {
    this.db
      .delete(ticketDependency)
      .where(
        and(eq(ticketDependency.ticketId, ticketId), eq(ticketDependency.dependsOn, dependsOn)),
      )
      .run();
  }

  private dependencies(ids: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (ids.length === 0) return map;
    // In the order the tickets were made, so a ticket's list reads the same every time.
    const rows = this.db
      .select({ ticketId: ticketDependency.ticketId, dependsOn: ticketDependency.dependsOn })
      .from(ticketDependency)
      .innerJoin(ticketTable, eq(ticketTable.id, ticketDependency.dependsOn))
      .where(inArray(ticketDependency.ticketId, ids))
      .orderBy(asc(ticketTable.number))
      .all();
    for (const row of rows)
      map.set(row.ticketId, [...(map.get(row.ticketId) ?? []), row.dependsOn]);
    return map;
  }

  bounces(ticketIds: string[]): Bounce[] {
    if (ticketIds.length === 0) return [];
    return this.db
      .select()
      .from(bounceTable)
      .where(inArray(bounceTable.ticketId, ticketIds))
      .orderBy(asc(bounceTable.at))
      .all();
  }

  addBounce(bounce: Bounce): void {
    this.db.insert(bounceTable).values(bounce).run();
  }

  /** Replies' model use, added up per ticket, clank and provider: in one project, or every one. */
  usage(projectId: string | null, since?: Date): UsageRow[] {
    const where = [sql`m.usage is not null`, sql`c.project_id is not null`];
    if (projectId) where.push(sql`c.project_id = ${projectId}`);
    if (since) where.push(sql`m.created_at >= ${since.getTime()}`);
    return this.db.all<UsageRow>(sql`
      select c.project_id as projectId, c.ticket_id as ticketId, c.clank_id as clankId,
        m.provider as provider,
        coalesce(sum(json_extract(m.usage, '$.promptTokens')), 0) as promptTokens,
        coalesce(sum(json_extract(m.usage, '$.completionTokens')), 0) as completionTokens,
        coalesce(sum(json_extract(m.usage, '$.durationMs')), 0) as ms,
        count(*) as calls
      from message m join conversation c on c.id = m.conversation_id
      where ${sql.join(where, sql` and `)}
      group by c.project_id, c.ticket_id, c.clank_id, m.provider`);
  }

  /** The newest events, oldest first. */
  events(projectId: string, limit: number): BoardEvent[] {
    return this.db
      .select()
      .from(boardEvent)
      .where(eq(boardEvent.projectId, projectId))
      .orderBy(desc(boardEvent.id))
      .limit(limit)
      .all()
      .reverse();
  }

  ticketEvents(ticketId: string): BoardEvent[] {
    return this.db
      .select()
      .from(boardEvent)
      .where(eq(boardEvent.ticketId, ticketId))
      .orderBy(asc(boardEvent.id))
      .all();
  }

  addEvent(event: Omit<BoardEvent, 'id'>): BoardEvent {
    const row = this.db.insert(boardEvent).values(event).returning().get();
    return row;
  }

  /** Every version of a project's spec, oldest first. */
  specs(projectId: string): SpecVersion[] {
    return this.db
      .select()
      .from(specTable)
      .where(eq(specTable.projectId, projectId))
      .orderBy(asc(specTable.version))
      .all();
  }

  spec(projectId: string, version: number): SpecVersion | undefined {
    return this.db
      .select()
      .from(specTable)
      .where(and(eq(specTable.projectId, projectId), eq(specTable.version, version)))
      .get();
  }

  latestVersion(projectId: string): number {
    return (
      this.db
        .select({ last: max(specTable.version) })
        .from(specTable)
        .where(eq(specTable.projectId, projectId))
        .get()?.last ?? 0
    );
  }

  insertSpec(spec: SpecVersion): void {
    this.db.insert(specTable).values(spec).run();
  }

  updateSpec(
    id: string,
    changes: Partial<
      Pick<SpecVersion, 'body' | 'status' | 'ticketId' | 'updatedAt' | 'approvedAt'>
    >,
  ): void {
    this.db.update(specTable).set(changes).where(eq(specTable.id, id)).run();
  }
}
