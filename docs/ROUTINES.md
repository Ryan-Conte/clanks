# Routines

Routines are clanks' scheduler: work that starts at a time, on a repeating schedule or when something happens, and actions that go out at an exact time once you have approved them. "Have Prism make a promo banner on Friday afternoon and Buzz post it on X at 5pm" is one routine. So is "every Monday at 9, Scout summarises last week's competitor pricing", and "when a release tag is pushed, Quill writes the release notes and Buzz drafts the announcement".

This is the full spec. The summary is in the [buildout plan](PLAN.md#routines) and the milestone is in the [roadmap](ROADMAP.md).

## Goals

- Schedule any work the crew can do, once or on repeat, from chat or from an editor.
- Post, send or publish at an exact time, with your approval of the exact content given beforehand.
- Run entirely on your machine, survive restarts and sleep, and never do anything surprising when the app comes back after being off.
- Keep the rules the rest of clanks follows: the normal workflow for the work, the same permissions, and a person approving every outbound action.

Not in the first version: inbound webhooks (nothing on the internet can reach the app), triggers from third-party services, and posting without approving each item (see [Open questions](#open-questions)).

## Concepts

| Term | Meaning |
| --- | --- |
| Routine | A saved definition: a trigger, steps, and rules for approval, timing and missed runs. Belongs to a project. |
| Trigger | What starts a run: a time, a schedule, an event, or you pressing **Run now**. |
| Run | One execution of a routine, for one scheduled time or one event. |
| Ticket step | Creates a ticket for a clank. The ticket goes through the normal workflow: maker, checks, Atlas's sign-off, you. |
| Action step | Calls an integration operation at a set time, such as posting to X, with a payload built from earlier steps' approved outputs. |
| Scheduled action | The frozen, approved form of an action step: exact payload, media, account and time. Executed by the orchestrator, never by a model. |

## Example: a promo banner posted on X at 5pm

You tell Atlas: "Every Friday, have Prism make a promo banner for the weekend sale and post it on X at 5pm."

1. **Atlas proposes a routine.** It starts Fridays at 13:00 (Australia/Sydney): Prism designs the banner, Buzz writes the post, and clanks posts both to @surfshop at 17:00. The card shows the next five Fridays. You set the offer and press **Activate**.
2. **13:00 Friday.** The run starts and creates two tickets: CLK-201 for Prism (design, due 16:00) and CLK-202 for Buzz (campaign, depends on CLK-201, due 16:00).
3. **Prism** designs a 1600×900 frame named `Promo / X` in Studio, from the project's design system. You can watch it on the canvas. Atlas signs it off.
4. **Buzz** writes the post to go with the banner and the offer. Atlas signs it off.
5. **15:20.** One **Ready for you** card shows the post exactly as it will appear, with the banner, the account and "Posts Friday 14 Nov at 17:00 AEDT". You approve, and the action is frozen.
6. **16:30.** Had you not approved yet, a reminder would arrive now.
7. **17:00.** The orchestrator uploads the banner and creates the post through the X integration. No model is involved. The post's link appears on the run and is added to Buzz's memory.
8. **If the computer was asleep** at 17:00 and wakes at 17:20, past the 15-minute grace window, nothing is posted. You get a notification with **Post now** and **Reschedule**.

The same routine as YAML:

```yaml
name: Weekend promo
trigger:
  kind: cron
  cron: "0 13 * * 5"                 # Fridays at 13:00
  time_zone: Australia/Sydney
inputs:
  offer: "20% off all longboards this weekend"
steps:
  - id: banner
    ticket:
      clank: prism
      type: design
      title: "Promo banner: {{inputs.offer}}"
      description: >
        One 1600×900 banner for X announcing "{{inputs.offer}}",
        built from the design system.
      criteria:
        - "One frame named 'Promo / X' at 1600×900, using only design tokens"
        - "The offer is readable when the image is shown at half size"
  - id: copy
    depends_on: [banner]
    ticket:
      clank: buzz
      type: campaign
      title: "X post for {{inputs.offer}}"
      criteria:
        - "One X post under 280 characters that links to /sale"
  - id: publish
    depends_on: [banner, copy]
    action:
      integration: x
      operation: create_post
      connection: "@surfshop"
      at: "17:00"                    # on the run's date, in the routine's time zone
      payload:
        text: "{{steps.copy.output.posts[0].text}}"
        media: ["{{steps.banner.output.frames['Promo / X'].png}}"]
approval:
  remind_before: 30m
timing:
  review_buffer: 1h                  # ticket steps are due an hour before the first action
missed:
  policy: skip
  grace: 15m
concurrency: skip
budget:
  per_run: { tokens: 300000 }
```

## Defining a routine

Routines are stored in SQLite and edited in the app. They export to and import from YAML, which is also how they are shared on the marketplace.

### Triggers

| Kind | Example | Notes |
| --- | --- | --- |
| `once` | `at: 2026-11-14T13:00` | One run, then the routine is marked done. |
| `cron` | `cron: "0 13 * * 5"` | Five-field cron, plus `L` for last (`0 9 L * *`, the last day of the month) and `#` for the nth weekday (`0 9 * * 2#2`, the second Tuesday). |
| `event` | `event: git.tag`, `match: "v*"` | Fires when something happens in clanks or the project's repo. |
| `manual` | | Runs only from **Run now**. Every routine can also be run manually. |

- **Plain language.** You can type "every weekday at 9", "first Monday of the month" or "tomorrow at 5pm". Common phrases are parsed directly and the rest go to Atlas. Either way the editor shows the cron expression and the next five run times, in the routine's time zone, before you can activate it.
- **Time zones.** Every routine has an IANA time zone, defaulting to yours. Times are evaluated in it, so 09:00 stays 09:00 across daylight-saving changes. A time that doesn't exist on a change day (02:30 when clocks jump to 03:00) runs at the next valid minute. A time that happens twice runs once, the first time.
- **Events** in the first version:

  | Event | Fires when | Filters |
  | --- | --- | --- |
  | `spec.approved` | You approve a spec version | |
  | `ticket.done` | A ticket reaches Done | type, clank, label |
  | `pr.merged` | A clanks pull request is merged | label, base branch |
  | `git.tag` | A new tag appears in the project's repo | pattern, such as `v*` |
  | `routine.finished` | Another routine's run finishes | routine, status |

  The event's details are available to steps as `{{event.*}}`, such as `{{event.tag}}`. If the same event fires again while a run for it is still going, the concurrency setting decides what happens.

### Inputs

A routine can declare inputs with defaults, such as the offer above. Scheduled runs use the defaults unless you change them for an upcoming run in the Schedule view. **Run now** asks for them.

### Ticket steps

| Field | Meaning |
| --- | --- |
| `clank` | Who makes it. Must be in the project's crew. |
| `type` | The output type, such as `design`, `campaign`, `research` or `pr`. |
| `title`, `description`, `criteria` | The ticket, with template variables. |
| `depends_on` | Steps whose outputs it needs. They become ticket dependencies. |
| `due` | Optional. Overrides the due time worked out from the actions that depend on it. |

All of a run's tickets are created when the run starts, with their dependencies, so the whole run is visible on the board straight away. Each goes through its normal route: maker, checkers for its type, Atlas, you.

### Action steps

| Field | Meaning |
| --- | --- |
| `integration`, `operation`, `connection` | What to call and with which connected account. The operation must exist in the integration's manifest. |
| `at` | When: a time on the run's date (`"17:00"`), an offset from the run's start (`"+4h"`), or an absolute time. |
| `payload` | The operation's arguments, as templates over earlier steps' outputs. |
| `depends_on` | Steps whose approved outputs the payload uses. |
| `deliver` | `at_time` (default): the orchestrator calls the service at `at`. `hand_off`: when the operation supports scheduling on the service's side, the approved action is sent straight away with `at` as its publish time. |

### Templates

Ticket fields and payloads can use `{{inputs.*}}`, `{{run.date}}`, `{{run.started_at}}`, `{{routine.name}}`, `{{event.*}}` and `{{steps.<id>.output.*}}`. Design outputs expose frames by name with their exports, such as `{{steps.banner.output.frames['Promo / X'].png}}`.

- Values come only from approved outputs, and only from steps listed in `depends_on`. The editor rejects anything else.
- Templates are substitution only. There are no expressions or code.

### Timing

- The trigger is when work starts. An action's `at` is when something goes out.
- Each ticket step gets a **due** time: the earliest action that depends on it, minus the review buffer (default 1 hour). Clanks see it in their run context, such as "Due 16:00, so it can be reviewed before the 17:00 post", and the board shows it on the card.
- The editor estimates how long the steps take, from this routine's past runs or a default for new ones, and warns when the gap between the start and the first action looks too short.
- An action whose dependencies aren't done and approved by its time doesn't happen. It follows the missed rules below.

## Approvals

The rule doesn't change: a person approves every outbound action. Routines let you give that approval ahead of time.

- When Atlas has signed off a run's tickets, the run shows one **Ready for you** card with everything that will go out: each post rendered as it will appear, its media, the account and the time. Approve the actions together or one by one.
- Approving freezes each scheduled action: the exact payload, the media files by checksum, the connection and the time. At execution the orchestrator checks the hashes. If anything differs, the action doesn't run.
- Changing anything after approval (text, image, account or time) cancels that approval and asks again.
- In the Schedule view you can approve a queue at once, such as a week of posts. Each one is still shown in full.
- Reminders: a notification when the card is ready, and again `remind_before` the first action (default 30 minutes) if it is still waiting.
- Not approved by its time: the action is marked **missed** and never goes out. The notification offers **Post now** and **Reschedule**.
- Integration operations with risk `write` (such as uploading a draft) follow the integration's normal policy; only `outbound` ones become scheduled actions.

## Executing scheduled actions

- **Who.** The orchestrator, not a clank. No model is involved at execution, so nothing a model reads can change what goes out.
- **When.** At the approved time, within the grace window (default 15 minutes).
- **Exactly once.** Before calling the service, the action is marked `executing` with an attempt id. Transient failures (network errors, 5xx responses, rate limits) are retried with backoff inside the grace window. Client errors (4xx) are not retried: the action fails and you are notified with the service's message.
- **Unknown outcome.** If the app stops mid-call, the outcome is unknown. If the integration's manifest declares a `verify` operation (such as listing recent posts), the orchestrator uses it on restart to see whether the action happened. Otherwise the action is marked **unknown** and you decide, rather than risk posting twice.
- **Results.** The service's response, such as the post's URL, is stored on the run, shown on the card and added to the memory of the clank that made the content.
- **Hand-off.** With `deliver: hand_off`, the approved action is sent right after approval with its publish time, so it goes out even if your computer is off at that time. The service owns the timing from then on. clanks records the service's scheduled id and can cancel it while the time is still in the future.

## When the app isn't running

Routines run inside the app, so the app has to be running and awake at run and action times.

- **Tray.** Closing the window keeps clanks running in the tray. The tray menu lists the next runs and actions, and has a **Pause routines** switch.
- **Launch at login.** Offered when you activate your first routine.
- **Launch for runs (optional).** clanks registers a small OS task that starts the app a few minutes before the next run or action if it isn't running: a launchd agent on macOS, a Task Scheduler task on Windows, a systemd user timer on Linux. It always points at the next upcoming time and is removed when no routines are active. It only starts the app; it holds no credentials.
- **Sleep.** Windows' Task Scheduler can wake the computer for that task. macOS and Linux can't without admin rights, so the editor says plainly that runs need the computer awake there.
- **Keep awake.** While a run is working, or an action is due within its window, clanks holds a power-save blocker so the system doesn't sleep. This can be turned off in Settings.
- **Coming back.** On start-up and on resume from sleep, the scheduler works out everything that came due while it wasn't running and applies the routine's missed policy:

  | Policy | Ticket work | Actions |
  | --- | --- | --- |
  | `skip` | Not started; recorded as missed | Not sent; recorded as missed |
  | `run_late` | Started now, once, however many runs were missed | Sent now if still inside the grace window, otherwise missed |
  | `ask` | A notification lists what was missed, with **Run now** and **Skip** | The same |

  The default is `run_late` for routines with only ticket steps and `skip` for routines with actions. Whatever the policy, an action never goes out after its grace window on its own: a "good morning" post doesn't go out at 3pm.

## Concurrency, budgets and limits

- `concurrency`: `skip` (default; if the previous run is still going, this one is skipped and recorded), `queue` (starts when the previous run finishes) or `parallel`.
- Budgets per run and per month, in tokens, time or money. A run that hits its budget pauses like any ticket. A routine that hits its monthly budget pauses until you raise the budget or the month turns over.
- Routine tickets count toward project and clank budgets and share the scheduler's limits per clank and per loaded model, at normal priority unless you raise it, so a routine can't starve your other work.
- A routine whose runs fail three times in a row is paused, and you are notified.

## Creating routines

- **From chat.** Ask Atlas. It asks for anything it needs (the offer, the account, until when), then calls `routine_propose`, which shows the routine in chat as an editable card: the trigger in words and as cron, the next five times, the steps with their due times, and the approval and missed-run rules. Nothing is scheduled until you press **Activate**.
- **From a campaign.** An approved Buzz campaign has a **Schedule** button. Each post with a time, an account and an approved visual becomes a scheduled action, all approved together. Buzz can also draft recurring routines with `routine_propose`.
- **In the editor.** Routines → New routine: trigger, inputs, steps as a small flow, approvals, timing, missed runs and budget, with a preview of the next runs and each step's due time.
- **From the marketplace.** Routine templates, such as "weekly competitor digest" or "release notes and announcement", install as inactive drafts. You pick the clanks, connections and times, then activate.

## In the app

- **Routines tab** in each project: every routine's name, its trigger in words, the next run, the last result and an on/off switch, with **Run now**, **Pause**, **Duplicate** and **Export**.
- **Schedule view**: a calendar of upcoming runs and scheduled actions across the project, including campaign posts. Drag an unapproved action to change its time; moving an approved one asks for approval again.
- **Run history**: each run with its tickets, approvals, actions, results and cost, and the reason anything was skipped or missed.
- **Board**: tickets from routines show the routine's name and their due time.
- **Notifications**: OS notifications for cards ready to approve, reminders, missed or failed actions and paused routines. A notification opens the card. Nothing can be approved from the notification itself.

## Data model

- **routine**: id, project, name, description, trigger (kind, cron or time, time zone, event and filters), inputs, steps, approval reminder, review buffer, missed policy, grace window, concurrency, budget, status (`draft`, `active`, `paused`, `done`), created by, next run at, last run at.
- **routine_run**: id, routine, scheduled for, trigger detail (time or event payload), inputs used, status (`scheduled`, `working`, `awaiting_approval`, `approved`, `done`, `skipped`, `missed`, `failed`, `cancelled`), tickets, cost, started and ended.
- **scheduled_action**: id, routine run or campaign ticket, connection, operation, payload, payload hash, media hashes, execute at, grace window, delivery (`at_time`, `hand_off`), status (`pending_approval`, `approved`, `executing`, `done`, `failed`, `unknown`, `missed`, `cancelled`), approved by and at, attempts, result.

Everything a routine does is also written to the append-only event log, like the rest of clanks.

## Tools for clanks

| Tool | Who | What |
| --- | --- | --- |
| `routine_list` | Atlas, Buzz | The project's routines and their next runs |
| `routine_get` | Atlas, Buzz | One routine's definition and recent runs |
| `routine_propose` | Atlas, Buzz | Drafts a new routine, or a change to an existing one, as an editable card. Never activates anything. |

No clank can activate, edit, run or delete a routine, and no clank can approve or execute a scheduled action. Tickets created by a run get extra run context: the routine's name, the run's date and inputs, and their due time.

## Security

- Routines are created, changed and activated only in the UI. `routine_propose` only drafts, so content a clank reads can't create or change a routine.
- Ticket steps run with the same clanks, permissions and workflow as any other ticket. A routine can't give a clank extra tools.
- Scheduled actions run only frozen, approved payloads, checked by hash at execution, and only inside their grace window.
- Templates take values only from approved outputs of the steps an action depends on.
- The OS launch task starts the app and nothing else.

## Failure handling

| What happens | Result |
| --- | --- |
| App closed or computer asleep at run time | The missed policy, applied on start-up or resume |
| A ticket step fails, or is still in review, at its action's time | The action is missed; notification with **Post now** and **Reschedule** |
| Not approved by the action's time | Missed; never sent |
| Transient service error | Retried with backoff inside the grace window |
| Permanent service error (4xx) | The action fails; the service's message is shown |
| App stopped mid-call | Checked with the integration's `verify` operation, or marked unknown for you to decide |
| Connection expired or revoked | The action fails; notification to reconnect |
| Clock or time zone changed | Schedules recomputed; nothing runs twice for the same scheduled time |
| Three failed runs in a row | The routine is paused |

## Testing

- Trigger evaluation against a fake clock: cron with time zones, daylight-saving gaps and overlaps, `L` and `#`, `once`, and events.
- Missed-run handling with simulated sleep, shutdown and clock jumps.
- Scheduled actions against a mock integration: hash checks, grace windows, retries, unknown outcomes and `verify`.
- Template validation and dependency checks in the editor.
- The promo banner routine end to end, with the fake provider and a mock X integration.

## Open questions

- **Posting without per-item approval.** Whether a routine should ever post without each item being approved, such as "post the weekly tip every Monday, approved once". The current rule says no.
- **X API access.** Posting needs your own X developer app and is subject to X's API tiers and rate limits. Decide whether an X integration ships bundled or only on the marketplace, and whether a social scheduler integration is a better default for hand-off.
- **Third-party triggers.** Polling services for events (a new order, a new review) to start routines, and how often.
- **Waking from sleep** on macOS and Linux without admin rights.
