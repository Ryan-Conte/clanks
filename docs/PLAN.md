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
  artifacts/tickets/<ticket>/ what's kept with a ticket: its hand-in as a document, notes, pictures of sources, a file per version
  artifacts/<chat>/           a chat's or run's browser and design pictures, and files/ for what a chat outside a ticket saved
  crew/                       your clank library: edited priming docs (<id>.md), custom clanks and ones installed from a marketplace
  integrations/<id>/          integrations installed from a marketplace or added from a folder: manifest, OpenAPI document, guide
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
  design/             Design file format and schema, scene operations, tokens, markup parser, renderer, lint, exporters
  studio/             Studio editor UI: canvas, panels, prototype player, visual diff (in the desktop app for now)
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
| UI | React, Vite, Tailwind, TanStack Query, the browser's own drag and drop for the board | Matches the landing page stack and the ecosystem for chat and kanban UIs. dnd-kit was the plan for the board; the workflow decides every move a drag asks for, so native drag and drop is enough, with no extra dependency. |
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
| Exports | Electron `printToPDF`, the `docx` library, `marked` to read the Markdown | PDF and DOCX without bundling pandoc. What a clank wrote is never trusted on the way: raw HTML in it is printed as text. |
| Email | SMTP through `nodemailer`, with Gmail as a preset that takes an app password | Works with any mail account and no clanks server. Gmail's own API would need an OAuth app registered with Google, which a self-hosted app doesn't have. |
| Repository hosts | GitHub and GitLab behind one small interface: clone, push, open, merge and close a request, read its checks | Delivery doesn't care which it is. A GitLab a team hosts works the same as gitlab.com. |
| Validation | zod everywhere at boundaries | Model output, IPC payloads, tool arguments and design markup are all untrusted input. |

## Data model

Stored in SQLite. Simplified:

- **provider**: id, kind (`openai_compatible`), name, base URL, keychain reference. The model servers you added; the built-in runtime is always there, and a cloud provider (Anthropic, OpenAI, Google, OpenRouter) is on when its key is in the keychain.
- **model**: id, name and tag, source (`catalog`, `huggingface`, `ollama`), repo and file, blob digest, size, quantisation, context length, capabilities (tools, vision), licence, pulled at, keep-loaded flag.
- **clank**: id, name, avatar (a colour from the clanks.si palette), role, kind (maker or checker), workflow placement (stage, after, applies to, bounce to), priming doc (bundled, edited, custom or from the marketplace), default model, tool policy, budget. Custom clanks live in the library and can join any project.
- **integration**: id, kind (`declarative`, `mcp`), source (bundled or a marketplace package), version, enabled. As built there's no table: an integration is its files, the shipped ones beside the app and the installed ones in the app data folder, and one a marketplace revoked is off.
- **connection**: id, integration, label, auth type, keychain reference, mode (`test`, `live`), scopes, connected at. As built, also: who it's connected as, the settings the user gave that aren't secret, the hosts its credential may go to, and when an OAuth token runs out. Its credential is in the keychain under `integration:<id>`.
- **project_integration**: project, connection, clanks allowed to use it.
- **routine**, **routine_run**, **scheduled_action**: schedules, their runs, and approved actions waiting for their time. Fields are in [ROUTINES.md](ROUTINES.md#data-model).
- **package**: id, kind (`clank`, `integration`, `crew`, `routine`), index, version, sha256, publisher, licence, pinned, installed at, status (`active`, `update_available`, `revoked`). As built, also: the newest version its index has, why it was revoked, and for a crew the clanks and integrations it's made of.
- **conversation**: id, clank, title, folder (optional: its `CLANKS.md` or `AGENTS.md` is followed; a project's workspace for a chat in one), project (optional), ticket and role (`maker`, `checker`, `planner`) for a run, created/updated.
- **message** carries, besides the rest, an author: the app, for a brief or a bounce it writes to a run as the user's turn.
- **message**: id, conversation, position, role, content parts (text, tool call, tool result, attachment), reasoning, status (`streaming`, `done`, `cancelled`, `failed`), the provider and model that wrote it, tokens, speed, time, finish reason, cost.
- **project**: id, title, brief, workspace (a GitHub repo cloned locally, or a local folder), base branch, status, budget and budgets per clank, runs at once, bounce limit, optional checks per output type (the rest are required), command sandbox, held.
- **project_clank**: project, clank, model override. The project's crew; Atlas is always in it.
- **spec**: id, project, version, body, status (draft, signed off, approved), approved at. Stories and criteria are parsed out so tickets can reference them.
- **ticket**: id, project, key (`CLK-101`), title, description, story ids (optional), acceptance criteria, output type (`spec`, `design`, `pr`, `copy`, `doc`, `email`, `research`, `campaign`, `other`), route (the clanks it passes through), skipped checks with reasons, current stage, column, assignee clank (empty while the ticket is open), bounce count, priority, origin (`spec`, `chat`, `board`, `routine`, `proposal`) and created by (user or clank). Also, as built: the clank answering a bounce from outside its route, the brief its next run gets while it waits for a slot, its delivery (branch, head, pull request and its checks, merge commit, last error) and its outcome (approved or rejected).
- **ticket_dependency**: ticket, depends on.
- **bounce**: id, ticket, from clank, to clank, reason, numbered issues, at.
- **run**: id, ticket, clank, worktree path, branch, base commit, command sandbox (`host`, `docker`), status, started/ended, tokens, cost, wall time.
- **checkpoint**: id, run, event, shadow commit, author (clank or user). One per tool call or user edit that changed files.
- **user_profile**: name, time zone, language, preferences, writing samples. Shared by every clank in every project.
- **context_note**: id, project, kind (`fact`, `decision`, `convention`, `glossary`, `link`), title, body, why, author, ticket, status (`provisional`, `active`, `superseded`, `dropped`), supersedes, pinned. The project context shared by the crew; see [CONTEXT.md](CONTEXT.md).
- **memory**: id, project, clank, kind (`decision`, `note`, `run_summary`), body, ticket, run, created. Indexed with FTS5. You can read, edit and delete any entry.
- **run_status**: run, state, waiting reason, live label, progress steps, updated at. Materialized from events for the live board; never edited directly.
- **event**: id, run or conversation, type, payload, timestamp. Append-only; the activity log, the live board and the workbench timeline are all built from it. Large payloads (command output, screenshots, renders) are stored by reference.
- **artifact**: id, ticket, run, kind (`spec`, `branch`, `design`, `note`, `doc`, `copy`, `email`, `campaign`, `file`, `screenshot`), location, version. As built: project, ticket (or the chat, outside one), who saved it, kind (`doc`, `copy`, `email`, `research`, `campaign`, `note`, `file`, `screenshot`), name, version, media type, size and where its file is. Specs keep their versions in **spec**, and branches and designs are in the repository, so none of those are artifacts.
- **review_comment**: id, run, anchor (file and line range, or design node and canvas position), body, status. Sent back to the clank on "Request changes". As built it's `review_note`, which also holds what the user changed by hand: a rejected hunk, an edit in the diff editor, or their edits to a design in Studio, summed up in one note.
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

### In Milestone 5

Projects, specs and the board, as built. Tickets other than specs wait in the backlog until the workflow engine runs them (Milestone 6).

- **Projects.** A name, a brief, the letters ticket keys start with (suggested from the name: Surf shop is `SURF`), a workspace, a crew and models. A local folder that isn't a repository yet is made one, with what's in it committed, since the crew works on copies made with git. A GitHub repository is listed, or made with a first commit, and cloned into a new folder (`~/clanks/<repo>` unless you pick another). Signing in to GitHub takes a token you paste, kept in the keychain; signing in with a code on github.com works when the build has an OAuth app (`CLANKS_GITHUB_CLIENT_ID`). A clone gets the token through git's environment for that one command, so it's never written to disk.
- **Models.** A clank runs on its model in the project, else the project's model for the crew, else its own, else the app's crew model. Only the project's crew can chat in it; Atlas is always in.
- **Chats in a project** are about its workspace, follow its `CLANKS.md`, and get board and spec tools as each clank's doc allows: Atlas can list, read, create, update, link and assign tickets, so it answers "what's the status?" from the board. A ticket a maker files is a proposal until Atlas or you take it on.
- **Runs are conversations.** Each clank working a ticket has a run: a conversation the app writes to, with the ticket in its run context and, in its worktree, a branch named for the ticket (`clanks/SURF-1` for its maker, `clanks/SURF-1-atlas` for a checker). You can read a run, answer it and steer it like any chat; the app's briefs show as the app's. A run ends with a finishing call: `submit_output` for its maker, `review_pass` for a checker, or `ticket_bounce`, `ask_user` or `fail`. A run that stops with a plain reply is reminded twice, then stops as failed, and **Carry on** starts it again. `ask_user` pauses the run; your answer in it, or a click on one of its options, carries it on. After a restart, runs that were working are paused.
- **The spec flow.** Atlas talks the idea through, then creates a `spec` ticket for Scribe, which starts straight away (one spec ticket at a time per project). Scribe saves drafts with `spec_write`; each is parsed for stories (`### US-4 …`), criteria (`- AC-4.1: …`) and edge cases, and Scribe is told what's missing. `submit_output` is refused while a story has no criteria. Atlas checks the draft and passes it or sends it back with numbered issues, which restarts it with Scribe. A ticket sent back more than three times comes to you. Signed off, it waits for you on the board and the Spec tab: **Approve** makes the draft spec v1 (v2, v3 for later ones), and **Request changes** sends your words to Scribe, without counting as a bounce. Approving starts Atlas planning in a run of its own, told which stories are new or changed: it creates the tickets, with the stories' criteria copied in unless it gives its own, and the dependencies between them.
- **The board** shows Backlog, Build, QA + review, Ready for you and Done (collapsed), with the crew strip, **Needs you** (sign-offs, questions, approvals, failed or paused runs, proposals), a card per ticket with its status in words, progress from `post_progress` and a live line from the run's latest tool call, and the activity feed. Dragging puts the backlog in order and drops a card on a clank to reassign it; any other drag asks the workflow, which says why not. **+** adds a card. The ticket drawer has the route, the maker, stories, criteria, dependencies, what was handed in, checkers' passes, bounces, the chats and runs, and the ticket's feed lines.
- **The Spec tab** shows each version as written, live while Scribe writes, the draft's parse problems, and a diff against the version before.

### In Milestone 6

The crew works the board, as built.

- **The scheduler** starts backlog tickets whose dependencies are done and that aren't proposals, specs first, then in backlog order, and hands tickets on along their routes, work in hand before new work. A run needs a free run in the project (three at once unless the project says), room in the project's and its clank's budgets, and a free slot on its model: a built-in model has as many slots as it loads with, and one that won't fit beside busy models waits. A ticket that can't start yet says why, such as "Waiting for gemma4:26b: its 2 slots are busy". An open ticket goes to the free maker of its type that made what it depends on, then the least busy one, and one clank can work several tickets at once (Forge ×2). **Hold new work** stops new starts in a project. After a restart, tickets waiting their turn still wait, and runs that were working are paused.
- **Routes and checks.** A ticket goes from its maker through the checkers for its type, then Atlas, then you. Each project says which checks are required on each type; Atlas's sign-off always is. An optional check can be skipped on one ticket, with a reason shown on its card: by Atlas, with `skip_checks` on `board_create_ticket` or `board_update_ticket`, or by you in the ticket drawer.
- **Bounces.** A bounce to a clank earlier on the route restarts the route from there. A bounce to a clank outside it, such as Forge or Gauge asking Scribe about the spec, is a detour: that clank answers in a run of its own and hands its answer back with `submit_output`, and the ticket returns to the clank that asked. Each project sets how many bounces a ticket takes before it comes to you (three unless it says).
- **Branches.** A maker's worktree starts from the project's base branch: the one its folder has checked out unless the project picks one, or GitHub's copy when that's further on. Handing in commits whatever the maker left, as the maker. A checker gets a worktree of the maker's branch that follows each hand-in, so it checks exactly what was handed in, and `git_diff` against `base` shows the whole change.
- **Pull requests.** On a GitHub project the app pushes the maker's branch (`clanks/<key>`, never with force, never anything else) and opens its pull request, or brings it up to date, when the maker hands in. Its checks are read from GitHub every few minutes and show on the card. A push that fails says why on the ticket, with **Push again**.
- **Approving merges.** **Approve and merge** merges the pull request on GitHub, as you, or the branch into the base in the project's folder, with a merge commit made in a scratch worktree. Your checkout of the base is fast-forwarded to it, which git refuses rather than overwrite changes you haven't committed. A conflict leaves the ticket with you; **Send back to resolve the conflicts** merges the base into the maker's branch, conflicts and all, and sends it back to the maker. A pull request you merge on GitHub finishes its ticket. **Reject** ends a ticket unmerged, closes its pull request and drops the notes the crew wrote on it.
- **Runs side by side.** Each ticket's run gets a port of its own for any server it starts (in `$PORT`, and its prompt says so), since another run may be serving on the usual one. Servers a run leaves going stop when it hands the ticket on. A `shell_exec` command that puts something in the background stops it when it ends, and the clank is told to use `shell_start` instead; on Windows the whole process tree goes, launchers such as `npx` and `cmd` included, even when the app is quitting. A run that runs out of room while thinking, before calling anything, is asked to decide, rather than failing the ticket.
- **Steering.** Giving a ticket its maker is working on to another maker stops the run, commits what was left to its branch, and the new maker carries on from there. Dragging a card from Build back to Backlog stops its run, after you confirm; from Backlog to Build starts it now, if it can start. **Pause** stops a run where it is, and **Carry on** picks it up.
- **Approvals.** A tool a clank's policy asks about asks only before risky calls, unless Settings → Approvals says every call. Each call is checked: everyday work in the clank's worktree runs without asking, such as builds, tests, installing the project's packages, reading pages and clicking on a local dev server. Pushing, switching branches, deleting or writing outside the worktree, global installs, publishing, deploying, sending data to other sites, running as an administrator, reading files that hold secrets and piping a download into a shell all ask, and the approval says why. MCP tools always ask. "Always allow" rules work as before.
- **Project context and clank memory.** Notes the crew shares, searched with SQLite FTS5: `context_search` and `context_write`. A clank's note is provisional, though the crew sees it straight away, until its ticket is approved; it's dropped if the ticket is rejected, and a newer note can supersede it. A note that looks like it holds a secret is refused. Pinned notes and those relevant to the work go into the project context layer. Each clank's memory holds the decisions it records with `memory_write`, a summary of each of its finishing calls and one entry per chat; `memory_search` searches its own, and Atlas can search the memory of a clank on a ticket it's signing off. The memory layer goes into the prompt after the project context, and both layers' budgets scale with the model's context window.
- **The Context tab** has the notes (add, edit, pin, keep, drop, and their history), an editor for `CLANKS.md`, each clank's memory to read, edit and delete, and **Preview**: exactly what a clank is told on any ticket, or in a chat in the project, layer by layer with token counts.
- **Budgets** per project and per clank, in tokens, minutes of model time or dollars. Spending is counted from replies' usage; dollars from the prices per million tokens you set for each cloud provider in Settings, with local models free and calls without a price counted apart. A run checks before each round and pauses with "Paused: budget", and the scheduler starts nothing that would spend more.
- **Docker.** A project can run the crew's commands in Docker: a container per run from an image (`node:22-bookworm` unless the project says), with only its worktree mounted at `/work` and no network unless the project allows it. Commands go through `docker exec` and are stopped inside the container too. Without Docker running, a command fails saying so, rather than running on the computer.
- **The live board** shows waiting, budget, holding and answering a bounce on its cards, the pull request and its checks, and skipped checks; **Watch** on a card (or W) opens its run with the workbench following it; the **By clank** view has a lane per clank with a row per parallel run, its queue and what it finished today. The drawer adds the branch and pull request, checks to skip or put back, what the ticket cost, and the actions above. The header has a budget meter. A run's header lists the project's other runs going, to switch between.
- **Home** has what needs you and who's working now across projects, what's coming up (tickets waiting for a slot), the machine (loaded models, slots in use, speed, memory and runs waiting for a model), today's spending by project, and the projects.
- Not yet: routines in Coming up, CI status for local folders, and the Schedule view.

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
8. Design, for a design ticket and for a ticket that depends on one: `design/DESIGN.md`, the tokens and the relevant frames as text.
9. Run context: the mode and, for a ticket, its key, title, description, stories, acceptance criteria, output type, dependency outputs and bounce history, plus the routine, run date and due time for tickets a routine created.

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
| Shell | `shell_exec`, `shell_start`, `shell_output`, `shell_stop` | Ask, with "always allow this command in this project". With approvals on risky calls only, the default, only risky commands ask. |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit` | Allowed, on the run's own branch. There are no push, merge or branch-switching tools. |
| Web | `web_search`, `web_fetch` | Ask, except for Scout. |
| Browser | `browser_open`, `browser_navigate`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_screenshot`, `browser_styles`, `browser_save_image`, `browser_console`, `browser_back`, `browser_close` | Per clank. |
| Design | `design_read`, `design_create`, `design_update`, `design_delete`, `design_tokens_set`, `design_make_component`, `design_link`, `design_render`, `design_lint` | Prism has all of them. Forge and Gauge get `design_read` and `design_render`; Atlas, Scribe, Quill and Buzz get `design_read`. |
| Board | `board_list`, `board_get_ticket`, `board_create_ticket`, `board_update_ticket`, `board_link_dependency`, `board_assign` | Atlas. Makers get `board_create_ticket`, which files a proposal for Atlas; Scribe gets `board_update_ticket` to fix criteria. |
| Spec | `spec_read`, `spec_write` | Most clanks read the approved spec; Scribe writes drafts. |
| Review | `review_pass` | Checkers: Gauge, Atlas and custom checkers. |
| Crew | `post_progress`, `ask_clank`, `ask_user`, `submit_output`, `fail`, `ticket_bounce` | Every clank. `ticket_bounce` reaches only the clanks in its `bounce_to`. |
| Context and memory | `context_search`, `context_write`, `memory_search`, `memory_write` | Every clank. The project context is shared by the crew; memory is the clank's own. Atlas can search the memory of a clank whose ticket it signs off. |
| Artifacts | `artifact_save`, `artifact_read` | Allowed. They reach only what's kept with the run's own ticket, or chat. |
| Routines | `routine_list`, `routine_get`, `routine_propose` | Atlas and Buzz. `routine_propose` only drafts; you activate. |
| Integrations | `int_<integration>_<operation>`, generated from each connected integration | By risk level: read allowed, write asks, outbound asks every time. Granted per project and per clank. |

- Tool names are `snake_case` with a group prefix because provider APIs reject dots in tool names.
- MCP servers can be attached per clank. Their tools appear alongside the built-ins with an `mcp_<server>_` prefix.
- Every tool declares a short live label for the board ("Running `npm test`", "Editing `src/cart.ts`"), with redaction rules for commands and URLs. `post_progress` takes an optional list of plan steps, which cards show as progress.
- Every tool declares a risk level. Each clank has a policy mapping tools to allow, ask, deny or off. Defaults come from the clank's priming doc; Settings override them. Approval prompts can widen a rule to a command or a host for the whole project.
- Outbound actions are not tools. Clanks can't push, open PRs, merge, post or send. The orchestrator pushes Forge's branch and opens its pull request when Forge submits on a connected repo, and does everything else only when you approve, so no model output, injected or not, can trigger them. Integration operations that spend money, publish or contact people are tools, but locked to asking every time.
- `web_search` uses a backend you configure: a self-hosted SearXNG, or a Brave or Tavily key. Without one it searches DuckDuckGo's plain HTML results in a tab of the built-in browser, where you can watch it, and falls back to the page as text when it can't pick the results out.
- `web_fetch` reads a page as text from its HTML. A page that's empty until its scripts run is read in the same browser tab instead, for any clank, with or without browser tools of its own; either way the result leads with what the page says of itself in its head.

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

### In Milestone 9

Integrations and the marketplace, as built.

- **Where it lives.** `packages/integrations` is the runtime: the manifest format, reading an OpenAPI document, operations as tools, signing and sending requests, OAuth, and trimming and redacting what comes back. `packages/marketplace` is the format and the client: the index, fetching and verifying a package, building an index from a folder, and the scan before publishing. The orchestrator's integration service holds what's installed, the accounts and which projects use them; its marketplace service previews, installs, updates and publishes. First-party integrations are in `integrations/` and ship beside the main bundle.
- **An integration** is a folder of three files with fixed names: `manifest.yaml`, `openapi.yaml` and `guide.md`. The manifest is as above, with these added as built: `server` (where the API is, when it isn't the OpenAPI document's first server, with `{setting}` filled in from `settings` the user gives when connecting, such as a shop's name); `headers` sent with every call, such as an API version, never `Authorization`, `Cookie` or `Host`; `check`, a read operation that proves a credential works, and `account`, where its response names the account; `response`, for a service that answers 200 to a call it turned down; and per operation `test`, its risk on a test-mode connection when that's gentler. A path in the OpenAPI document may name a server of its own, for a service spread over two hosts. Bodies are JSON or form-encoded. Headers and cookies are never arguments. Hosts are public names over https: no addresses, no ports, nothing on this computer.
- **Tools.** `int_<integration>_<operation>`. An operation's path and query parameters and its body's fields become one flat set of arguments, which small models fill in more reliably than a nested body; the body stays one `body` argument when a field would clash with a parameter. `$ref`s are followed, and cut off where a schema refers to itself. Arguments are read the ways small models write them: an object as JSON in a string, a number as text, a value wrapped as `{"value": …}`. An unknown or missing argument is turned back naming the ones the tool takes. Path values are escaped, so an argument can't reach another path. A form body is written with brackets (`line_items[0][price]`), as Stripe takes it.
- **Requests.** The orchestrator builds the request, reads the credential from the keychain, signs it and sends it, only to a host the manifest declares and the user agreed to. A public name that resolves to this computer or the local network is refused before anything is sent. A redirect is followed only for a GET, only to another declared host, and loses the credential when it leaves the host it was signed for. A response is read up to 2 MB and cut down for the model: long lists and strings shortened, empty values dropped, and any field named like a credential (`client_secret`, `token`) hidden. Every copy of the connection's own credential is taken out of results, errors and the activity log. A call the service turned down says what the service said. A change that got no answer says it may or may not have happened, and names the operation's `verify` to check with.
- **Risk.** `read` runs without asking. `write` asks, with "always allow in this project" on offer, and can be set to allow on a clank's profile. `outbound` asks every time: it's never offered an "always allow", no rule or setting lets one through, and on a clank's profile it can be denied or turned off but not allowed. In live mode every write is outbound. In test mode an operation may say it's gentler (`test: write`): a Stripe charge or refund moves no money there, so it asks like any other write. This is finer than the table above, which made a charge outbound in either mode; without it, checking a checkout against test payments would stop at every call. A quick answer to another clank (`ask_clank`) gets no integration tools.
- **Modes.** An integration whose credentials show their mode (Stripe's `sk_test_` and `sk_live_`) has it read from the key, and a key that's neither is refused before it leaves the computer. For the rest the user says when connecting, and an account is the real one unless they say it's a test. The mode is on the approval card with the account, the host and the exact request; on every ticket whose route has a clank that can use the service; in the project's settings; and in what the clank is told.
- **Connecting.** Settings → Integrations lists every integration with its hosts, operations and guide. A key, or a user name and password, is checked against the service with the integration's `check` before anything is saved, then kept in the keychain; the window can connect, check and disconnect an account, never read its key back. OAuth uses PKCE: the sign-in page opens in the system browser and hands its code to a listener on 127.0.0.1, on a port picked for that sign-in, which answers only a request carrying that sign-in's state. Tokens go in the keychain, and an access token is renewed with its refresh token before it runs out, only at a host the account was connected for. A service with no client anyone can use, such as Google, takes the user's own client id and secret.
- **Per project and per clank.** A connection does nothing until it's turned on in a project's settings, for the clanks ticked there. A project uses one account per integration. A clank's `integrations` frontmatter says what it expects and turns nothing on.
- **In the prompt.** A clank that can use a service in a project gets the integrations layer after its own doc: the app's fixed preamble, then per service its name, mode, account, tools and the integration's guide, which is its author's text and isn't templated. The project's facts list the connected services, their modes and who can use each.
- **Integrations of your own.** **Add from a folder** takes one you wrote. Only these may call this computer (`localhost` or `127.0.0.1`, over http), for a dev server's own API. One can't take the id of an integration that ships with the app.
- **MCP integrations.** A manifest with `kind: mcp` names an npm package at one exact version with its sha512, its arguments and the environment variables it needs. Installing checks the checksum against what the npm registry serves for that version, and refuses on a mismatch. Setting it up puts its variables in the keychain and adds an MCP server whose command is `npx -y <package>@<version>`, or the same inside `docker run` from the manifest's image, with the variables passed by name. The command stays pinned: editing the server in Settings changes who gets its tools, never what runs. Its tools are MCP tools, so per clank rather than per project, asking before every call. The hosts it lists are its author's word and can't be enforced, and the app says so.
- **The starter set.** Stripe, Notion, Slack, Vercel and Google Analytics, each with a trimmed OpenAPI description written for a crew rather than the service's whole one. Shopify and Linear aren't in: both are GraphQL first, which a manifest over OpenAPI doesn't describe.
- **A marketplace's format.** A marketplace is a folder, usually a GitHub repository: `marketplace.yaml` (its name, the repository pull requests go to, and its maintainers' lists of reviewed and revoked packages) and `packages/<kind>/<id>/<version>/`, each with a `package.yaml` (kind, id, name, summary, version, publisher, licence) and the package's files under fixed names: `clank.md`; `manifest.yaml`, `openapi.yaml` and `guide.md`; or `crew.yaml`. `pnpm marketplace index <folder>` checks every package the way the app does before installing one and writes `index.json`, with a sha256 for each file and one for each version; it's what a marketplace's CI runs. `pnpm marketplace seed <folder>` starts one with Sentinel, the starter integrations and a Storefront crew.
- **Browsing.** The Marketplace page reads the indexes when it's opened: the public one (`Ryan-Conte/clanks-marketplace`, read as a static file), and any added in Settings → Marketplaces as an https address or a folder, such as a team's on a shared drive. There's no account, and nothing is sent but the request for the file. With something installed the app also reads them every few hours, for updates and revocations; with nothing installed it never does.
- **Installing.** A package's page shows what was fetched and checked against its checksums: a clank's whole doc, where it sits in the workflow, and each tool with what its doc says and what it starts at; an integration's hosts, how it signs in, every operation with its risk, its guide, its manifest and, for an MCP one, the command that will run. A file that doesn't match its checksum is never shown or used, and an index can only name the files a package of its kind is made of. Install sends the digest the page showed, and what's fetched then must match it. A clank goes into the library. An integration goes into `<app data>/integrations/<id>/`, where it stands in for one of the same id that ships with the app. A crew installs the clanks and integrations it names, and becomes a preset when starting a project.
- **Nothing raises its own permissions.** A clank from a marketplace is capped: whatever its doc allows, a tool that isn't read-only starts at ask. Read-only tools, the crew's own calls and a checker's `review_pass` are as the doc says. The user can raise any of them on its profile, and what they set survives updates. With approvals on risky calls only, a tool at ask still runs everyday work in its worktree without stopping. A marketplace clank never replaces one that ships with the app, or one of the user's own.
- **Updates.** An installed package is marked when its index has a newer version. Its page then shows what changes: new tools, tools its doc now asks more of, new hosts, new operations, operations rated less risky than before, and every file that differs as a diff in the diff editor. Accept it, or stay on the version installed, which stops the reminder. A connection keeps the hosts it was connected for: when a newer integration calls more, the account stays connected, but its credential isn't sent to the new ones until the user allows them in Settings.
- **Revoked.** A package its index has taken down is turned off, with the index's reason: an integration's tools stop being offered, and a clank can't start a reply or a run, which says why. It stays that way until it's uninstalled.
- **Publishing.** **Publish** on a custom clank's profile, or on an integration added from a folder, shows what would be sent, file by file, and what the check found. It refuses a doc the library would refuse, anything that looks like a secret, a path into a home folder, and an integration that calls this computer. It flags an email address, a phone number, the user's own name, a prompt over the 2,500 tokens small models want, and tools from servers others won't have, each of which the user ticks to go on. The licence is one of MIT, Apache-2.0, CC BY 4.0 or CC0. Confirming opens a pull request from the user's GitHub account through GitHub's API: on a fork if they can't push to the marketplace, on a branch `publish/<kind>-<id>-<version>`, holding the package's files and nothing else. The version must be newer than what's published, by the same publisher.
- Not yet: routine templates, which are listed and install with routines; a marketplace in a private GitHub repository, which would need the app to send a token to it; install counts, ratings and search beyond a filter; Shopify and Linear; making an integration in the app rather than in a folder; MCP integrations turned on per project.

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
- You watch live. A banner shows which clank is driving. **Take over** pauses the clank's browser tools (they wait until you hand back) so you can sign in, dismiss something or steer. **Hand back** resumes.
- Guard rails: per-clank site allow and deny lists checked on every navigation; `browser_type` refuses password fields; downloads are blocked unless approved; no file uploads; new windows open as tabs.
- Forge uses the same pane to preview its dev server, so you see the site being built.

In a chat (Milestone 4), the browser works whether or not the chat is about a folder, and the workbench opens on it when the clank opens a tab. Details as built:

- **One view per tab, at the pane's size.** A tab shows at the pane's own width, so what the clank reads is what you see. Tabs that aren't on screen stay on the window, hidden, so their pages keep laying out and taking input; a view off the window altogether gets no size. A hidden page draws nothing, so to picture it the view is shown for a moment with only its corner pixel inside the window.
- **Pages as text.** `browser_read` turns the accessibility tree into lines: headings, paragraphs, list items and table rows, with every element it can act on numbered, such as `[12] link "Pricing" (/pricing)`. Elements in running text stay in the sentence; elsewhere each gets its own line. A ref keeps its number for as long as the page lives. `browser_open`, `browser_navigate`, `browser_back` and any click, typing or key that leads to a new page return the page as text straight away, which saves small models a round trip. Long pages come in parts by line.
- **Acting like a person.** Clicks go to the middle of the element's visible box as real mouse events, and refuse when something else, such as a cookie banner, is on top of it. Typing replaces a field's text, picks a drop-down's option by its label, and refuses password and card fields. Page dialogs are answered for safety: alerts are closed, questions are answered Cancel, and the clank is told.
- **Pictures.** After each step the page is kept as a small JPEG in the chat's artifacts; tool cards and the activity timeline show it in the pane. `browser_screenshot` is offered only to models that can see, and a reply keeps only its newest screenshot in the conversation.
- **Take over.** While you have control, the clank's browser tools wait (up to 15 minutes, or until you stop the reply), then carry on with a note that you had the browser. You can type an address and go back, forward or reload. The site lists apply only while the clank drives, and file pickers work only for you.
- **Sessions.** A chat's tabs share an in-memory session that's cleared when the chat is deleted. **Stay signed in** on a clank's profile gives it one kept session under `browser/<clank>`, across chats and restarts, which **Sign out everywhere** clears. Pages get no permissions (camera, location, notifications and the like) and see an ordinary Chrome user agent.
- **Downloads** are stopped and wait in the pane for you. **Save to Downloads** fetches the file again into your Downloads folder; the clank is told either way, and can't open downloaded files.
- **Site lists** live on each clank's profile: only these sites, and never these. They're checked on every frame navigation, redirects included, and pop-ups the lists refuse don't open.

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

### In Milestone 7

Studio and Prism, as built.

- **Where it lives.** `packages/design` is the engine, shared by the orchestrator and the window: the file format, tokens, operations, the markup parser, the renderer, lint and the diff. Studio's own interface is in the desktop app beside the rest of the window (`apps/desktop/src/renderer/src/components/studio`), not a package of its own yet. The orchestrator's design service reads and writes the files and runs the design tools.
- **Files.** A design is `design/<name>.design`: `document.json` (the page order, the components, the prototype links and the counter new ids come from), `pages/<id>.json` and `components/<id>.json`, pretty-printed with keys in a fixed order. A project has `design/site.design` unless a tool names another. Only the files a change touches are rewritten. Ids are short and stable (`n12`, `p1`, `c4`), which is how a clank names a layer.
- **Layers.** Frame, text, rectangle, ellipse, line, image, vector, icon and instance. A frame's auto layout is a row or a column with gap, padding, align, justify and wrap; `w` and `h` are pixels, a token, `hug` or `fill`. A layer is placed by x and y on a page, in a frame without layout, or when it's marked absolute. Images are files in the project, shown as a placeholder that says what's needed until there is one; a vector is an SVG drawn as an image, so nothing in it runs; icons are Lucide's, by name. No rotation, masks, gradients as fills or blend modes yet.
- **Components.** A component has named variants (`primary/lg`), each a layer tree of its own, and properties: text, which fills the text layers bound to it, and boolean, which shows or hides the layers that name it. Making a component from a layer turns its text layers into text properties and leaves an instance where it was. An instance picks a variant and sets properties; it can be resized, and that's all it overrides. Swapping one instance for another through a property isn't in yet.
- **Tokens.** One `design/tokens.tokens.json` per project in the Design Tokens Community Group format (2025.10): colour, dimension, number, font family, font weight, duration, cubic bezier, shadow and typography, with aliases. Modes (light and dark to start) are kept in the format's `$extensions`. Values written the older, plain way (`"#0a84ff"`, `"16px"`) are read too. A name is a token or a group of tokens, never both. On the canvas and in a build a token is a CSS custom property (`{color.brand}` is `var(--color-brand)`), so an alias follows its target from mode to mode. Exports: CSS (`:root`, `[data-theme='dark']` and `prefers-color-scheme`), a Tailwind CSS v4 `@theme`, or JSON per mode, copied or saved beside the tokens.
- **Operations.** Every change is a list of operations (insert, remove, update, move, pages, components, variants, links, tokens), applied the same way in the window and in the orchestrator. Each returns its inverse, which is what undo replays. The window applies the user's edit at once and the orchestrator saves it; what comes back replaces it.
- **The renderer.** A layer becomes one element with inline styles: auto layout is flexbox, tokens are custom properties, text is the browser's. The canvas makes React elements from that description and the orchestrator makes HTML from the same one, so they can't drift. Everything a design holds is escaped. To measure or picture a frame, the app draws its HTML in a hidden, sandboxed window on a page of its own with Studio's fonts, reads every layer's box and takes the picture through the DevTools protocol. Nine open-licence variable fonts are bundled: Geist, Inter, DM Sans, Space Grotesk, Fraunces, Playfair Display, Lora, Geist Mono and JetBrains Mono. Frames off screen aren't cached as bitmaps yet; unchanged frames just aren't redrawn.
- **The design tools.** `design_read` gives the file as text, one layer per line as `[id] Type "name"` and its properties written as markup attributes, or one frame, layer or component in full, or the tokens (listed, or exported with `tokens: "css"`, `"tailwind"` or `"json"`). `design_create` takes markup (`Frame`, `Text`, `Rect`, `Ellipse`, `Line`, `Image`, `Icon`, `Vector`, `Instance`, with the names people write from habit accepted: `padding`, `bg`, `flexDirection`) and says which line and tag is wrong and what would be right. New frames go side by side on the page; a page name that's new makes the page. `design_update` and `design_delete` take ids, or a name that only one layer has. `design_tokens_set` takes values the way they're written (`"16px"`, `"bold"`, a CSS shadow, a text style as an object or as JSON in a string, which small models send). `design_make_component`, `design_link`, `design_render` and `design_lint` are as planned. A token, icon, image or component that doesn't exist is refused when it's used, with the closest that does. The wireframe tokens (`wire.bg`, `wire.surface`, `wire.fill`, `wire.line`, `wire.muted`, `wire.text`) are added the first time one is used. All of them are low-risk calls: they change files in the clank's own worktree.
- **Lint.** Values that aren't tokens, tokens that don't exist or don't fit the property, contrast below 4.5:1 (3:1 for large text) in every mode and through instances, text below 11px and body copy below 16px, lorem ipsum, layers still called "Frame", frames whose layers sit on top of each other for want of a layout, broken instances, unknown icons, missing images and images with no alt. With frames measured in the hidden window: layers and text that overflow, tap targets under 44px on frames up to 600px wide, and overlapping text. Overlapping siblings in general and detached styles aren't checked.
- **Handing a design in.** `submit_output` on a `design` ticket is refused while there's no design, no frame, or a frame uses a token, icon, image or component that isn't there. What lint still finds goes on the ticket as `lint`, for Atlas and for you. The design, tokens and `DESIGN.md` are on the ticket's branch and merge like any other work.
- **Studio in the app.** A project has a **Studio** tab, which shows the project's own design or, picked at the top, the one a clank is building on a ticket. A run's workbench has a Studio pane, which is where it opens for a designer. On the canvas: pan, zoom, fit, select, multi-select and marquee, move with snapping and guides, resize by handles, draw frames, rectangles, ellipses, lines and text, edit text in place, drag a layer to another place in its frame or into another frame, duplicate, copy and paste, group, add auto layout, bring forward and send back, and nudge with the arrows, with Figma's keys (V, F, R, O, L, T, H, C, Shift+A, Ctrl+G, Ctrl+D, Ctrl+Alt+K, Shift+1). Undo and redo. Panels: pages, components and the layer tree (rename, drag to reorder or reparent); things to insert (frame presets for screens and social formats, components, a greyscale wireframe kit, every Lucide icon, the project's images); properties with a token for every value and a mark on the ones that aren't; inspect, which shows a layer's CSS; and the tokens by group with a value per mode. Align and distribute work on layers placed by x and y. Not yet: a pen tool, boolean operations, SVG editing beyond importing one, a flow view of the prototype links, and exporting frames as PNG, SVG or PDF.
- **Working alongside a clank.** A clank's changes show on the canvas as it makes them, and **Follow** keeps the view on the frame it last changed. What you change by hand in a run's design is saved to its worktree, checkpointed, and told to the clank with your next message, or after its current round of tool calls while it's working. Until it has been told, its own change to the same property of the same layer, or its deleting a layer you changed, is turned down once and it's told why; after that the choice is its own. A design you edit after it was handed in is committed to the ticket's branch as you, so it's part of what's merged. The project's own design is edited in your checkout, and **Commit the design** commits it so the crew's next runs start from it.
- **Review.** The Review panel runs lint; compares the design with any of the run's checkpoints, listing each change down to the property (`Home / Desktop › Button fill {color.brand} → {color.text}`) and marking what changed on the canvas; shows a frame as it was and as it is, side by side or one over the other with a slider; and lists the comments pinned to the canvas (C, then click). Comments and your own edits collect in the same tray as notes from the diff editor and go to the clank the same way. The prototype player plays the links: click a linked layer to follow it, and a click that hits nothing shows what can be clicked.
- **Hand-off.** A ticket that depends on a design ticket, and every design ticket, gets a design layer in its prompt, after the clank's memory: `DESIGN.md`, the tokens with their values per mode, and the frames the design ticket handed in as text, with the components they use, within a budget that scales with the model's context. Forge and Gauge can read more with `design_read` and picture a frame with `design_render` to compare with `browser_screenshot`. A model that can't see gets the text; the picture is kept for you either way.

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

### In Milestone 8

Beyond code, as built.

- **Written hand-ins.** `doc`, `copy`, `email`, `research`, `campaign` and `other` tickets hand in words, and `submit_output` checks them against their type's contract before the ticket moves on. A document or copy needs a title and a body. An email needs a subject and a body, and every address in `to` and `cc` must be one: a guess such as "the shop" is turned back, and an empty `to` is fine. A research note must end with a numbered Sources list, cite its sources as `[1]` in the text, and cite none it doesn't list. A campaign needs its plan, and its posts as entries of their own, each with a channel and its text: a plan that leaves `posts` out is turned back, since saying the posts are drafted without drafting them is the commonest slip, while an empty list says there are none on purpose. A hand-in that breaks its contract is refused with what to fix; smaller things (placeholders left to fill, a post over its platform's limit, a source with no URL, a missing plan section) go on the ticket as warnings for Atlas and for you. Fields are read however a small model writes them: under the usual other names, lists as JSON in a string or as lines.
- **Artifacts.** Each written hand-in is kept with its ticket as one document (`doc.md`, `copy.md`, `email.txt`, `research.md`, `campaign.md`), a version for each time it's handed in, so what Quill wrote before you asked for changes is still there. `artifact_save` keeps a clank's working notes and files the same way, and `artifact_read` lists them or reads one back, any version, a long one in parts. They belong to the ticket, not the run, so Atlas reads Scout's notes at sign-off. Saving the same thing twice adds no version. Names are file names, never paths; files live in the app's data folder and go when their ticket is deleted. The ticket shows the hand-in as a card that opens to read in full, with its versions, and lists what else is kept.
- **Documents in the project.** A `doc` or `copy` hand-in that gives a `path` (a Markdown or text file inside the project, such as `docs/launch.md`) is written there in its maker's worktree and committed to the ticket's branch, so it's reviewed, pushed and merged like any other change. Without one it stays with the ticket.
- **Emails.** Quill drafts; nothing is sent by a clank, and there is no tool that sends. An email ticket that's ready shows what approving will do: **Approve and send** sends it from your account to the addresses on it, exactly as written, and records who it went to and the server's id for it; **Approve without sending** accepts it for you to send yourself. Before either you can change who it goes to, its subject and its text, which is checked like a clank's hand-in and kept as a version of yours. A send that fails leaves the ticket with you and says why. Approving twice can't send twice. The account is in Settings → Email: any SMTP server, or Gmail with an app password, checked with **Check it works**; the password is in the keychain. On a port that starts in the clear the connection must upgrade to TLS before anything is sent, and a line break in a subject can't start another header.
- **Research.** Scout's note keeps its sources as data as well as text, so the ticket lists them. Every page a run's browser shows already leaves a picture; when the note is handed in, the first picture of each cited source's page is kept with the ticket and shown beside the source. A source read only with `web_fetch` has no picture, and the ticket says so.
- **Campaigns.** Buzz hands in a plan and posts. The ticket shows each post as a card: channel, account, time, text against its platform's limit (a link counts as 23 characters on X) and its visual. A `visual` that names one of Prism's frames, in the project's design or one still being built on a ticket, shows that frame's picture; anything else shows as a description of the picture needed. Nothing is posted: approving accepts the plan and the drafts, and posting at a set time arrives with routines.
- **`ask_clank`.** One clank puts a quick question to another and waits for the answer, which comes back as the call's result. The clank asked answers in a run of its own, on the same ticket, which you can open from the ticket's chats. It gets only tools that find things out (reading files, the web, the browser, the board, the spec, notes and memory), can't ask in turn, and a call that would need your approval is turned down rather than left waiting behind another clank. It has ten minutes, stops when the reply that asked is stopped, counts against its own budget, and doesn't take one of the project's runs.
- **Custom clanks.** **Make a clank** on the crew page: a name, role and colour; maker or checker; what it makes or reviews, its stage and the stage it follows, and who it can send work back to; its tools, each allowed or asking; what its model should be good at, and a model of its own; and its prompt, from a starter in the shape the shipped docs have, or drafted by Atlas from a line about what it's for (on Atlas's model, with room to think first; a draft that comes back empty says so rather than filling the box). The form writes the same priming doc format, into `crew/<id>.md` in the app's data folder, and a whole doc can be pasted instead, starting from the template or from Sentinel. A custom doc is checked as a shipped one is: its tools are real, a checker can call `review_pass`, the prompt says how to finish and holds nothing that looks like a secret. It's then a clank like any other: its own profile, tool policies, browser settings and doc editor, which shows its size against the 2,500 tokens small models want. One whose doc stops parsing is listed with why, and left out until it's fixed. It can be deleted, with its chats, once it's out of every project's crew.
- **Custom checkers on the route.** Adding a clank to a project's crew, or taking one out, re-routes the tickets that aren't done: each takes the route the crew gives it now and stays with whoever has it, so a Sentinel added part way through checks every `pr` that hasn't reached it yet. Each project says whether its check is required, in the same place as Gauge's.
- **Exports.** A written hand-in, or any earlier version of it, saves as Markdown, a Word document (headings, lists, tables, links and code from the Markdown) or a PDF, wherever you pick. Copy keeps the lines its writer gave it, on the ticket and in an export, where Markdown would run "Headline: …" and "Button: …" together. Studio's **Export** saves a frame as a PNG at its size or twice it, a PDF of one page the frame's size, or an SVG: the frame is laid out in the hidden window and read back as it was painted, every token looked up, then drawn again as shapes, icons that keep their strokes, embedded images, and text set line by line as the browser broke it, so it opens in a vector editor as vectors. A component exports as a React component and its CSS: a branch per variant, text properties as props, booleans switching what they hide, auto layout as flexbox and every value still its token, to copy or to save as two files. Forge gets the same code with `design_read` and `code: true`. They're starting points, not finished code. Documents and frames are printed in the same hidden window Studio's frames are drawn in, so they use the fonts that ship with the app.
- **GitLab.** A project's workspace can be a GitLab repository, on gitlab.com or a GitLab a team hosts: sign in with an access token, pick or make a project, and it's cloned. From there it works as GitHub does: the app pushes the maker's `clanks/<key>` branch, opens a merge request or brings it up to date, shows its pipeline on the card, merges it when you approve and closes it when you reject. The words follow the host: `MR !12`, not `PR #12`.
- Not yet: Gmail through Google's own sign-in rather than an app password; attachments; sending to a list; a research note's sources checked by fetching them; picking a post's visual from the ticket; publishing a custom clank, which waits for the marketplace.

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

## Real-world runs

Two briefs were run end to end on `gemma4:26b`, as a user would give them: "create a Next.js site that sells surfboards, with a modern design, and work out the placeholder content", in an empty folder, and "make marketing material for the launch of scruka.com: go to the site, work out its design language, fonts and logo, and build from that". What follows is what they showed, and what the app does about each now. A small local model gets the work done when the app tells it the facts up front, checks what it hands in, and recovers from its slips instead of failing the ticket.

- **Plans.** Left to itself the model planned one build ticket per story: no setup on an empty folder, no design though Prism was in the crew, and nothing waiting on anything, so every ticket would have set up an app of its own at once. The planning brief now says what the folder and the crew mean for the plan (no code yet, so one ticket sets the app up and the rest wait on it; a designer and nothing designed, so screens are designed first). Nothing a planning run creates starts until the run is over. Its plan is then checked: several code tickets that would start together on an empty folder, a type nobody in the crew makes, or no design ticket, go back to Atlas with what to fix, twice at most. Tickets still side by side on an empty folder after that are put in order by the app.
- **An empty folder.** Forge searched the disk for a project that wasn't there, then asked for the files. A maker on a `pr` ticket in a folder with no code is told its copy starts empty and that the ticket starts the project. A run's worktree folder is lower case (`surf-2`), since npm's starters name a project after its folder and refuse capitals; the branch keeps the key.
- **Sites drawn by scripts.** `web_fetch` got nothing from a single-page site, and Atlas searched the web for the site's look for four minutes. `web_fetch` now reads such a page in the browser. `browser_styles` reads how a page looks off what the browser computed: fonts and where each is used, colours as hex by how much of the page they cover, the brand's accents (the logo's own colours among them, for a site that's otherwise grey), buttons, cards, and the logo and pictures, numbered. `browser_save_image` saves one of those into `design/assets`, where a design can show it: an inline drawing as a standalone SVG with what could run taken out, and a picture by what its bytes are, whatever its server calls it. Prism takes a brand's tokens and logo from its own site with these.
- **Going in circles.** The same call with the same result, with no file changed in between, is noted to the model the third time and not run from the fifth; a reply whose last three calls were all refused that way is stopped. Only while the earlier answer is still in the conversation whole: one cut down to make room has to be asked for again, and that's no repeat. A reply whose words start repeating is cut off and asked to decide, rather than left to fill sixteen thousand tokens. A chat reply that runs out of room having said nothing is asked once for its answer, so a chat never ends on tool calls alone.
- **Tool calls the model gets wrong.** A call written out as words in the model's own syntax (`call:name{…}`, or `<tool_call>` JSON) is made as a call. A call whose arguments aren't JSON is answered with what was wrong, and goes back to the model as a string, since a server that reads every call to lay the conversation out otherwise refuses the whole conversation from then on. A round the model's server couldn't read is asked for again, twice. A reply stops after three calls in a row that don't fit their tools, not after two anywhere in it: a long run slips now and then and puts it right.
- **Long runs.** A run on a ticket gets 120 rounds of tool calls, not a chat's 40, is told to finish up eight rounds from the end, and at the end is paused, not failed. Token counts are estimated from characters, which comes out low for markup; each reply's real count now scales the estimate, and a conversation that still doesn't fit is cut down and asked for again: old tool results first, then what the clank wrote in its own old calls, then the oldest rounds. The conversation takes at most 70% of the window, so the reply has room for its thinking and a call that holds a whole file. A call cut off for want of room is answered as that, with how to write it smaller, and the conversation gives up more room for the next.
- **Hand-ins and reviews.** A design hand-in that names a frame the design doesn't have is refused, and the frames it records are the file's, not the clank's account of them. Lint finds frames that share a name, and graphics for a feed whose biggest text is too small to read there. A checker that looks at a ticket again is told it has changed since, so it doesn't decide from what it found the first time. A campaign's maker is told which frames the project's design has, to give its posts by name. A ticket that's on the board already can't be filed again, least of all by the maker working it. What a clank lists as objects, such as each criterion with its verdict and evidence, reads as lines on the ticket and to the next clank, not as JSON.
- **Chats in a project.** A chat's copy of the project was made once, when the chat started, so hours and five merges later Atlas still saw the empty folder it began with. A chat's copy now catches up with the project's base branch at the start of each reply, for as long as the chat has made no changes or commits of its own.
- **Studio.** A project has no design of its own until its first design ticket is approved, so Studio opened on an empty canvas while the design waiting for approval sat in a menu. It opens on the ticket's design until the project has one.
- **A red build passed.** Gauge ran the build on a ticket, saw it fail, and passed the ticket, calling the failure someone else's; on the ticket before, it called the build green without running it after the change. So the merged site didn't build. A check on a `pr` ticket can't pass now when the latest run of a build or test command in that check failed: it goes back to its maker, whoever broke it. In a project with a build script, QA can't pass a ticket it hasn't built in that check either. A check the project never had, such as `npm test` with no test script, doesn't count against it.
- **Pictures that don't load.** The built shop linked product pictures that were never made, and QA passed it: a page read as text shows a picture by its description either way. A page's text now opens by saying which pictures didn't load. Forge draws placeholders it can make, as SVG files in the project.
- **Servers left running.** On Windows `next dev` outlived its run, and the app, on every ticket. The sweep meant to find a command's process tree never ran (PowerShell started with no console exits at once), and no sweep could have found it: Windows keeps no tree, only each process's parent, and the launchers Git's bash and npm run scripts through are gone before what they start is up. Commands under Git's bash now run in a job object, which holds whatever is started inside it and ends it all at once. One small PowerShell process makes the jobs for the whole app; a command waits behind a gate while its shell is put in one, so nothing starts outside it. The jobs end with that process, so quitting the app, or losing it, ends what its commands left too.
- **Several projects on one model.** A project's own runs took every slot they freed, so another project's tickets waited for as long as the first had work. When anything changes, every project now gets its turn, the one with the least going first.

Not solved: what a small model designs is plain, and the same model signing off its own crew's work passes things a person wouldn't. Code tickets planned side by side on a new app write the same files, and the later ones come back with conflicts to resolve, which works but costs a round each: only the planner saying which wait on which avoids it.

## Testing

- Unit tests (Vitest) for the state machine, scheduler, permission policy, prompt assembly and provider adapters.
- A fake provider that replays recorded model responses, so agent loops are tested deterministically and offline.
- Model manager tests against a local HTTP fixture: resume, checksum failure, cancel, disk full. A CI job pulls a tiny GGUF model and runs a real `llama-server` on CPU.
- Context: layer order and budgets, per-clank `CLANKS.md` sections, the note lifecycle, and isolation between projects and between clanks.
- Live board: event sequences to board state (bounces, restarts, crashes), live label redaction, and a replay of 500 tickets and 20 concurrent runs.
- Workflow engine: routes for every output type, custom checker placement, bounce targets, route restarts and the loop limit.
- Worktree, checkpoint and rewind tests against fixture repos.
- Integrations: every shipped integration loads; manifest validation; operations as tools, with arguments written the ways small models write them; signing with a key in a header or the query, basic auth and OAuth with PKCE; hosts, redirects and credentials kept to what was declared and agreed; redaction; sequences of calls. With a stand-in for the services and the fake provider: connecting, a key the service turns down, a clank that reads freely and asks before a change, a live account that asks every time whatever is allowed, an OAuth sign-in through the loopback listener and a token renewed, and an integration of the user's own on this computer.
- Routines: cron and time zones on a fake clock, missed runs across sleep and shutdown, and scheduled actions against a mock integration (hash checks, retries, unknown outcomes).
- Marketplace: building an index from a folder and what it leaves out; reading one from a folder or over https; a file that fails its checksum, an index that lists a file it shouldn't, and a newer format. In the orchestrator, against a marketplace in a folder: a clank previewed and installed with its permissions capped, an update's changes and the user's own settings kept, a digest that no longer matches, a package taken down, a crew, an integration standing in for a shipped one with a host it didn't have, an MCP integration pinned and checked against a stand-in npm, and publishing through a stand-in GitHub, with its fork, branch, files and pull request.
- Browser tools tested against local fixture pages in a real Electron window.
- Design engine: the file format, the operation log and its inverses, the markup parser, tokens and their exports, lint rules and the diff. The design tools and a whole design ticket, from Prism's first token to Forge's prompt, on the fake provider. Renderer screenshot tests aren't in yet.
- Outputs beyond code: each type's contract, on hand-ins written the ways small models write them; a document, an email, a research note and a campaign each through their whole ticket on the fake provider, with versions kept, a document written into the branch, an email sent once through a stand-in mail server and never twice, and sources matched to the pages a fake browser showed. `ask_clank` from question to answer, with what the clank asked was and wasn't offered. A custom checker made from a doc and from the form, joining a crew part way through a ticket.
- In the packaged app's smoke test, the integrations that ship beside the main bundle load.
- Exports: Markdown to HTML with raw HTML and script links made harmless, and to a Word file; a painted frame to SVG; a component to React and CSS. GitLab against a stand-in API and a repository on disk. In the packaged app's smoke test, a frame is painted and printed to PDF, and a document printed, in a real Electron.
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
- **Starter integrations.** Stripe, Notion, Slack, Vercel and Google Analytics ship. Shopify and Linear are GraphQL first: decide whether a manifest should describe a fixed GraphQL query, or whether they stay MCP servers.
- **Marketplace review.** How listing review scales: maintainers only, trusted community reviewers, or automated checks with a reviewed badge for the rest.
- **Package licences.** MIT, Apache-2.0, CC BY 4.0 and CC0 are accepted, the user's pick. Whether prompt text should default to a Creative Commons one is still open.
- **Routines.** Posting without per-item approval, X API access, third-party triggers and waking from sleep: see [ROUTINES.md](ROUTINES.md#open-questions).
- **Recall.** Full-text search can miss notes and memories phrased differently from the question. Decide when to add embeddings from the local runtime.
- **Multi-user.** Whether shared boards for small teams are in scope, and if so whether sync is a self-hosted server or peer-to-peer.
