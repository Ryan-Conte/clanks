# Buildout plan

This is the technical plan for clanks: what the pieces are, how they talk to each other, and the order to build them in. The [roadmap](ROADMAP.md) is the user-facing view of the same work. The priming docs the clanks run on are in [crew/](../crew/README.md).

## Principles

- **Everything runs on your machine.** One Electron app holds the UI, the orchestrator, the model runtime, the workspaces, the diff editor, the browser and the design tool. It pulls and hosts its own models, so after the first download it works fully offline. No clanks account, no clanks server.
- **Local models by default, cloud optional.** A clank can use a cloud model if you add a key. Keys live in the OS keychain and go straight to that provider.
- **Watch everything.** Every file a clank changes shows up in the diff editor, every page it opens in the browser pane, every command in the terminal and every design change in Studio, as it happens. The live board shows every clank's status at a glance. You can step in at any point.
- **Chat first, board second.** Every action is reachable from chat. The board is a live view of shared state, not a separate workflow.
- **A real team, not a swarm.** Work moves through stages in order (Spec, Design, Build, QA, Sign-off), and each clank can push back on what it was handed, with a reason that stays on the ticket.
- **Human in the loop by default.** You approve the spec before anything is built, and every ticket ends with you. Merges, emails, posts and spend over budget wait for your approval. Pushing a branch and opening a pull request on a repo you connected is part of building; merging stays yours. Approval can be given ahead of time for a post or send scheduled for later, but always for its exact content, account and time. Clanks have no tools for any of these; the orchestrator does them.
- **Everything is logged.** Every model call and tool call is recorded with inputs, outputs, tokens, time and cost, and is visible on the ticket.
- **Free to share.** Clanks, integrations and crews people build can be published to a free marketplace and installed by anyone, with no account and nothing hidden: you see every prompt and permission before you install.
- **One language.** TypeScript across the app, orchestrator, tools and design engine, so types are shared end to end. Native code comes only from prebuilt dependencies (llama.cpp, SQLite, node-pty).

## Architecture

```
┌──────────────────────────────── clanks desktop app (Electron) ────────────────────────────────┐
│                                                                                               │
│  App window                               Main process (Node)                                 │
│  ┌──────────────────────────┐  typed IPC  ┌───────────────────────────────────────────────┐   │
│  │ Chat                     │◄───────────►│ Orchestrator                                  │   │
│  │ Home + live board        │             │  ├─ Conversation service + planner (Atlas)    │   │
│  │ Routines                 │             │  ├─ Conversation service + planner (Atlas)    │   │
│  │ Studio (design tool)     │             │  ├─ Scheduler + workflow: stages, bounces     │   │
│  │ Workbench                │             │  ├─ Agent runtime + crew priming docs         │   │
│  │  ├─ Diff editor          │             │  ├─ Tools: built-ins, MCP, integrations       │   │
│  │  ├─ Terminal             │             │  ├─ Workspaces: worktrees, checkpoints        │   │
│  │  ├─ Activity             │     CDP     │  ├─ Design engine: scene ops, tokens, lint    │   │
│  │  └─ Browser pane ◄───────┼─────────────┤  ├─ Browser controller                        │   │
│  │ Models                   │             │  ├─ Provider registry                         │   │
│  │ Settings                 │             │  ├─ Model manager: catalog, pulls, store      │   │
│  └──────────────────────────┘             │  └─ Store (SQLite) + memory + keychain        │   │
│                                           └──────────┬───────────────────────┬────────────┘   │
│                                                      │ HTTP on 127.0.0.1     │ pty or         │
│                                                      ▼                       ▼ docker exec    │
│                                           ┌──────────────────────┐  ┌──────────────────────┐  │
│                                           │ llama-server         │  │ Commands             │  │
│                                           │ one per loaded model │  │ host or Docker       │  │
│                                           └──────────────────────┘  └──────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
   Optional, outbound only: models, marketplace, cloud models, third-party APIs, GitHub, SMTP
```

- The **app window** is a React renderer (chat, board, Studio, workbench panes, models, settings) plus the browser pane, which is a set of Electron `WebContentsView`s laid over the workbench. Neither holds keys or calls a model.
- The **orchestrator** owns all state and all model traffic, in the main process. Heavy work (hashing downloads, computing diffs, rendering design frames, parsing large tool output) runs in worker threads or offscreen views so the window stays responsive. Its API is a tRPC router, so it can later be served over HTTP too.
- **Every clank's agent loop runs in the orchestrator**, chat clanks and ticket workers alike. Isolation comes from the workspace (one git worktree per run), the permission policy and, optionally, Docker for shell commands. There is no separate worker program and no worker API.
- **Models** run in `llama-server` child processes managed by the model manager, or at a cloud provider. Either way the orchestrator is the only thing that talks to them.
- **Closing the window** leaves clanks in the tray, so running tickets and loaded models carry on. Quitting from the tray stops everything. Both are configurable.

### App data

`<app data>` is `%LOCALAPPDATA%\clanks` on Windows (local, not roaming, since it holds models), `~/Library/Application Support/clanks` on macOS and `~/.config/clanks` on Linux. Running from source uses `clanks-dev` instead, and `CLANKS_DATA_DIR` overrides both.

```
<app data>/
  clanks.db                   SQLite: everything in the data model below
  secrets.json                API keys and tokens, encrypted by the OS keychain; never in the database
  models/blobs/               GGUF files, named sha256-<digest>; which model uses which is in clanks.db
  models/partial/             downloads in progress, one folder per pull
  models/links/               the shards of split models, linked under their original names
  runtime/                    llama.cpp builds downloaded for your GPU (CUDA), and running servers' PIDs
  worktrees/<repo>/<key>/     one git worktree per run: a ticket's, or a chat's about a folder
  checkpoints/<run>.git       a shadow git directory per run, for its checkpoints
  artifacts/<ticket>/         notes, documents, email drafts, screenshots
  crew/                       your clank library: edited priming docs (<id>.md) and custom clanks
  browser/                    persistent browser sessions, only when enabled
  chromium/                   the app window's own Chromium caches and storage
  logs/
```

The models folder can be moved to another drive in Settings.

## Repository layout

pnpm workspaces with Turborepo.

```
apps/
  desktop/            Electron app: main process bootstrap, preload, renderer, browser and offscreen views
packages/
  core/               Shared types, zod schemas, ticket state machine, event types
  orchestrator/       Conversation service, planner, scheduler, agent runtime, prompt assembly, store
  models/             Model manager: catalog, pulls, blob store, hardware probe, llama-server supervisor, local API
  providers/          Provider interface and adapters
  tools/              Built-in tools, permission policy, MCP client
  integrations/       Integration runtime: manifest schema, OpenAPI to tools, connections, auth, redaction
  marketplace/        Marketplace client: index, install, verify, update, publish
  routines/           Triggers, cron and time zones, runs, scheduled actions, OS launch helpers
  workspace/          Worktrees, checkpoints, diffs, command execution (host and Docker)
  browser/            Browser controller over CDP, page snapshots for the browser tools
  design/             Design file format and schema, scene operations, tokens, markup parser, lint, exporters
  studio/             Studio editor UI: canvas, panels, prototype player, visual diff
  ui/                 Shared React components: chat, board, diff editor, terminal, activity
crew/                 Priming docs for the premade clanks, the custom-clank template and examples, bundled into the app
integrations/         First-party declarative integrations, bundled into the app
scripts/              Build scripts, including fetching pinned llama.cpp builds per platform and backend
docs/
```

## Key decisions

| Area | Choice | Why |
| --- | --- | --- |
| Desktop shell | Electron | Cross-platform, Node in the main process so the orchestrator and app share one runtime, and a full Chromium we can reuse for the browser pane and the Studio renderer. Tauri was considered; it would split the orchestrator into Rust or a sidecar and has no embeddable Chromium on every platform. |
| UI | React, Vite, Tailwind, TanStack Query, dnd-kit for the board | Matches the landing page stack and the ecosystem for chat and kanban UIs. |
| Local inference | llama.cpp `llama-server`, bundled, one supervised child process per loaded model | Runs GGUF models on Metal, CUDA, Vulkan or CPU; speaks an OpenAI-compatible API with tool calling and grammars; parallel slots let several clanks share one loaded model. A child process means a native crash can't take the app down. In-process bindings (node-llama-cpp) were considered for that reason. |
| Model format and source | GGUF from Hugging Face, plus a curated catalog | GGUF is what llama.cpp loads, comes pre-quantised and carries no executable code. Almost every open model is published in it. |
| Storage | SQLite via better-sqlite3 + Drizzle | Single local file, fast, easy backups, typed schema and migrations. better-sqlite3 ships N-API binaries that load in Node and Electron alike, so nothing is compiled or rebuilt for Electron. |
| Context and memory | A project context shared by the crew and a private memory per clank, in SQLite with FTS5 full-text search | Every clank knows the project's facts and decisions, each can answer "why did you do that?" from its own record, and it all works offline with no extra service. Embeddings from the local runtime can be added later. |
| Secrets | OS keychain through Electron `safeStorage`: values are encrypted with a key the keychain holds (Keychain, DPAPI, libsecret or KWallet) and kept in their own file | Keys never touch the database or plain-text config. keytar was the planned fallback, but it's archived and needs the same Linux keyring, so there is none: without a keyring, clanks refuses to save secrets rather than keep them in plain text. Local models need no keys. |
| IPC | tRPC over Electron IPC, through a small adapter of our own (queries, mutations and subscriptions) | End-to-end types between renderer and orchestrator; the same router can serve the local API later. electron-trpc was the plan, but it and its forks target tRPC v10 and are unmaintained. |
| Models | Own thin provider interface. Anthropic through its official SDK; everything that speaks the OpenAI API (the built-in runtime, OpenAI, Google's compatibility endpoint, OpenRouter, external servers) through one small streaming client | Keeps streaming, tool calls and usage reporting consistent without locking into a framework. One client covers the OpenAI-style providers' small differences (reasoning fields, how a reply's length is capped) in a few flags. |
| Tools | Built-ins plus MCP | MCP gives access to the existing tool ecosystem with no custom glue. |
| Integrations | Declarative manifests over OpenAPI, plus MCP servers | Most third-party APIs are already described by OpenAPI, so an integration can be data: no code to review or sandbox, with hosts and risks declared up front. MCP covers the rest and reuses an existing ecosystem. |
| Routines | Own scheduler persisted in SQLite, cron with IANA time zones (croner), OS launch agents | Runs offline with no external scheduler, survives restarts and sleep, and can start the app before a run if it's closed. |
| Marketplace | A public GitHub repo with a static index; publishing is a pull request | Free to run and to use, no clanks server or account, review happens in the open, and anyone can host another index in the same format. |
| Workspaces | A git worktree per run; checkpoints in a shadow git directory | Parallel clanks never collide, every change is a diff, and rewinding never touches your repo's history. |
| Diff editor | Monaco diff editor | VS Code's editor: side-by-side and inline diffs, an editable right-hand side, syntax highlighting for every language users will hit. CodeMirror 6's merge view was considered; lighter but less familiar. |
| Browser | Electron `WebContentsView`, driven over CDP through `webContents.debugger` | Reuses the Chromium already in the app; what the clank sees is exactly what you see, and there's no second browser to download. Playwright was considered; it would run a browser outside the app window. |
| Terminal | node-pty + xterm.js | Real PTYs so commands behave as in a normal terminal; xterm.js is the standard renderer. |
| Design tool | Own editor (`packages/design`, `packages/studio`) over a JSON scene graph, rendered as DOM and CSS | Designs must be readable and writable as text by small models, diffable in git, and buildable as web code without translation. Penpot is open source but needs its own server stack to embed. Canvas renderers (Konva, PixiJS) would need their own layout and text engines and wouldn't match the browser. |
| Design tokens | W3C Design Tokens Community Group format | A standard, tool-neutral JSON format with aliases and types; exports cleanly to CSS and Tailwind. |
| Command sandbox | Host process by default, Docker optional | Works with nothing else installed; Docker adds isolation for unattended runs when it's available. |
| Exports | Electron `printToPDF`, the `docx` library | PDF and DOCX without bundling pandoc. |
| Validation | zod everywhere at boundaries | Model output, IPC payloads, tool arguments and design markup are all untrusted input. |

## Data model

Stored in SQLite. Simplified:

- **provider**: id, kind (`openai_compatible`), name, base URL, keychain reference. The model servers you added; the built-in runtime is always there, and a cloud provider (Anthropic, OpenAI, Google, OpenRouter) is on when its key is in the keychain.
- **model**: id, name and tag, source (`catalog`, `huggingface`, `ollama`), repo and file, blob digest, size, quantisation, context length, capabilities (tools, vision), licence, pulled at, keep-loaded flag.
- **clank**: id, name, avatar (a colour from the clanks.si palette), role, kind (maker or checker), workflow placement (stage, after, applies to, bounce to), priming doc (bundled, edited, custom or from the marketplace), default model, tool policy, budget. Custom clanks live in the library and can join any project.
- **integration**: id, kind (`declarative`, `mcp`), source (bundled or a marketplace package), version, enabled.
- **connection**: id, integration, label, auth type, keychain reference, mode (`test`, `live`), scopes, connected at.
- **project_integration**: project, connection, clanks allowed to use it.
- **routine**, **routine_run**, **scheduled_action**: schedules, their runs, and approved actions waiting for their time. Fields are in [ROUTINES.md](ROUTINES.md#data-model).
- **package**: id, kind (`clank`, `integration`, `crew`, `routine`), index, version, sha256, publisher, licence, pinned, installed at, status (`active`, `update_available`, `revoked`).
- **conversation**: id, clank, title, folder (optional, until projects: its `CLANKS.md` or `AGENTS.md` is followed), project (optional), created/updated.
- **message**: id, conversation, position, role, content parts (text, tool call, tool result, attachment), reasoning, status (`streaming`, `done`, `cancelled`, `failed`), the provider and model that wrote it, tokens, speed, time, finish reason, cost.
- **project**: id, title, brief, workspace (a GitHub repo cloned locally, or a local folder), base branch, status, budget, bounce limit, required checks per output type.
- **project_clank**: project, clank, model override. The project's crew; Atlas is always in it.
- **spec**: id, project, version, body, status (draft, signed off, approved), approved at. Stories and criteria are parsed out so tickets can reference them.
- **ticket**: id, project, key (`CLK-101`), title, description, story ids (optional), acceptance criteria, output type (`spec`, `design`, `pr`, `copy`, `doc`, `email`, `research`, `campaign`, `other`), route (the clanks it passes through), skipped checks with reasons, current stage, column, assignee clank (empty while the ticket is open), bounce count, priority, origin (`spec`, `chat`, `board`, `routine`, `proposal`) and created by (user or clank).
- **ticket_dependency**: ticket, depends on.
- **bounce**: id, ticket, from clank, to clank, reason, numbered issues, at.
- **run**: id, ticket, clank, worktree path, branch, base commit, command sandbox (`host`, `docker`), status, started/ended, tokens, cost, wall time.
- **checkpoint**: id, run, event, shadow commit, author (clank or user). One per tool call or user edit that changed files.
- **user_profile**: name, time zone, language, preferences, writing samples. Shared by every clank in every project.
- **context_note**: id, project, kind (`fact`, `decision`, `convention`, `glossary`, `link`), title, body, why, author, ticket, status (`provisional`, `active`, `superseded`, `dropped`), supersedes, pinned. The project context shared by the crew; see [CONTEXT.md](CONTEXT.md).
- **memory**: id, project, clank, kind (`decision`, `note`, `run_summary`), body, ticket, run, created. Indexed with FTS5. You can read, edit and delete any entry.
- **run_status**: run, state, waiting reason, live label, progress steps, updated at. Materialized from events for the live board; never edited directly.
- **event**: id, run or conversation, type, payload, timestamp. Append-only; the activity log, the live board and the workbench timeline are all built from it. Large payloads (command output, screenshots, renders) are stored by reference.
- **artifact**: id, ticket, run, kind (`spec`, `branch`, `design`, `note`, `doc`, `copy`, `email`, `campaign`, `file`, `screenshot`), location, version.
- **review_comment**: id, run, anchor (file and line range, or design node and canvas position), body, status. Sent back to the clank on "Request changes".
- **approval**: id, run, action, payload, status, decided by, decided at.

## Projects, specs and the workflow

### Starting a project

1. **Name it**: a name and a line about what you're making.
2. **Pick a workspace**: sign in with GitHub (OAuth device flow, token in the keychain) and pick or create a repo, which is cloned locally; or use a local folder for work without code.
3. **Pick the crew**: tick clanks from the premade list or your library. Atlas is always in. Software projects default to Scribe, Prism, Forge and Gauge; Scout, Quill and Buzz are optional.
4. **Pick the models**: one default for the crew, or a model per clank.

Clanks can be added to a project at any time.

### Spec

Atlas talks the idea through with you and briefs Scribe with a `spec` ticket. Scribe writes the spec: user stories (US-4), acceptance criteria (AC-4.2) and edge cases. Atlas signs it off and you approve it; nothing is built before that. Each approval is a new version (spec v2). Atlas then turns the new or changed stories into tickets, each carrying its story ids and criteria. Clarifications Scribe makes when answering a bounce are added as minor revisions; anything that changes scope comes back to you.

### Stages and routes

```
Spec ──► Design ──► Build ──► QA ──► [custom checks] ──► Sign-off ──► you
```

The stages are an order, not a checklist. A ticket passes through only the stages it needs, in this order.

- Each clank's frontmatter says whether it is a **maker** (works its own tickets) or a **checker** (reviews other clanks' tickets of the types it applies to), and which stage it sits in.
- A ticket's **route** is computed when it is created: its maker, then every checker that applies to its type in stage order, then Atlas, then you. A `pr` goes Forge → Gauge → Atlas; a `design` goes Prism → Atlas; a `campaign` goes Buzz → Atlas. A custom checker such as Sentinel (`after: qa`, `applies_to: [pr]`) slots in automatically. Spec and design are never steps in another ticket's route; they're separate tickets it may depend on.
- **Only UI work waits for design.** A ticket with a UI depends on a Prism design ticket for that screen or flow. Everything else goes straight to its maker: scaffolding, config, CI, backend, data, integrations, dependency upgrades and bug fixes.
- **Not everything waits for the spec.** Feature work comes from the approved spec. Work you ask for directly ("set up a Next.js app for the website", "upgrade React") becomes a ticket straight away, with acceptance criteria but no stories, and can run while the spec is still being written.
- Checkers work in their own worktree of the maker's branch, so they test exactly what was submitted.

| Ticket | Where it came from | Route |
| --- | --- | --- |
| Set up a Next.js app for the website | You, in chat | Forge → Gauge → Atlas → you |
| Fix the footer link | You, from the board | Forge → Gauge → Atlas → you |
| Design the board finder quiz | Spec, US-6 | Prism → Atlas → you |
| Build the board finder quiz | Spec, US-6, after its design | Forge → Gauge → Atlas → you |
| Compare payment providers | Atlas, before planning checkout | Scout → Atlas → you |
| Write the launch email | Spec, US-9 | Quill → Atlas → you |
| Add Stripe webhooks, with Sentinel in the crew | Spec, US-4 | Forge → Gauge → Sentinel → Atlas → you |

### Assigning and picking up

- **Assigned** tickets name a clank. Atlas assigns when it creates tickets, and you can assign or reassign any ticket from the board or the ticket drawer.
- **Open** tickets name only an output type, such as `pr`. The scheduler hands an open ticket to the first free clank in the crew that makes that type: whichever Forge run frees up first, or a custom maker that also makes `pr`. A backlog gets picked up without anyone assigning each card.
- **Picking order.** Backlog tickets whose dependencies are done go by priority, then age. When several clanks could take one, the scheduler prefers the clank that made the tickets it depends on, since it already knows that work, then the one with the shortest queue.
- **Any maker of the type.** A ticket can go to any clank whose outputs include its type, not only the default one. Its checks follow its type, whoever makes it.
- **Reassigning** before work starts is free. During a run, the run stops first; the work so far stays on the ticket's branch and the new clank carries on from it.

### Required and optional checks

- Atlas's sign-off and your approval are on every route.
- Each project sets which checks are required for each output type. By default Gauge is required for `pr`. When you add a custom checker, you choose whether it's required.
- Atlas or you can drop an optional check from one ticket, with a reason shown on the card, such as "Security review skipped: README only". A required check can only be changed in project settings, not skipped on a ticket.

### Bounces

- Any clank can send a ticket back with `ticket_bounce`, a reason and numbered issues, to the clanks in its `bounce_to`. By default Forge and Prism bounce spec gaps to Scribe, Gauge bounces bugs to Forge and untestable criteria to Scribe, and Atlas can bounce anything to anyone.
- A bounce to an earlier clank in the route restarts the route from there, so fixed work goes through every check again. A bounce to a clank outside the route, such as Scribe answering a spec gap, returns to the sender once it's resolved.
- Every bounce is stored with its reason, so the whole history lives on the ticket.
- After three bounces (configurable per project) the ticket stops looping and comes to you with its history.

### The board

```
Backlog ──► Build ──► QA + review ──► Ready for you ──► Done
              ▲            │                │
              └── bounce ──┘                │
              ▲                             │
              └──── changes requested ──────┘
```

- **Backlog**: waiting on dependencies or a free slot, or, for open tickets, a free clank that makes their type.
- **Build**: the ticket's maker is working on it, whether that's Scribe, Prism, Forge, Quill, Buzz or Scout.
- **QA + review**: its checkers, then Atlas's sign-off.
- **Ready for you**: signed off. You approve (to **Done**; merges and sends happen now), request changes with comments (back to its maker), or reject.
- A ticket waiting on `ask_user` shows as blocked in whichever column it's in, with the question in chat.
- The scheduler claims Backlog tickets whose dependencies are done, in priority order, within the limits per project, per clank and per loaded model. Assigned tickets wait for their clank; open tickets go to the first free clank that makes their type.

The board is live, and it's where you watch the crew work. The full spec is in [BOARD.md](BOARD.md).

- **Header and crew strip:** "● 3 clanks working", **Needs you** with a count, and every clank in the project with its status and current tickets (Forge ×2 for parallel runs).
- **Cards:** key, type badge, title, assignee with a status icon (working, waiting for a model, needs you, waits on, paused, failed), progress from the clank's posted plan, and a live line from its latest tool call, such as "Running `npm test`" or "Designing `Promo / X`".
- **Live updates:** a projection of the event log pushed over a tRPC subscription. Cards slide between columns, bounces slide back with their reason, and everything rebuilds from SQLite after a restart.
- **Activity feed:** one line per meaningful event ("Gauge › bounced CLK-103 to Forge: AC-4 failed"). Click a line to open the ticket at that moment.
- **Working with it:** peek on hover, a ticket drawer on click, **Watch** to follow the run in the workbench, drags to prioritise, reassign, start or stop. Every drag is a command the state machine can refuse, and approving always opens the approval card.
- **Other views:** **By clank** (one lane per clank and per parallel run) and **Schedule**. **Home** is the same overview across every project: needs you, working now, coming up, machine load and today's usage.

The workflow engine and ticket state machine live in `packages/core` and are the only code allowed to move a ticket.

## Agent runtime

One loop for every clank:

1. Build context: the system prompt from the crew docs (see below), the conversation or ticket, relevant artifacts, tool definitions.
2. Call the model through the provider registry, streaming. On the built-in runtime this first reserves a slot on a loaded model, which may mean waiting for it to load.
3. For each tool call: validate the arguments, then check the permission policy (allow, ask, deny). "Ask" creates an approval and suspends the run until you answer.
4. Execute the tool, record the event, checkpoint the worktree if files changed, feed the result back.
5. Repeat until the clank calls a finishing tool: `submit_output` (makers), `review_pass` (checkers), `ticket_bounce`, `ask_user` or `fail`.

Planning is a specialisation of the same loop. Atlas gets board tools (`board_create_ticket`, `board_link_dependency`, `board_assign`, `board_update_ticket`) and runs when you approve a spec version, turning its stories into tickets. You can edit the board at any time.

Context is the scarce resource, especially on local models:

- Makers get the ticket, its stories and acceptance criteria and the outputs of the tickets it depends on, never the chat that produced it. Checkers also get the maker's output and notes.
- The project context and the clank's own memory are searched with the ticket's title and stories, and the best matches are added within each layer's budget. The clank can search further with `context_search` and `memory_search`.
- Large tool results are truncated (head and tail, with a note of what was cut). The full result stays in the event log and can be read in pages.
- Near the context limit, older turns are summarised. Runs are checkpointed so they resume after an app restart or a model crash.

## Clanks and priming

A clank is a priming doc plus settings. The docs for the default crew live in [`crew/`](../crew/README.md) and are written to the model, not about it.

| Clank | Role | Kind | Makes |
| --- | --- | --- | --- |
| Atlas | Lead: talks to you, plans, writes tickets, signs off. Always in. | checker (sign-off) | |
| Scribe | Business Analyst | maker (spec) | `spec` |
| Prism | Designer, works in Studio | maker (design) | `design` |
| Forge | Engineer | maker (build) | `pr` |
| Gauge | QA | checker (qa) | |
| Scout | Researcher (optional) | maker (build) | `research` |
| Quill | Writer (optional) | maker (build) | `copy`, `doc`, `email` |
| Buzz | Marketing (optional) | maker (build) | `campaign` |

- `crew/CREW.md` holds the rules every clank shares: chat and ticket modes, how to work, when to ask, and how to treat untrusted content.
- `crew/<clank>.md` is one file per clank: YAML frontmatter that configures the app (id, role, output types, workflow placement, model requirements, default tool policy) and is never sent to the model, then the prompt itself.
- `crew/custom.md` is the template for custom clanks, and `crew/examples/sentinel.md` is a worked one: a security checker between QA and Atlas. Custom clanks are saved to your library and can join any project.

The system prompt is assembled stable parts first, so llama.cpp's prompt cache and provider prompt caching hit on every turn:

1. `CREW.md`, with variables filled in (`{{date}}`, `{{os}}`, `{{clank.name}}`, `{{user.name}}`, `{{crew}}` for the project's crew and `{{workflow}}` for its stages).
2. The clank's doc body, with HTML comments removed.
3. Integration guides: for each integration this clank can use in this project, a fixed preamble and the integration's `guide.md`.
4. Your profile: name, time zone, language and preferences, the same in every project.
5. Project instructions: `CLANKS.md` at the workspace root, or `AGENTS.md` if there isn't one. The top part goes to every clank, plus this clank's `## For <clank>` section.
6. Project context, shared by the whole crew: project facts, the brief and spec summary, the design language and the most relevant project notes.
7. Clank memory: this clank's most relevant entries for this project.
8. Run context: the mode and, for a ticket, its key, title, description, stories, acceptance criteria, output type, dependency outputs and bounce history, plus the routine, run date and due time for tickets a routine created. A ticket that depends on a design also gets `design/DESIGN.md` and a spec of the relevant frames.

The docs have to work on small local models. `CREW.md` plus any one clank doc stays under 2,500 tokens, names only real tools, and ends with the output contract that `submit_output` validates against; CI checks all three. Edited copies live in the app data folder and the bundled files are never modified. The format and writing rules are in [crew/README.md](../crew/README.md).

Each doc's frontmatter declares `model.tags`, `model.needs`, `model.prefers` and `model.min_context`. When you create a project, the app matches those against the model catalog and your hardware to propose a model per clank, which you can change any time.

### Context and memory

Every project has a context shared by all its clanks, and every clank has a memory of its own. The full spec is in [CONTEXT.md](CONTEXT.md).

- **Project context**, which every clank in the project reads and adds to:
  - project facts the app generates (repo, how to run it, integrations and their modes, crew, spec version, routines);
  - the brief and a summary of the spec;
  - the design language;
  - **project notes**: facts, decisions, conventions, glossary entries and links, written by you or by clanks with `context_write`. A clank's note is provisional, but visible to the crew straight away, until its ticket is approved, and Atlas tidies notes at sign-off.
- **Clank memory**, private to one clank in one project: its chats, a summary of every run, and the decisions it records with `memory_write`, each with its reason. Ask Forge why it picked a library and it answers from its own record. Atlas can search the memory of a clank whose ticket it signs off.
- **Instructions stay yours.** Your profile, `CLANKS.md` (with `## For <clank>` sections) and the priming docs are instructions. Notes and memory are information, labelled that way in prompts.
- **Budgets per layer** scale to the model's context window. The Context tab's **Preview** shows exactly what a clank sees on a ticket, layer by layer, with token counts.

## Local models

clanks downloads and runs models itself, with a llama.cpp runtime bundled inside the app. A fresh install needs nothing else: no Ollama, no separate model server, no command line. Models are pulled straight from Hugging Face into clanks' own store and run by clanks' own runtime. The experience will feel familiar to anyone who has used Ollama (short names, pull, a local store, models loaded on demand and unloaded when idle), but nothing depends on it.

**Runtime.** llama.cpp's `llama-server`, pinned to a tested release (`packages/models/src/runtime/llama-cpp.json` lists every build with its sha256) and shipped as prebuilt binaries per platform and GPU backend: Metal on Apple Silicon; CPU and Vulkan on Windows and Linux. When an NVIDIA GPU is found, the Models screen offers the CUDA build as a download (about 600 MB), checked the same way. `scripts/fetch-llama.ts` in `packages/models` fetches the bundled builds at build time and keeps only the server and its libraries. The model manager starts one `llama-server` per loaded model as a child process on 127.0.0.1, on a random port, with a per-launch API key, a scrubbed environment and `--offline`, and uses its OpenAI-compatible API. It sets the context and slots and leaves layer placement to llama.cpp's own fitting to free memory (`--fit`); where the layers and buffers ended up, read from its log, is what the Models screen shows. If it crashes, the supervisor restarts it and the affected runs resume from their last checkpoint. Servers a crashed app left behind are stopped on the next start.

**Catalog.** A versioned JSON file in `packages/models` lists recommended models by short name and tag (`name:tag`), with the Hugging Face repo and file, sha256, size, quantisation, context length, capabilities (tools, vision), licence and role tags (`code`, `general`, `reasoning`, `writing`, `design`, `long-context`) that the crew docs match against. Each entry pins its repo's revision and carries the GGUF facts the memory estimate needs, so the catalog shows what fits with no network; `pnpm --filter @clanks/models catalog:update` fills those in from Hugging Face. The app ships with a copy; refreshing it from this repo comes later. It is data, never code.

**Pulling.**

- Pull from the catalog by name, or from any Hugging Face GGUF repo as `hf.co/<owner>/<repo>:<quant>`. Files come straight from Hugging Face.
- Before downloading, the manager reads the GGUF header over HTTP range requests (`@huggingface/gguf`) for layer count, context length and chat template, and estimates whether the model fits: weights plus KV cache at the clank's context plus overhead, against detected memory. The UI shows "fits on GPU", "partly on GPU" or "too large".
- Downloads are chunked and parallel, resume across restarts, are verified by sha256 and stored content-addressed. Two tags that point at the same file share one blob.
- Only GGUF is accepted. No pickle files, nothing executable from a model repo.
- Gated repos use a Hugging Face token from the keychain.
- Optional: if Ollama models are already on disk, clanks can reuse their GGUF files (hard-linked where possible, copied otherwise, and checked by sha256 either way) instead of downloading them again. They're named `ollama/<name>:<tag>`, so they never clash with the catalog. Ollama doesn't need to be running, and clanks never calls it.

**Hardware probe.** At startup the manager asks the bundled llama.cpp build which devices it sees and how much memory each has (`--list-devices`), and reads system RAM. Apple Silicon counts as unified memory. The result picks the backend build and sets the memory budget, which you can override.

**Scheduling.**

- A model loads when a run first needs it and unloads after an idle timeout (default 10 minutes, or "keep loaded" per model).
- Runs on the same model share one process through `llama-server`'s parallel slots with continuous batching. The context size is set at load time from the slot count and each clank's `min_context`; changing the slot count reloads the model between runs.
- If a model doesn't fit next to what's loaded, idle models are evicted least recently used first. If it still doesn't fit, the run waits and its ticket shows "waiting for model".
- On small machines, onboarding picks one model for the whole crew so nothing swaps.

**Tool calling.** `llama-server` runs with the model's own chat template (`--jinja`), which gives native tool calls for most current instruct models. For models without them, the adapter describes the tools in the prompt and constrains the reply with a JSON schema grammar, so output is always parseable. A malformed call is returned to the model once as a tool error; a second one fails the run.

**Local API (optional, off by default).** clanks can serve its models to other apps on 127.0.0.1: OpenAI-compatible `/v1/models` and `/v1/chat/completions`, plus the common Ollama endpoints (`/api/tags`, `/api/chat`, `/api/generate`, `/api/pull`, `/api/ps`) so editors and scripts that speak Ollama can point at clanks instead. It listens on Ollama's port, 11434, unless you pick another, and says so if that's taken. Requests go through the same scheduler, so they queue behind crew runs rather than fight them for memory. It answers only requests addressed to a loopback host, so a website can't reach it by rebinding a hostname, and refuses requests from web pages' origins.

**Starting points per machine.** Rough targets, to be validated against the crew docs before release:

| Machine | Default setup |
| --- | --- |
| 16 GB RAM, no usable GPU | One small model (about 4B to 8B, Q4) for the whole crew, one worker at a time. |
| 8 to 12 GB VRAM, or 16 to 24 GB unified memory | One 8B to 14B model for the crew, two parallel slots. |
| 16 to 24 GB VRAM, or 32 to 64 GB unified memory | A 30B-class model (mixture-of-experts preferred for speed) for Atlas, Scribe, Forge and Prism; a smaller one for Gauge, Scout, Quill and Buzz. A vision-capable model for Prism and Gauge if one fits. |
| 48 GB+ VRAM, or 96 GB+ unified memory | A model per clank, three or four parallel workers. |

## Providers

```ts
interface Provider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>; // text deltas, tool calls, usage
  capabilities(model: string): { tools: boolean; vision: boolean; contextWindow: number };
}
```

Adapters, in order:

1. **Built-in runtime.** Calls the bundled `llama-server` that clanks' model manager started, over its local HTTP API, with slot reservation and the grammar fallback for tool calls. The default, and the only one a fresh install uses.
2. **Cloud (optional).** Anthropic, OpenAI, Google and OpenRouter, for clanks you choose to run on a cloud model with your own key. Anthropic goes through its official SDK, with adaptive thinking where the model has it and prompt caching on; the others through the OpenAI-style client, Google by way of its compatibility endpoint. Model lists come from each provider with your key.
3. **External servers (optional).** Any OpenAI-compatible server you already run elsewhere, such as vLLM on another machine, LM Studio or Ollama. Never needed. A server is checked by listing its models before it's saved.

Usage is recorded for every call. Cloud calls are priced from tables in config; local calls record tokens, tokens per second and wall time. Budgets can be set in tokens, time or money.

## Tools and permissions

| Group | Tools | Default policy |
| --- | --- | --- |
| Files | `fs_read`, `fs_list`, `fs_search`, `fs_write`, `fs_edit` | Reads allowed. Writes allowed inside the run's worktree, impossible outside it. |
| Shell | `shell_exec`, `shell_start`, `shell_output`, `shell_stop` | Ask, with "always allow this command in this project". |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit` | Allowed, on the run's own branch. There are no push, merge or branch-switching tools. |
| Web | `web_search`, `web_fetch` | Ask, except for Scout. |
| Browser | `browser_open`, `browser_navigate`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_screenshot`, `browser_console`, `browser_back`, `browser_close` | Per clank. |
| Design | `design_read`, `design_create`, `design_update`, `design_delete`, `design_tokens_set`, `design_make_component`, `design_link`, `design_render`, `design_lint` | Prism has all of them. Forge and Gauge get `design_read` and `design_render`; Atlas, Scribe, Quill and Buzz get `design_read`. |
| Board | `board_list`, `board_get_ticket`, `board_create_ticket`, `board_update_ticket`, `board_link_dependency`, `board_assign` | Atlas. Makers get `board_create_ticket`, which files a proposal for Atlas; Scribe gets `board_update_ticket` to fix criteria. |
| Spec | `spec_read`, `spec_write` | Most clanks read the approved spec; Scribe writes drafts. |
| Review | `review_pass` | Checkers: Gauge, Atlas and custom checkers. |
| Crew | `post_progress`, `ask_clank`, `ask_user`, `submit_output`, `fail`, `ticket_bounce` | Every clank. `ticket_bounce` reaches only the clanks in its `bounce_to`. |
| Context and memory | `context_search`, `context_write`, `memory_search`, `memory_write` | Every clank. The project context is shared by the crew; memory is the clank's own. Atlas can search the memory of a clank whose ticket it signs off. |
| Artifacts | `artifact_save` | Allowed. |
| Routines | `routine_list`, `routine_get`, `routine_propose` | Atlas and Buzz. `routine_propose` only drafts; you activate. |
| Integrations | `int_<integration>_<operation>`, generated from each connected integration | By risk level: read allowed, write asks, outbound asks every time. Granted per project and per clank. |

- Tool names are `snake_case` with a group prefix because provider APIs reject dots in tool names.
- MCP servers can be attached per clank. Their tools appear alongside the built-ins with an `mcp_<server>_` prefix.
- Every tool declares a short live label for the board ("Running `npm test`", "Editing `src/cart.ts`"), with redaction rules for commands and URLs. `post_progress` takes an optional list of plan steps, which cards show as progress.
- Every tool declares a risk level. Each clank has a policy mapping tools to allow, ask, deny or off. Defaults come from the clank's priming doc; Settings override them. Approval prompts can widen a rule to a command or a host for the whole project.
- Outbound actions are not tools. Clanks can't push, open PRs, merge, post or send. The orchestrator pushes Forge's branch and opens its pull request when Forge submits on a connected repo, and does everything else only when you approve, so no model output, injected or not, can trigger them. Integration operations that spend money, publish or contact people are tools, but locked to asking every time.
- `web_search` uses a backend you configure: a self-hosted SearXNG, or a Brave or Tavily key. Without one it runs the search in the built-in browser, where you can watch it; until the browser arrives (Milestone 4), clanks without a backend get no search tool and fetch pages they know the address of.

## Integrations

Integrations connect clanks to third-party APIs: payments, stores, analytics, docs, trackers, chat, email services and hosting. Settings → Integrations lists what's installed. You connect an account with an API key or OAuth, then turn it on per project and per clank.

There are two kinds:

- **Declarative (preferred).** A manifest plus a trimmed OpenAPI document. The orchestrator turns each listed operation into a tool, signs requests with the credential from the keychain, and only calls the hosts the manifest declares. No code from the package runs.
- **MCP server.** For services that need logic a manifest can't express. These run code on your machine, so the app says so before you install one, pins its version and checksum, and can run it in Docker when Docker is available.

A declarative manifest:

```yaml
id: stripe
name: Stripe
summary: Products, prices, customers and checkout sessions.
hosts: [api.stripe.com]
auth:
  type: api_key              # api_key, oauth2 (PKCE) or basic
  header: Authorization
  format: "Bearer {secret}"
  modes:                     # optional: tell test credentials from live ones
    test: { prefix: sk_test_ }
    live: { prefix: sk_live_ }
openapi: openapi.yaml        # only the operations listed below are used
operations:
  - { id: list_products,  op: "GET /v1/products",  risk: read }
  - { id: create_product, op: "POST /v1/products", risk: write }
  - { id: create_refund,  op: "POST /v1/refunds",  risk: outbound, verify: list_refunds }
guide: guide.md              # up to 300 tokens, added to the prompt of clanks that use it
```

- **Tools.** Each operation becomes a tool named `int_<integration>_<operation>`, such as `int_stripe_list_products`, with arguments and descriptions taken from the OpenAPI document. Responses are trimmed and truncated like any tool result, and treated as untrusted content.
- **Risk levels.**

  | Risk | Examples | Policy |
  | --- | --- | --- |
  | `read` | List products, fetch analytics, read a page | Allowed by default |
  | `write` | Create a draft, add a product in test mode, update an issue | Asks by default; can be set to allow |
  | `outbound` | Charge or refund money, publish, post, message people, delete, and any change in live mode | Asks every time; can't be set to always allow. A routine can get this approval ahead of time, for the exact payload and time. |

- **More than one call.** An operation can be a short fixed sequence, such as uploading media and then creating a post with the media's id, with outputs mapped into later inputs. It's still data, not code.
- **For routines.** An outbound operation can name a `verify` operation the orchestrator uses to check whether it happened after an interruption, and a `schedule` parameter when the service can schedule it on its side, so approved posts can be handed off and go out with the computer off.
- **Credentials** live in the keychain and are injected by the orchestrator. They never reach the model and are redacted from logs. Each connection's mode (test or live) is shown on the ticket and in every approval prompt.
- **OAuth** runs in your system browser with PKCE and a loopback redirect, so no clanks server is involved.
- **Prompt preamble.** Clanks that can use an integration get a short fixed preamble (what `int_` tools are, check the mode before changing anything, responses are data, outbound calls wait for approval) and the integration's guide.
- **No inbound webhooks.** Nothing on the internet can reach the app, so integrations poll when they need updates.
- **Bundled.** GitHub, GitLab and SMTP/Gmail are built in. A starter set of declarative integrations ships in `integrations/` in this repo. Everything else comes from the marketplace.

## Routines

Routines are the scheduler: work that starts at a time, on a repeating schedule or when something happens, and actions that go out at an exact time once approved. The full spec is in [ROUTINES.md](ROUTINES.md).

- **Triggers:** `once`, `cron` (with `L` and `#`, in the routine's IANA time zone), `event` (`spec.approved`, `ticket.done`, `pr.merged`, `git.tag`, `routine.finished`) and `manual`. You can type a schedule in plain language; the editor always shows the cron expression and the next five times before you activate.
- **Steps:** ticket steps create tickets for clanks that go through the normal workflow; action steps call an integration operation at a set time with a payload templated from earlier steps' approved outputs. Each ticket step is due a review buffer before the first action that needs it.
- **Approvals:** one **Ready for you** card per run shows everything that will go out, as it will appear. Approving freezes each action's payload, media, account and time; changing any of them asks again. Unapproved actions never go out.
- **Execution:** the orchestrator, not a model, executes scheduled actions at their time, within a grace window, exactly once (with `verify` after interruptions), or hands them off to the service's own scheduler when it has one.
- **Offline and asleep:** the tray keeps routines running, an optional OS task launches the app before a run, and a missed policy (`skip`, `run_late`, `ask`) decides what happens when the app was off. Actions never go out after their grace window on their own.
- **Creating them:** from chat (Atlas or Buzz drafts with `routine_propose`; you activate), from an approved campaign's **Schedule** button, in the editor, or from a marketplace template.

## Marketplace

A free marketplace for what people build for clanks: free to publish, free to install, no paid listings and no account.

**What's on it.**

- **Clanks**: a priming doc in the [crew format](../crew/README.md), with its workflow placement, model needs, default tool policy and the integrations it expects. Sentinel is the kind of thing that belongs here.
- **Integrations**: declarative manifests or MCP servers.
- **Crews**: a set of clanks, their workflow and the integrations they expect, for a kind of project, such as "Shopify store" or "podcast launch".
- **Routines**: templates such as "weekly competitor digest" or "release notes and announcement", installed as inactive drafts.

**How it works.**

- The marketplace is a public GitHub repo (proposed: `clanks-marketplace`). Each package is a folder with a `package.yaml` (kind, id, version, publisher, licence, requirements) and its files. CI validates every submission and builds a static `index.json` with a sha256 for every version.
- The app fetches the index. Browsing needs the network; installed packages work offline. There's no account, no tracking and no install counts.
- More indexes can be added in Settings, such as a team's private one, in the same format.

**Installing.** Before you install, the app shows the full priming doc, the tools and permissions a package asks for, the hosts an integration calls and whether it runs code. Packages are checked against the index's checksum and installed into your library. A marketplace clank can't raise its own permissions: anything above read starts at ask, whatever its frontmatter says.

**Updates.** Prompts and permissions never change without you. An update shows the priming doc's diff in the diff editor and highlights new tools, hosts or permissions; accept it or stay on the pinned version. Packages revoked in the index are disabled with a notice.

**Publishing.** **Publish** on a clank's profile or an integration's settings validates the package (schema, token budget, tool names, and a scan for secrets and personal data), asks you for an open licence, and, once you confirm, opens a pull request to the marketplace repo from your GitHub account. Maintainers review each listing, and reviewed packages get a badge.

## The workbench

The main window is chat on the left and the workbench on the right. The workbench follows the run you are looking at: the clank you're chatting with, or any ticket's run opened with **Watch** from the board. Its panes are tabs: Diff, Browser, Terminal, Studio and Activity.

### Workspaces and checkpoints

- A project points at a folder. Code and design projects need a git repo; clanks offers to `git init` one.
- Each ticket run gets its own worktree (`git worktree add`) on a new branch `clanks/<ticket key>` off the project's base branch, kept in the app data folder. Parallel clanks never see each other's half-finished edits. Checkers get their own worktree of the maker's branch.
- Until projects arrive, a chat about a folder in a git repository is a run of its own: its clank works in a worktree on `clanks/chat-<id>`, made from the folder's checked-out commit. Uncommitted changes in your checkout aren't in it, and nothing the clank does touches your checkout. Deleting the chat removes the worktree; work left in it is committed to the branch first, and the branch stays for you to merge or delete. A folder that isn't a repository yet can be made one from the workbench, which commits what's there.
- After every tool call that changes files, the orchestrator records a checkpoint: a commit in a shadow git directory (`--git-dir` in app data, `--work-tree` the run's worktree). It borrows the repository's objects through git's alternates, so unchanged files cost nothing, and stores files byte for byte whatever `core.autocrlf` says. Checkpoints never touch your repo's history or refs. The clank's own `git_commit`s go on the run branch as normal.
- Notes, documents and email drafts are written to the ticket's artifact folder and versioned there.

### Diff editor

Monaco's diff editor, wired to the run:

- A tree of changed files with added and removed line counts; side-by-side or inline.
- Live: the diff updates as the clank writes, and the editor follows the file being edited unless you pin another.
- Compare the run with its base, or any two checkpoints. A step scrubber walks the run one tool call at a time, showing what a step changed or everything up to it.
- Accept or reject per hunk or per file. Rejecting reverts it in the worktree and tells the clank, with your reason if you give one.
- Edit the right-hand side directly. Your edits are recorded as a user checkpoint and the clank is told which lines you changed.
- Comment on a line or a range. Comments collect into a review that **Request changes** sends back with the ticket.
- **Rewind** restores the worktree to a checkpoint and cuts the run's context back to that point.

In a chat (Milestone 3), rejections, comments and edits become review notes. They go to the clank with your next message, or straight away with **Send to <clank>**; while it's working, they reach it after its current round of tool calls, as a message from you. Rejecting is per hunk so far, and comparing two arbitrary checkpoints waits for tickets. A rewind cuts the chat back to the moment of the checkpoint, and notes sent after that moment are pending again.

It is also the review surface for pull requests and for comparing versions of specs, documents and priming docs.

### Browser

- A pane of tabs, each a `WebContentsView` with `sandbox` and `contextIsolation` on, no preload and no Node. Each run gets its own tabs, labelled with the clank and ticket.
- The browser controller drives tabs over the Chrome DevTools Protocol through `webContents.debugger`: navigation, input events, the accessibility tree, screenshots and console messages.
- `browser_read` returns a compact text snapshot: title, URL and the accessibility tree with numbered refs, such as `[12] button "Book now"`. `browser_click` and `browser_type` take a ref. Text-first works for local models without vision; vision models can also use `browser_screenshot`.
- Sessions are isolated. Each run starts with a fresh in-memory partition. A clank can be given a persistent partition for sites you want it to stay signed in to. Your own browser's cookies and passwords are never involved.
- You watch live. A banner shows which clank is driving. **Take over** pauses the clank's browser tools (they return "user has control") so you can sign in, dismiss something or steer. **Hand back** resumes.
- Guard rails: per-clank site allow and deny lists checked on every navigation; `browser_type` refuses password fields; downloads are blocked unless approved; no file uploads; new windows open as tabs.
- Forge uses the same pane to preview its dev server, so you see the site being built.

### Terminal

Every `shell_exec` and `shell_start` streams to an xterm.js tab for that run. You can stop any process. Clanks' commands run with their output piped rather than in a pty: what the model reads stays plain text (Windows' ConPTY would wrap it in cursor movement), nothing can wait for keyboard input, and exit codes are exact. They run in bash, the one that comes with Git for Windows on Windows, so commands are the same on every platform. **Open shell here** gives you your own terminal in the run's worktree, a real pty (node-pty) running your usual shell; clanks can't see or use it.

### Activity

A timeline of the run: model turns, tool calls with inputs, outputs and duration, approvals and checkpoints. Selecting a step moves the other panes to that moment: the diff at that checkpoint, the page as it looked at that step, the command's output, the design as it was.

## Studio

Studio is the design tool built into clanks, in the spirit of Figma: an infinite canvas where Prism maps user flows, wireframes, builds the design system and screens, and makes social graphics and mock-ups, and where you can design by hand alongside it. It is a top-level view of its own and a workbench pane when you're watching Prism.

### Design files

A design lives in the project's `design/` folder, so it gets the same worktrees, checkpoints and review as code:

```
design/
  DESIGN.md                   the design language: principles, usage rules, do and don't
  tokens.tokens.json          design tokens
  site.design/
    document.json             pages, frame order, prototype links
    pages/<page id>.json      one file per page: its node tree
    components/<id>.json      one file per component set, with variants and properties
  assets/                     images and fonts the design uses
```

Files are pretty-printed JSON with stable ids and sorted keys so git diffs stay readable. The schema lives in `packages/design` and is versioned with migrations.

### Model

- A scene graph of nodes: frame, text, rectangle, ellipse, line, image, vector (SVG), icon, component and instance.
- Frames have auto layout: direction, gap, padding, alignment, wrap and hug, fill or fixed sizing. It maps one-to-one onto CSS flexbox. Children can opt out with absolute position and constraints.
- Any style property can be a token reference. Lint flags raw values.
- Components have variants and typed properties (text, boolean, instance swap). Instances carry overrides.

### Tokens and the design language

- Tokens in the W3C Design Tokens Community Group format: colour, typography, spacing, sizing, radius, shadow, opacity and motion. Semantic tokens alias primitives (`color.text` → `color.neutral.900`), and modes cover light, dark and any you add.
- Exported on demand as CSS custom properties, a Tailwind theme or plain JSON.
- `DESIGN.md` is the written half: principles, how each colour role and type style is used, spacing and layout grid, each component and when to use it, accessibility rules, do and don't. It is what Forge and Quill get when their tickets depend on a design.

### Renderer

Frames render as real DOM and CSS in a sandboxed view: auto layout as flexbox, tokens as CSS variables, text with the browser's own text engine. Pan and zoom sit on top. What you see in Studio is what a browser will draw, so Forge's build can match it and exporting to code is a mapping rather than a translation. Frames off-screen are drawn from cached bitmaps so large files stay fast.

### Editor

The same editor for you and for Prism:

- Pages, frames with device and social-media presets, shapes, text, images, SVG import, a built-in icon set (Lucide), a set of open-licence fonts and a greyscale wireframe kit.
- Selection and multi-select, resize handles, snapping and smart guides, align and distribute, grouping, undo and redo, Figma-style shortcuts.
- Layers, properties, tokens, components and assets panels. Inspect mode shows the CSS and token names for any selection.
- Prototype mode: link elements to frames and click through flows in a player. Flow view lays the same links out as a user-flow diagram.
- Comments pinned to the canvas.

### Working with a clank

Every change, yours or Prism's, is an operation on one log: create, update, delete, move, token change. Prism's operations stream into the canvas as it works, and the viewport can follow it. If you change a node while Prism is working, Prism is told on its next tool call, and its later updates to that node are checked against your edit instead of overwriting it.

The design tools:

- `design_read` returns a compact text tree of a file, page, frame or component (ids, names, layout, token references) and the token list. This is how text-only local models see a design.
- `design_create` inserts JSX-like markup under a parent node (see [Prism's doc](../crew/prism.md) for an example). Building a whole section in one call keeps small models efficient.
- `design_update` and `design_delete` act on node ids. `design_tokens_set` creates or changes tokens. `design_make_component` turns a node into a component or adds variants. `design_link` adds prototype links.
- `design_render` renders a frame to PNG in an offscreen view, for vision models and for the activity timeline.
- `design_lint` returns problems as text: raw values that should be tokens, contrast below WCAG AA, overflowing or clipped text, tap targets under 44px, overlapping siblings, detached instances and unnamed layers. Text-only models design against the linter.

### Review and hand-off

- A design output is reviewed in Studio. Visual diff compares two checkpoints side by side or as an overlay with an opacity slider, and lists property-level changes, such as `Button/primary` fill `color.brand` → `color.brand-strong`. The diff editor shows the raw JSON if you want it.
- Canvas comments collect into **Request changes**, the same as line comments on code.
- A ticket that depends on a design gets `DESIGN.md`, the tokens and a compact spec of its frames in its run context. Forge can also `design_read` and `design_render` to compare a frame with a `browser_screenshot` of its page.
- Exports: PNG, SVG and PDF per frame; tokens as CSS, Tailwind or JSON; components as React and CSS starting points.

## Command sandbox

Shell commands run in one of two places, set per project and per clank:

- **Host (default).** A child process in the run's worktree, through a pty. The environment is scrubbed (no provider keys, no clanks secrets), commands have a timeout and an output cap, and the permission policy asks before anything not allowed. Works with nothing else installed.
- **Docker (optional).** When Docker is available, the run gets a container from a base image (Node, Python, git and common toolchains, overridable per clank) with the worktree bind-mounted, no other host mounts and the network off unless granted. Commands run through `docker exec`. Recommended for unattended runs and untrusted repos.

Files, git, browser, design and model calls stay in the orchestrator either way, so the workbench sees everything and a container never sees a key.

## Outputs

| Output type | Made by | Delivered as | On approval |
| --- | --- | --- | --- |
| Spec | Scribe | Versioned Markdown spec in the project's Spec tab | Becomes the approved version, and Atlas creates tickets from it |
| Design | Prism | Design files, tokens and `DESIGN.md` on the run branch, reviewed in Studio | Merged into the base branch; exports on demand |
| PR | Forge | A branch pushed to your connected repo with a pull request opened (a local branch for folder projects), reviewed in the diff editor, CI status mirrored on the ticket | You merge it, in the app or on GitHub |
| Copy, Doc | Quill | Markdown rendered in the ticket; docs export to PDF (`printToPDF`) and DOCX (`docx`) | Accepted, or committed to the repo if the ticket names a path |
| Email | Quill | Draft stored in the app | Sent through your SMTP or Gmail connection |
| Campaign | Buzz | Plan, calendar and post drafts rendered in the ticket | Accepted. Posts with a time and an account can be scheduled; clanks posts them at that time once you approve (see Routines). |
| Research | Scout | Markdown note with sources and screenshots of key pages | Accepted |
| Other | Custom clanks | Files saved as artifacts | Accepted |

## Security

- The GitHub token is stored in the keychain and limited to the repos you pick. Pushes only go to `clanks/*` branches, never to the default branch.
- Keys and tokens live in the OS keychain only. The renderer, browser pane and Studio renderer run with context isolation, sandboxing and no Node integration.
- Model output, tool arguments, design markup and IPC payloads are validated with zod before they touch state.
- `llama-server` listens only on 127.0.0.1, on a random port, with a per-launch API key. The optional local API is off by default and loopback-only.
- Models are GGUF only and verified by sha256. llama.cpp builds are pinned and checksummed at build time, and runtime downloads are verified the same way.
- Clanks can't write outside their worktree: paths are resolved, symlinks included, and checked on every file tool call.
- Prompt injection is assumed. Content a clank reads (web pages, repo files, emails, designs, other clanks' outputs) can never grant permissions. Approvals are decided only in the UI, and outbound actions are not tools.
- Integrations only call the hosts their manifest declares. Credentials are injected by the orchestrator and redacted from logs, and outbound operations and any change in live mode ask every time.
- Only you write instructions: your profile, `CLANKS.md` and the priming docs. Project notes and memory are information, labelled that way in prompts, and a clank's notes stay provisional until its ticket is approved. A clank only ever sees the context of the project it's working in.
- Routines are created and activated only in the UI. Scheduled actions run only frozen, approved payloads, checked by hash, inside their grace window, and are executed by the orchestrator with no model involved.
- Marketplace packages are checksum-verified and previewed in full before install, can't grant themselves permissions above ask, and never change prompts or permissions without your review. MCP servers are flagged as running code.
- Browser tabs are isolated per run, can't upload files and can't type into password fields.
- Budgets are enforced in the orchestrator, which is the only path to a model.

## Testing

- Unit tests (Vitest) for the state machine, scheduler, permission policy, prompt assembly and provider adapters.
- A fake provider that replays recorded model responses, so agent loops are tested deterministically and offline.
- Model manager tests against a local HTTP fixture: resume, checksum failure, cancel, disk full. A CI job pulls a tiny GGUF model and runs a real `llama-server` on CPU.
- Context: layer order and budgets, per-clank `CLANKS.md` sections, the note lifecycle, and isolation between projects and between clanks.
- Live board: event sequences to board state (bounces, restarts, crashes), live label redaction, and a replay of 500 tickets and 20 concurrent runs.
- Workflow engine: routes for every output type, custom checker placement, bounce targets, route restarts and the loop limit.
- Worktree, checkpoint and rewind tests against fixture repos.
- Integrations: manifest validation, OpenAPI-to-tool generation, auth and redaction, and host and risk enforcement against a mock API server.
- Routines: cron and time zones on a fake clock, missed runs across sleep and shutdown, and scheduled actions against a mock integration (hash checks, retries, unknown outcomes).
- Marketplace: index parsing, checksum failures, install, update diffs, revocation and publish validation.
- Browser tools tested against local fixture pages in a real Electron window.
- Design engine: schema migrations, the operation log, the markup parser and lint rules, plus renderer screenshot tests.
- Crew docs, the custom template and examples: frontmatter schema including workflow placement, token budget, tool names checked against the registry, and golden runs on the fake provider.
- Playwright tests for the app's main flows: pull a model, chat, approve a spec, watch a run in the diff editor and browser, edit a design alongside Prism, approve an output.

## Build order

The first steps, in the order they unblock each other:

1. Monorepo, Electron + React shell, tray, CI with lint, typecheck and tests.
2. `core` types and the SQLite store with migrations.
3. Model manager (hardware probe, catalog, pulls, blob store, `llama-server` supervisor), the provider interface with the built-in runtime adapter, and a fake provider. **First demo: a fresh install pulls a model and answers a prompt, with nothing else installed.**
4. Crew doc loader and prompt assembly; chat UI streaming against a clank on the built-in runtime. **Second demo: chat with Atlas offline on a model clanks pulled itself.**
5. Optional adapters: cloud providers and external OpenAI-compatible servers.
6. Tool registry, permission policy, approval prompts, activity log.
7. Worktrees and checkpoints; the diff editor and terminal panes.
8. Browser pane, browser controller and browser tools.
9. Projects (GitHub sign-in, crew and models per project), specs with Scribe, the board, Atlas's ticket breakdown.
10. Workflow engine: routes, checkers, bounces and the loop limit; Gauge; Atlas sign-off; project context and clank memory; your profile.
11. Scheduler with model-aware slots, parallel runs, pull requests on GitHub, optional Docker sandbox; the live board's run status, live lines, crew strip, By clank view, Needs you and Home.
12. Studio: design format, renderer, editor, tokens, design tools; then Prism.
13. Quill, Scout and Buzz outputs, custom clanks and the library, GitLab, exports.
14. Integrations: the declarative runtime, connections, risk levels, MCP integrations and the starter set.
15. Marketplace: index, install and update flow, publishing from the app.
16. Routines: triggers, runs, ticket and action steps, approvals ahead of time, scheduled action execution, missed-run handling, OS launch tasks, the Schedule view.

## Open questions

- **License.** MIT or Apache-2.0 for adoption, or AGPL to keep forks open.
- **Starter models.** Which models go in the catalog for each hardware tier, and how often to re-pick them. Needs the evaluation harness (see the roadmap) run against the crew docs.
- **GPU builds.** CUDA builds of llama.cpp are large, so for now they're a download the Models screen offers on NVIDIA machines. Revisit a separate installer for NVIDIA machines, and ROCm builds for AMD cards, which run on Vulkan today.
- **Windows sandboxing.** There is no lightweight equivalent of Seatbelt or bubblewrap, so host commands on Windows rely on the permission policy alone. Decide whether Docker or WSL should be the default there.
- **Ollama API scope.** How much of Ollama's API to mirror (`/api/embed`, `/api/create` with Modelfiles) beyond the common subset.
- **Studio scope.** Where to draw the line before the first release: pen tool, boolean operations and Figma import are listed under Later.
- **Running off the laptop.** The earlier plan had a Kubernetes runner and a headless daemon. Both are parked under Later; revisit if long-running projects need a machine that stays on.
- **Starter integrations.** Which declarative integrations ship bundled. Candidates: Stripe, Shopify, Notion, Linear, Slack, Google Analytics, Vercel.
- **Marketplace review.** How listing review scales: maintainers only, trusted community reviewers, or automated checks with a reviewed badge for the rest.
- **Package licences.** Which open licences to accept, especially for prompt text (MIT, Apache-2.0, CC BY 4.0).
- **Routines.** Posting without per-item approval, X API access, third-party triggers and waking from sleep: see [ROUTINES.md](ROUTINES.md#open-questions).
- **Recall.** Full-text search can miss notes and memories phrased differently from the question. Decide when to add embeddings from the local runtime.
- **Multi-user.** Whether shared boards for small teams are in scope, and if so whether sync is a self-hosted server or peer-to-peer.
