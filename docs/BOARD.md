# The live board

The board is where you watch the crew work. Every ticket is on it, along with the clank that has it, what that clank is doing right now, and what's waiting for you. It's live: cards move as work moves, a feed narrates what happens, and any card opens the work itself in the workbench. Home gives the same view across all your projects.

This is the full spec. The summary is in the [buildout plan](PLAN.md#the-board), and the milestones are in the [roadmap](ROADMAP.md).

## At a glance

```
┌─ clanks · Surf shop · board ──────────────────────────────────── ● 3 clanks working · 2 need you ─┐
│ Atlas ● CLK-106   Forge ×2 ● CLK-104 CLK-105   Gauge ● CLK-103   Prism ○   Quill ○   Buzz ○       │
├────────────────────────┬────────────────────────┬────────────────────────┬────────────────────────┤
│ Backlog              3 │ Build                2 │ QA + review          2 │ Ready for you        1 │
│ ┌────────────────────┐ │ ┌────────────────────┐ │ ┌────────────────────┐ │ ┌────────────────────┐ │
│ │ CLK-102         PR │ │ │ CLK-104         PR │ │ │ CLK-103         PR │ │ │ CLK-101         PR │ │
│ │ Board finder quiz  │ │ │ AU shipping rates  │ │ │ Stripe checkout    │ │ │ Storefront+catalog │ │
│ │ ○ waits on CLK-106 │ │ │ ● Forge  3/5 steps │ │ │ ● Gauge            │ │ │ ✓ Atlas signed off │ │
│ └────────────────────┘ │ │ Running npm test   │ │ │ Checking AC-4.2    │ │ │ PR #12 · CI ✓      │ │
│ ┌────────────────────┐ │ └────────────────────┘ │ └────────────────────┘ │ └────────────────────┘ │
│ │ CLK-107       Copy │ │ ┌────────────────────┐ │ ┌────────────────────┐ │                        │
│ │ Product page copy  │ │ │ CLK-105         PR │ │ │ CLK-106     Design │ │                        │
│ │ ○ Quill · next     │ │ │ Order emails       │ │ │ Quiz wireframes    │ │                        │
│ └────────────────────┘ │ │ ● Forge  ↩1        │ │ │ ● Atlas            │ │                        │
│ +1 more                │ │ Editing email.ts   │ │ │ Signing off        │ │                        │
│                        │ └────────────────────┘ │ └────────────────────┘ │                        │
├────────────────────────┴────────────────────────┴────────────────────────┴────────────────────────┤
│ 14:02  Gauge › bounced CLK-105 to Forge: AC-2.1 failed                                            │
│ 14:05  Forge › opened PR #13 for CLK-104                                                          │
│ 14:06  Atlas › signed off CLK-101, ready for you                                                  │
│ 14:07  Prism › attached wireframes to CLK-106                                                     │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

From top to bottom: the header with the live indicator and **Needs you**, the crew strip, the columns, and the activity feed.

## Layout

- **Header.** The project's name; **● 3 clanks working**, the number of clanks with at least one active run (hover to list the runs); **Needs you** with a count; the project's budget meter; a view switcher (**Columns**, **By clank**, **Schedule**); filters by clank, type, story, routine and label; and search.
- **Crew strip.** One avatar per clank in the project, showing its status and the tickets it's on right now. Parallel runs show as a count, such as **Forge ×2**. Clicking an avatar filters the board to that clank; dropping a card on it reassigns the card.
- **Columns.** Backlog, Build, QA + review, Ready for you, and Done, collapsed at the right edge with its count.
- **Activity feed.** Along the bottom, collapsible, or docked on the right. See [Activity feed](#activity-feed).

## Columns

| Column | Holds | Order |
| --- | --- | --- |
| Backlog | Tickets waiting on dependencies, a free slot or a model, and open tickets waiting for a free clank that makes their type | Ready to start first, then by priority. Blocked cards say what they wait on. |
| Build | Tickets whose maker is working: Scribe, Prism, Forge, Quill, Buzz, Scout or a custom maker | Active runs first |
| QA + review | Tickets with their checkers (Gauge, custom checkers) or with Atlas for sign-off | By route position, then age |
| Ready for you | Tickets Atlas has signed off | Oldest first |
| Done | Approved, merged or sent in the last 7 days | Newest first; older tickets are archived and searchable |

Columns come from the ticket state machine in `packages/core`. The board never moves a ticket itself; it shows what the workflow engine did.

## Cards

```
┌────────────────────┐
│ CLK-104         PR │   key and type badge
│ AU shipping rates  │   title
│ ● Forge  3/5 steps │   assignee, status and progress
│ Running npm test   │   live line
└────────────────────┘
```

| Part | Shows |
| --- | --- |
| Key and type badge | `CLK-104` and PR, Design, Copy, Doc, Email, Spec, Research or Campaign |
| Title | The ticket's title |
| Assignee and status | The clank on it now and its status (below). Open tickets say which kind of clank will pick them up. |
| Progress | Steps done out of the plan the clank posted with `post_progress`, or the elapsed time if it posted none |
| Live line | What the clank is doing this moment (below) |
| Badges | Bounces (`↩1`); skipped checks, with the reason on hover; the routine's name and due time; PR number and CI status; story ids; a "needs you" marker when an approval or question is waiting |
| Route | On hover, the ticket's route as dots (Forge → Gauge → Atlas → you) with the current stage lit and any bounces drawn as arrows back |

### Status

Status always has an icon and words, never colour alone.

| Status | Icon | Card says |
| --- | --- | --- |
| Working | ● (pulses) | The live line |
| Waiting for a model | ◐ | "Waiting for model" and its place in the queue |
| Needs you | ! | "Approve `pnpm install`?" or "Question for you" |
| Waiting on dependencies | ○ | "Waits on CLK-106" |
| Paused | ‖ | "Paused" or "Paused: budget" |
| Failed | ✕ | "Failed:" and the reason |
| Open | ○ | "Open: next free `pr` maker" |
| Idle between stages | ○ | The next clank in its route, such as "Next: Gauge" |

### Live line

The live line comes from the run's latest tool call. Every tool declares a short live label in the tool registry:

| Tool | Live line |
| --- | --- |
| `shell_exec`, `shell_start` | Running `npm test` |
| `fs_edit`, `fs_write` | Editing `src/email.ts` |
| `fs_read`, `fs_search` | Reading `src/cart.ts`, Searching for "shipping" |
| `browser_navigate`, `web_fetch` | Reading stripe.com/docs/checkout |
| `browser_click`, `browser_type` | Clicking "Pay" on localhost:5173 |
| `design_create`, `design_update` | Designing `Promo / X` |
| `review_pass`, `ticket_bounce` | Passing CLK-103, Bouncing CLK-103 to Forge |
| Model turn | Thinking, with tokens per second on the built-in runtime |

- Updates are throttled to one a second per card.
- Commands are cut to their first words, URLs to host and path. Query strings, arguments that look like secrets and anything the redaction rules catch are never shown.
- Integration tools use their operation's summary, such as "Posting to X".

## Live updates

- The board is a projection of the append-only event log. The orchestrator keeps a small materialized `run_status` per active run (state, waiting reason, live label, progress) and pushes changes to the window over a tRPC subscription. The renderer applies them to its store.
- Updates are batched to at most ten a second. A card that changes column slides across (about 200ms). A bounce slides back and shows its reason on the card for a few seconds. New tickets fade in. With reduced motion turned on there's no movement, just a brief highlight.
- Reopening the app or reloading the window rebuilds the board from SQLite and then resubscribes, so nothing is lost.
- Targets: 500 tickets and 20 concurrent runs on one board, with under 100ms from event to screen. Columns are virtualized.

## Activity feed

The feed is the crew's running commentary: one line per meaningful event, not every tool call.

| Event | Line |
| --- | --- |
| Tickets created from a spec | Atlas › spec v2 approved, created 7 tickets |
| Assigned | Atlas › assigned CLK-107 to Quill |
| Run started | Forge › started CLK-104 |
| Output submitted | Quill › submitted CLK-107 |
| PR opened | Forge › opened PR #12 for CLK-101 |
| Check passed | Gauge › CLK-101 passed 8/8 acceptance criteria |
| Bounced | Gauge › bounced CLK-103 to Forge: AC-4 failed |
| Signed off | Atlas › signed off CLK-101, ready for you |
| Design attached | Prism › attached wireframes to CLK-106 |
| Project note added | Forge › noted for the crew: cart state lives in Zustand |
| Waiting on you | Forge › asked to run `pnpm install` on CLK-104 |
| Looping | CLK-103 bounced 3 times and came to you |
| Scheduled action | clanks › posted to X for Weekend promo |
| Your actions | You › approved CLK-101, You › merged PR #12, You › moved CLK-102 to the top |

- Clicking a line opens that ticket at that moment in its activity timeline.
- Filter by clank, ticket or kind of event. Scrolling pauses while you hover; **Jump to now** resumes it.
- The feed is the same event log the rest of the app uses, so it's complete after a restart.

## Working with the board

- **Hover** a card for a peek: its last five steps and a thumbnail of the work (diff stats, the page in the browser, the frame in Studio).
- **Click** a card to open the ticket drawer: stories, acceptance criteria, route and bounce history, outputs, the linked chat, cost and time.
- **Watch** opens the run's workbench in follow mode: the diff editor follows the file being edited, the browser follows the clank's tab, Studio follows its canvas.
- **Drag**:
  - within Backlog to set priority;
  - onto a crew avatar to reassign;
  - from Backlog to Build to start a ticket now, if its dependencies are done and a slot is free;
  - from Build back to Backlog to stop a run (after you confirm; the work so far stays on its branch);
  - onto Ready for you or Done is not possible. Approving always opens the approval card, so nothing is merged or sent by a drag.
- **Card menu**: Pause, Resume, Stop, Retry, Reassign, Make open, Skip an optional check, Priority, Chat about this ticket, Copy link.
- **Add a card** with **+** in Backlog: a title, a type, and an assignee or **Open**. It doesn't need a spec story. Atlas can fill in criteria if you ask.
- **Keyboard**: arrows move between cards, Enter opens, W watches, / searches.

Every drag and menu action is sent to the orchestrator as a command, and the state machine accepts or refuses it, so the board can't put a ticket in a state the workflow doesn't allow.

## By clank

The **By clank** view swaps columns for one lane per clank: what it's working on now with the live line, its queue, and what it finished today. Parallel runs get their own rows (Forge 1, Forge 2). It's the quickest way to see what each bot is doing and who is overloaded or idle.

## Needs you

**Needs you** collects everything waiting on you in this project, oldest first:

- tickets in Ready for you;
- tool calls waiting for approval;
- questions from `ask_user`;
- routine runs and scheduled actions waiting for approval;
- tickets that looped and came to you;
- failed runs.

Each item opens its card or prompt. The same count shows on the tray icon and on Home.

## Home

Home is the overview across every project, and the first thing you see when the app opens.

- **Needs you**: everything waiting on you, across projects.
- **Working now**: every active run, with its clank, project, ticket, live line, elapsed time and model.
- **Coming up**: routine runs and scheduled actions in the next 24 hours.
- **Machine**: loaded models, parallel slots in use, memory, tokens per second, and runs waiting for a model.
- **Today**: tokens, time and cloud spend by project.
- **Projects**: each with its column counts and how many clanks are working.

The tray popover is the smallest version: "● 3 clanks working · 2 need you", the next scheduled item, and **Pause routines**.

## Data

- The board reads `ticket`, `run`, `bounce`, `approval` and `scheduled_action`, plus **run_status**: run, state, waiting reason, live label, progress steps, updated at. The orchestrator updates `run_status` as events arrive; it is never edited directly.
- Tools declare a `live_label` template in the registry, with redaction rules.
- `post_progress` takes a `message` and optional `steps` (each a title and whether it's done), which the card shows as progress.
- View preferences per project (view, grouping, filters, where the feed is docked) are stored locally.

## Accessibility

- Every status has an icon and words. The palette is checked for colour-blind contrast.
- Reduced motion replaces movement with highlights.
- Everything works from the keyboard.
- The feed is a polite live region for screen readers, announcing only needs-you events and changes to the card in focus.

## Demo mode

A recorded project can be replayed onto the board at any speed. It's used for tests, for the first-run tour, and to record the board on the landing page.

## Testing

- Projection tests: event sequences to board state, including bounces, route restarts, crashes and resumes.
- Live label redaction tests.
- A performance test replaying 500 tickets and 20 concurrent runs.
- Playwright tests that replay the surf shop project and check cards move as expected, and that drags the state machine refuses are refused.

## Open questions

- How long Done keeps tickets before archiving (7 days is the starting point).
- Whether to allow several boards side by side, one per window.
