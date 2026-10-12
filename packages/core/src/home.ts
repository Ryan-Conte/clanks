import type { NeedsYouItem, RunRole, Usage } from './board';
import type { ClankId } from './crew';
import type { ModelChoice } from './providers';

/** A clank writing a reply right now: in a ticket's run, or in a chat in a project. */
export interface WorkingRun {
  conversationId: string;
  projectId: string;
  projectName: string;
  ticketId: string | null;
  /** `SURF-3`, for a run on a ticket. */
  key: string | null;
  title: string;
  clankId: ClankId;
  /** Null for a chat. */
  role: RunRole | null;
  /** What it's doing this moment: "Running `npm test`". */
  label: string;
  asking: boolean;
  since: Date;
  model: ModelChoice | null;
}

/** A ticket whose turn has come, waiting for a free slot, clank or model. */
export interface UpNext {
  projectId: string;
  projectName: string;
  ticketId: string;
  key: string;
  title: string;
  /** Why it waits: "Waiting for a free slot on gemma4:26b". */
  reason: string;
}

/** What one project spent today. */
export interface DayUsage {
  projectId: string;
  projectName: string;
  usage: Usage;
}

/** Home: what needs the user and what the crew is doing, across every project. */
export interface HomeSnapshot {
  needsYou: (NeedsYouItem & { projectName: string })[];
  working: WorkingRun[];
  upNext: UpNext[];
  today: DayUsage[];
}
