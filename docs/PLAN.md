# Buildout plan

This is the technical plan for clanks: what the pieces are, how they talk to each other, and the order to build them in. The [roadmap](ROADMAP.md) is the user-facing view of the same work.

## Principles

- **A real team, not a swarm.** Clanks have roles, hand work to each other in a defined order, and push back when what they were handed is wrong. The workflow is explicit and visible on the board.
- **Projects are the unit.** Everything (repo, team, spec, board, memory, budget) belongs to a project. The home screen is where you create or pick one.
- **Local first.** The app works fully offline with a local model. No clanks account, no clanks server.
- **Your keys, your infra.** Credentials live in the OS keychain and go straight to the provider. Sandboxes run on your Docker or your Kubernetes cluster.
- **Chat first, board second.** You can talk to any clank about anything it has done. The board is a live view of shared state, not a separate workflow.
- **Human in the loop by default.** You approve the spec and merge the PRs. Anything else outbound waits for approval unless you relax it.
- **Everything is logged.** Every model call, tool call, hand-off and bounce is recorded with inputs, outputs, tokens and cost.
- **One language.** TypeScript across the app, orchestrator and worker runtime, so types are shared end to end.

## The team

The clanks below are the premade list. Each project's team is chosen when the project is created: Atlas is always on it, and every other clank (BA, Designer, Engineer and QA included) is optional. A team of just Atlas is valid: Atlas answers in chat and does small tasks itself in the in-process runner. More clanks can be added at any time, from the premade list or as custom clanks. Every clank is configurable per project (prompt, model, tools, permissions, place in the workflow).

| Clank | Role | Inputs | Outputs | Runs |
| --- | --- | --- | --- | --- |
| Atlas | Lead | Your requests, the spec, PRs and QA reports | Plan, tickets, assignments, final sign-off | In-process |
| Scribe | Business Analyst | Your request, Atlas's notes, bounce reasons | Spec: stories, acceptance criteria, non-goals, open questions | In-process |
| Prism | Designer | Spec stories with UI | Flows, wireframes (HTML previews), design tokens and component specs | Sandbox |
| Forge | Engineer | A ticket, its acceptance criteria, design specs | Branch, commits, tests, pull request | Sandbox |
| Gauge | QA | A PR and its ticket's acceptance criteria | QA report with pass/fail per criterion and evidence | Sandbox |
| Scout | Researcher | A question | Research note with sources | Sandbox |
| Quill | Writer | A ticket | Docs, blog posts, release notes, copy, emails | Sandbox |
| Buzz | Marketing | Your goals, the brief | Positioning, campaign plans, channel strategy, social posts, calendars | In-process |

### Custom clanks and the library

A custom clank is defined by a name, avatar, role prompt, model, tool allowlist, permission policy and an optional workflow slot (a stage it owns in ticket routes, and which roles it may bounce to). Premade and custom clanks live in a local **clank library**. Adding a clank to a project copies the template into the project, so editing it in one project doesn't change another; you can save changes back to the library explicitly.

Atlas plans with whatever team the project has. If a ticket needs a role the team lacks (for example UI work with no Prism), Atlas either routes around it (Forge builds from the spec alone) or asks you whether to add that clank.

"In-process" clanks run in the orchestrator because they only need the model and the project's data. "Sandbox" clanks need a filesystem, a shell or a browser, so each run gets its own container.

## The team workflow

```
                 ┌──────────── you ────────────┐
                 ▼                             │ approve spec / merge PR
  Request ──► Atlas + Scribe ──► Spec ──► Atlas: tickets ──► Prism (UI only) ──► Forge ──► Gauge ──► Atlas sign-off ──► You
                   ▲    ▲                                        ▲              ▲  │        │  │            │
                   │    └──────── spec gap / unclear AC ─────────┴──────────────┘  │        │  │            │
                   │                                                    bug / failed AC ◄───┘  │            │
                   └─────────────────────────────── anything ◄─────────────────────────────────┴────────────┘
```

### Stages

1. **Intake.** You talk to Atlas. Small asks are answered in chat. When the request is a project, Atlas asks clarifying questions and brings in Scribe.
2. **Spec.** Scribe drafts the spec; Atlas reviews it for scope, order and feasibility (asking Scout if facts are needed). The spec goes to you to approve, edit or send back. Specs are versioned; nothing is built from an unapproved version.
3. **Plan.** Atlas splits the approved spec into tickets. Each ticket links to the stories and acceptance criteria (AC) it covers, lists dependencies and gets a route: which roles it passes through (for example `design → build → qa → lead`, or `build → qa → lead` for non-UI work).
4. **Design.** Prism takes UI tickets first and attaches flows, wireframes and component specs. Design tokens and shared components are committed to the repo so Forge builds from them.
5. **Build.** Forge implements the ticket on its own branch with tests, runs the project's checks, and opens a PR that references the ticket and its AC.
6. **QA.** Gauge checks out the PR in a fresh sandbox, runs the build and test suite, and validates each AC with evidence (test output, screenshots from browser checks). The result is a QA report on the ticket.
7. **Sign-off.** Atlas reviews the PR, the QA report and the spec together, and checks the change fits the rest of the project. Approved tickets go to you with the PR ready to merge.
8. **Done.** You merge. CI status and merge state come back from GitHub.

### Non-software projects

The same workflow runs without a repo. The spec becomes a **brief** (goals, audience, messages, deliverables, success measures), written by Atlas with whichever planning clank the team has (Scribe, Buzz or Scout) and approved by you. Tickets route through the clanks the project has, and Atlas's sign-off checks each deliverable against the brief instead of a PR against the spec. Outputs are files in the project folder (Markdown, images, HTML mock-ups, CSV calendars), and anything outbound (publishing, sending) waits for your approval.

Example, **Scavr.io marketing** with Atlas, Quill, Prism and Buzz: Atlas and Buzz write the launch brief; tickets go to Quill (blog post, launch email), Prism (social graphics, landing page mock-ups) and Buzz (campaign calendar, posts); Atlas reviews each against the brief and bounces off-message work back with a reason.

### Bounce-backs

Any clank can return a ticket to an earlier owner instead of passing it on. A bounce has a target role, a category and a reason, and it is recorded on the ticket.

| From | Typical bounce | To |
| --- | --- | --- |
| Prism, Forge | AC is ambiguous, contradictory or missing a case | Scribe (spec change, then Atlas re-checks affected tickets) |
| Forge | Design can't be built as specified | Prism |
| Gauge | Build broken, test failing, AC not met | Forge, with the QA report |
| Gauge | AC itself is untestable or wrong | Scribe |
| Atlas | Anything | Any role |

Rules:

- A spec change from a bounce creates a new spec version. Atlas finds every ticket linked to the changed AC and marks it for re-check.
- Each ticket has a bounce limit (default 3 per stage pair). Hitting it escalates to you in chat with the full history, rather than letting clanks loop.
- A bounce never discards work: the branch, reports and notes stay on the ticket for the next owner.

### Talking to any clank

Every clank is reachable from the project's chat sidebar. Asking "why did you choose Stripe Checkout?" or "why did this fail QA?" is answered from that clank's own project context (below), with links to the tickets, commits and reports it cites. A clank you talk to can also act: you can ask Scribe to add an AC, and that goes through the normal spec flow.

## Projects and the home screen

The app opens on the home screen: recent projects as cards with their status (spec in review, N tickets in progress, PRs waiting for you), plus "New project".

New project wizard:

1. **Basics.** Name, one-line description, optional template.
2. **Workspace.** For software projects, sign in with GitHub, then pick an existing repo or create a new one (public or private, with a default branch); the repo is cloned locally as the workspace. For other projects (marketing, research, content), pick a local folder; it is git-initialised so every output is versioned.
3. **Models.** A default model for the team, with per-clank overrides (for example a frontier model for Atlas and Scribe, a fast model for Forge, a local model for Gauge). Each choice is checked against the providers you configured.
4. **Team.** Tick the clanks you need from the premade list (Atlas is always included), optionally starting from a preset ("Full team", "Solo engineer"). "New clank" creates a custom one with its own prompt. The team can be changed later from the project's team settings.

After creation you land in the project's chat with Atlas.

## Per-project context

Each clank keeps separate context for each project, so a Forge in one project knows nothing about another.

- **Conversations** between you and that clank in that project.
- **Notes**: a small key-value and document store the clank writes to (conventions it learned, things you told it, open questions).
- **Decision log**: structured entries (`decision`, `reason`, `alternatives`, `links`) written when a clank makes a non-obvious call. This is what answers "why".
- **Shared project knowledge** every clank can read: the current spec, design tokens, the repo's README and conventions, and the board.

When a clank starts a run, its context is assembled from: its role prompt, the shared project knowledge relevant to the ticket, its own notes and recent decisions, and the ticket with its history (including bounce reasons). Long histories are summarised and the summaries stored, so context stays small and runs can resume after a restart.

## Architecture

```
┌──────────────────────────── Desktop app (Electron) ────────────────────────────┐
│                                                                                │
│  Renderer (React)                    Main process (Node)                       │
│  ┌──────────────┐   typed IPC   ┌───────────────────────────────────────────┐ │
│  │ Home         │◄────────────► │ Orchestrator                              │ │
│  │ Chat         │               │  ├─ Project service (repo, team, budget)  │ │
│  │ Spec         │               │  ├─ Conversation service                  │ │
│  │ Board        │               │  ├─ Workflow engine (routes, bounces)     │ │
│  │ Ticket / PR  │               │  ├─ Scheduler                             │ │
│  │ Settings     │               │  ├─ Agent runtime (in-process clanks)     │ │
│  └──────────────┘               │  ├─ Context + memory service              │ │
│                                 │  ├─ Provider registry ──► model APIs      │ │
│                                 │  ├─ Tool registry + MCP client            │ │
│                                 │  ├─ GitHub service ──► GitHub API         │ │
│                                 │  ├─ Runner (Docker | Kubernetes)          │ │
│                                 │  └─ Store (SQLite) + Keychain             │ │
│                                 └──────────────┬────────────────────────────┘ │
└────────────────────────────────────────────────┼──────────────────────────────┘
                                                 │ worker API (HTTP + SSE, per-run token)
                        ┌────────────────────────┴───────────────────────┐
                        ▼                                                ▼
              ┌──────────────────┐                             ┌──────────────────┐
              │ Docker container │                             │ K8s Pod / Job    │
              │  worker runtime  │                             │  worker runtime  │
              │  Forge / Gauge / │                             │  Forge / Gauge / │
              │  Prism ...       │                             │  Prism ...       │
              └──────────────────┘                             └──────────────────┘
```

- The **renderer** is UI only. It never holds API keys or tokens and never calls a model or GitHub directly.
- The **orchestrator** owns all state, all model traffic and all GitHub traffic. It starts in Electron's main process and is written so it can later run as a headless daemon (Milestone 6) with the desktop app as a client over the same API.
- The **workflow engine** is the only code allowed to move a ticket between stages or owners. Clanks request moves through tools (`hand_off`, `bounce`, `sign_off`); the engine validates them against the ticket's route and the bounce rules.
- **Sandbox clanks** run a small Node worker runtime inside a container. It runs the agent loop and executes tools locally inside the sandbox. Model calls and GitHub calls are proxied through the orchestrator so keys and tokens never enter the sandbox and budgets are enforced in one place. Git pushes use a short-lived, branch-scoped credential.

## Repository layout

pnpm workspaces with Turborepo.

```
apps/
  desktop/            Electron app: main process bootstrap, preload, React renderer
packages/
  core/               Shared types, zod schemas, workflow state machine, event types
  orchestrator/       Project, conversation, workflow, scheduler, context, runners, store
  roles/              Default role definitions: prompts, tools, routes (Atlas, Scribe, Prism, Forge, Gauge, Scout, Quill, Buzz)
  providers/          Model provider interface and adapters
  github/             GitHub auth (device flow), repos, branches, PRs, checks
  tools/              Built-in tools, permission model, MCP client
  worker/             Worker runtime that runs inside a sandbox (published as container images)
  ui/                 Shared React components (chat, spec editor, board, ticket cards)
deploy/
  docker/             Worker images: base, engineer (node, python, ...), qa (with Playwright browsers)
  helm/               Chart for the in-cluster gateway (Milestone 6)
docs/
```

## Key decisions

| Area | Choice | Why |
| --- | --- | --- |
| Desktop shell | Electron | Mature, cross-platform, Node in the main process means the orchestrator and app share one runtime and one language. Tauri was considered; it would split the orchestrator into Rust or a sidecar. |
| UI | React, Vite, Tailwind, TanStack Query, dnd-kit for the board, a Markdown editor for specs | Matches the landing page stack and the ecosystem for chat and kanban UIs. |
| Storage | SQLite via better-sqlite3 + Drizzle | Single local file, fast, easy backups, typed schema and migrations. |
| Secrets | OS keychain (Electron `safeStorage`, keytar fallback) | Keys and GitHub tokens never touch the DB or plain-text config. |
| IPC | tRPC over Electron IPC (electron-trpc) | End-to-end types between renderer and orchestrator, and the same router can later be served over HTTP for headless mode. |
| GitHub auth | OAuth device flow first; a GitHub App later for fine-grained, per-repo access | Device flow works from a desktop app with no callback server. A GitHub App gives tighter scopes and short-lived install tokens. |
| Models | Own thin provider interface; adapters built on official SDKs | Keeps streaming, tool calls and usage reporting consistent without locking into a framework. |
| Workflow | Explicit state machine with per-ticket routes | Predictable hand-offs and bounces that can be tested and shown on the board, rather than free-form agent chatter. |
| Tools | Built-ins plus MCP | MCP gives access to the existing tool ecosystem with no custom glue. |
| QA checks | Project test suite plus Playwright in the QA image | Lets Gauge validate AC with real browser evidence (screenshots, traces). |
| Sandboxes | Docker (dockerode) first, Kubernetes (@kubernetes/client-node) second | Docker is what most users have locally; K8s is the scale-out path the product promises. |
| Validation | zod everywhere at boundaries | Model output, IPC payloads and worker events are all untrusted input. |

## Data model

Stored in SQLite. Simplified:

- **provider**: id, kind (`anthropic`, `openai`, `openai_compatible`, ...), base URL, keychain reference, enabled models.
- **github_account**: id, login, keychain reference for the token.
- **project**: id, name, description, kind (`software`, `general`), repo (owner/name, default branch; optional), local workspace path, team preset, status, budget.
- **clank_template**: id, source (`premade`, `custom`), role, name, avatar, prompt, default model, tools, permission policy, workflow slot. The clank library.
- **clank**: id, project, template (optional), role, name, avatar, system prompt, provider + model, tool allowlist, permission policy, budget.
- **conversation**: id, project, clank, title. **message**: id, conversation, role, content parts (text, tool call, tool result, attachment), tokens, cost.
- **spec**: id, project, current version. **spec_version**: id, spec, number, body, status (`draft`, `in_review`, `approved`, `superseded`), author clank, approved at.
- **story**: id, spec_version, title, description. **acceptance_criterion**: id, story, text, stable key (`AC-12`).
- **ticket**: id, project, key (`CLK-101`), title, description, route (ordered roles), current stage, current owner clank, priority, branch, PR number.
- **ticket_ac**: ticket, acceptance criterion. **ticket_dependency**: ticket, depends on.
- **handoff**: id, ticket, from clank, to clank, kind (`forward`, `bounce`, `sign_off`, `escalate`), category, reason, created at.
- **run**: id, ticket, clank, runner (`inprocess`, `docker`, `k8s`), sandbox id, status, started/ended, tokens, cost.
- **qa_report**: id, ticket, run, PR head SHA, result per AC (pass, fail, blocked) with evidence links.
- **clank_note**: id, clank, key, body, updated at. **decision**: id, clank, ticket (optional), decision, reason, alternatives, links.
- **event**: id, project, run or conversation, type, payload, timestamp. Append-only; the activity log and the live board are both built from it.
- **artifact**: id, ticket, run, kind (`file`, `wireframe`, `screenshot`, `report`, `doc`), location, version.
- **approval**: id, project, run, action, payload, status, decided at.

## Ticket lifecycle

Board columns map to stages:

```
Backlog ─► Spec ─► Design ─► Build ─► QA ─► Lead review ─► Ready to merge ─► Done
                     ▲         ▲       │         │
                     └─────────┴───────┴─────────┘   bounces (with reason)
                                    Escalated (to you, after the bounce limit)
```

- A ticket enters its first route stage when its dependencies are Done and its spec version is approved. Non-UI tickets skip Design.
- The scheduler claims tickets for each role up to that role's concurrency (for example 3 Forges, 1 Gauge) and the project's budget.
- A run ends in one of: hand-off forward, bounce, ask the user (ticket shows "Waiting on you"), failure (retried up to a limit), or budget pause.
- When a ticket is bounced to Build, Forge resumes on the same branch with the QA report or reason in context.
- Ready to merge means Atlas signed off; you merge on GitHub or from the app. Merging moves the ticket to Done and unblocks dependents.

## Agent runtime

One loop shared by all clanks:

1. Assemble context (see Per-project context) and tool definitions for the role.
2. Call the model through the provider registry with streaming.
3. For each tool call: check the permission policy (allow, ask, deny). "Ask" creates an approval and suspends the run until you answer.
4. Execute the tool, record the event, feed the result back.
5. Repeat until the clank calls a terminal tool: `hand_off`, `bounce`, `sign_off`, `ask_user` or `fail`.

Role-specific tools:

- **Atlas:** `create_ticket`, `link_ac`, `set_route`, `assign`, `request_spec_change`, `sign_off`, `bounce`.
- **Scribe:** `write_spec`, `add_story`, `add_ac`, `submit_spec_for_review`.
- **Prism:** `write_wireframe` (HTML rendered in the app), `update_design_tokens`, `attach_design`.
- **Forge:** files, shell, git, `open_pr`, `run_checks`.
- **Gauge:** shell, `checkout_pr`, `run_tests`, `browser_check` (Playwright), `submit_qa_report`.
- **All:** `read_spec`, `read_ticket`, `note`, `log_decision`, `ask_clank` (a question to another clank in the same project, answered from its context).

## Providers

```ts
interface Provider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>; // text deltas, tool calls, usage
  capabilities(model: string): { tools: boolean; vision: boolean; contextWindow: number };
}
```

Adapters, in order: Anthropic, OpenAI, OpenAI-compatible (Ollama, vLLM, LM Studio, OpenRouter, llama.cpp server), Google. Models without native tool calling get a JSON-mode fallback so local models still work. Vision support matters for Prism and Gauge (reading screenshots); the wizard warns when a vision-less model is picked for them. Pricing tables live in config so cost tracking works per model.

## GitHub integration

- Sign-in with the OAuth device flow; the token is stored in the keychain.
- Repo picker lists repos the account can push to, and can create a new repo.
- Each ticket gets a branch (`clanks/CLK-101-booking-calendar`). Forge pushes via the orchestrator; Gauge and Atlas read the PR, diff and check runs.
- PR bodies link the ticket, the AC covered and the QA report. Review comments from humans on GitHub flow back to the ticket and can bounce it to Forge.
- The merge stays with you by default. Auto-merge after Atlas sign-off and green CI is an opt-in project setting.

## Tools and permissions

- Built-ins: `fs.*`, `shell.exec`, `git.*`, `web.fetch`, `web.search`, `browser.*`, plus the role tools above.
- MCP servers can be attached per clank; their tools appear alongside built-ins.
- Every tool declares a risk level. Each clank has a policy mapping tools to allow, ask or deny, with sensible defaults (reads allowed, writes inside the workspace allowed, shell inside a sandbox allowed, anything outbound outside GitHub asked).
- Outbound integrations (push, open PR, merge, send email) are separate tools so they can be gated individually.

## Sandboxes and runners

**Docker runner (Milestone 4).** One container per run from a role image (engineer images with common toolchains, a QA image with Playwright browsers), with per-project overrides. The repo is cloned fresh at the ticket branch. Network is limited to package registries by default and widened per clank. The container gets a short-lived run token and the orchestrator's worker API URL, nothing else.

**Kubernetes runner (Milestone 6).** Each run is a Job in a namespace you choose, using your kubeconfig. Because the desktop app is usually not reachable from the cluster, a small gateway Deployment (Helm chart in `deploy/helm`) runs in-cluster; the desktop app holds an outbound connection to it and workers talk to the gateway. In headless mode the orchestrator runs in-cluster and the gateway is not needed. QA can deploy PR previews into the namespace.

**Worker API.** HTTP + server-sent events, authenticated by the per-run token: fetch ticket context, proxy model and GitHub calls, post events, request approvals, submit artifacts and reports, hand off or bounce. Workers never see provider keys, GitHub tokens or other projects.

## Security

- Keys and tokens in the OS keychain only; the renderer runs with context isolation and no Node integration.
- All model output and worker traffic is validated with zod before it touches state.
- Sandboxes run unprivileged, with no host mounts and no network beyond what the clank was granted.
- Prompt injection is assumed: content a clank reads (web pages, repo files, issues, PR comments) can never grant itself new permissions or change the workflow; approvals are decided only in the UI.
- Clanks cannot approve their own work: the workflow engine rejects a sign-off or QA pass from the clank that built the ticket.
- Budgets are enforced in the orchestrator, which is the only path to a model.

## Testing

- Unit tests (Vitest) for the workflow state machine, bounce rules, scheduler, permission policy and provider adapters.
- A fake provider that replays recorded model responses, so whole team runs (spec, build, QA, bounce, sign-off) are tested deterministically and offline.
- A fake GitHub server for branch and PR flows.
- Integration tests for the Docker runner in CI.
- Playwright tests for the Electron app's main flows: create a project, connect GitHub, approve a spec, follow a ticket to Ready to merge.

## Build order

The first steps, in the order they unblock each other:

1. Monorepo, Electron + React shell, CI with lint, typecheck and tests.
2. `core` types, the workflow state machine and the SQLite store with migrations.
3. Provider interface, Anthropic and OpenAI-compatible adapters, fake provider.
4. Home screen, new-project wizard with team picker and custom clanks, clank library, GitHub device-flow sign-in and repo picker.
5. Chat with Atlas inside a project, with per-project conversations and notes. **First demo.**
6. Tool registry, permission policy, approval prompts, activity log, local repo workspace.
7. Scribe and the spec flow, the spec view, Atlas ticket planning, the board.
8. Workflow engine with hand-offs, bounces and escalation, plus the in-process runner for fast iteration.
9. Worker runtime, worker API and Docker runner; Forge opening real PRs.
10. Gauge with QA reports and browser checks; Atlas sign-off. **Full loop demo.**
11. Prism and the design stage, decision log, custom clanks in ticket routes.
12. Kubernetes runner, headless mode, preview environments.

## Open questions

- **License.** MIT or Apache-2.0 for adoption, or AGPL to keep forks open.
- **Spec format.** Plain Markdown with structured AC blocks, or a structured editor that renders to Markdown in the repo.
- **Where specs and designs live.** Only in the app database, or also committed to the repo (for example `docs/specs/`) so they travel with the code.
- **Concurrency defaults.** How many Forges run in parallel by default, given cost and merge-conflict risk.
- **Headless mode timing.** Whether to pull the daemon forward if long-running projects are the main use case.
- **Default local model.** Which local model to recommend so the out-of-box experience is good without a cloud key.
