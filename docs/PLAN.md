# Buildout plan

This is the technical plan for clanks: what the pieces are, how they talk to each other, and the order to build them in. The [roadmap](ROADMAP.md) is the user-facing view of the same work.

## Principles

- **Local first.** The app works fully offline with a local model. No clanks account, no clanks server.
- **Your keys, your infra.** Credentials live in the OS keychain and go straight to the provider. Workers run on your Docker or your Kubernetes cluster.
- **Chat first, board second.** Every action is reachable from chat. The board is a live view of shared state, not a separate workflow.
- **Human in the loop by default.** Anything outbound (a push, a merge, an email, a paid API spend over budget) waits for approval unless you explicitly relax it.
- **Everything is logged.** Every model call and tool call is recorded with inputs, outputs, tokens and cost, and is visible on the ticket.
- **One language.** TypeScript across the app, orchestrator and worker runtime, so types are shared end to end.

## Architecture

```
┌──────────────────────────── Desktop app (Electron) ────────────────────────────┐
│                                                                                │
│  Renderer (React)                    Main process (Node)                       │
│  ┌──────────────┐   typed IPC   ┌───────────────────────────────────────────┐ │
│  │ Chat         │◄────────────► │ Orchestrator                              │ │
│  │ Board        │               │  ├─ Conversation service                  │ │
│  │ Ticket view  │               │  ├─ Planner (lead clank)                  │ │
│  │ Settings     │               │  ├─ Scheduler + ticket state machine      │ │
│  └──────────────┘               │  ├─ Agent runtime (in-process clanks)     │ │
│                                 │  ├─ Provider registry ──► model APIs      │ │
│                                 │  ├─ Tool registry + MCP client            │ │
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
              │  + ticket tools  │                             │  + ticket tools  │
              └──────────────────┘                             └──────────────────┘
```

- The **renderer** is UI only. It never holds API keys and never calls a model directly.
- The **orchestrator** owns all state and all model traffic. It starts in Electron's main process and is written so it can later run as a headless daemon (Milestone 6) with the desktop app as a client over the same API.
- **Chat clanks** (the one you are talking to, and Atlas while planning) run in-process in the orchestrator.
- **Worker clanks** run inside a sandbox per ticket run. The worker runtime is a small Node program that runs the agent loop, executes tools locally inside the sandbox, and streams events back. Model calls are proxied through the orchestrator so keys never enter the sandbox and budgets are enforced in one place.

## Repository layout

pnpm workspaces with Turborepo.

```
apps/
  desktop/            Electron app: main process bootstrap, preload, React renderer
packages/
  core/               Shared types, zod schemas, ticket state machine, event types
  orchestrator/       Conversation service, planner, scheduler, runners, store
  providers/          Model provider interface and adapters
  tools/              Built-in tools, permission model, MCP client
  worker/             Worker runtime that runs inside a sandbox (published as a container image)
  ui/                 Shared React components (chat, board, ticket cards)
deploy/
  docker/             Worker base images
  helm/               Chart for the in-cluster gateway (Milestone 6)
docs/
```

## Key decisions

| Area | Choice | Why |
| --- | --- | --- |
| Desktop shell | Electron | Mature, cross-platform, Node in the main process means the orchestrator and app share one runtime and one language. Tauri was considered; it would split the orchestrator into Rust or a sidecar. |
| UI | React, Vite, Tailwind, TanStack Query, dnd-kit for the board | Matches the landing page stack and the ecosystem for chat and kanban UIs. |
| Storage | SQLite via better-sqlite3 + Drizzle | Single local file, fast, easy backups, typed schema and migrations. |
| Secrets | OS keychain (Electron `safeStorage`, keytar fallback) | Keys never touch the DB or plain-text config. |
| IPC | tRPC over Electron IPC (electron-trpc) | End-to-end types between renderer and orchestrator, and the same router can later be served over HTTP for headless mode. |
| Models | Own thin provider interface; adapters built on official SDKs | Keeps streaming, tool calls and usage reporting consistent without locking into a framework. |
| Tools | Built-ins plus MCP | MCP gives access to the existing tool ecosystem with no custom glue. |
| Sandboxes | Docker (dockerode) first, Kubernetes (@kubernetes/client-node) second | Docker is what most users have locally; K8s is the scale-out path the product promises. |
| Validation | zod everywhere at boundaries | Model output, IPC payloads and worker events are all untrusted input. |

## Data model

Stored in SQLite. Simplified:

- **provider**: id, kind (`anthropic`, `openai`, `openai_compatible`, ...), base URL, keychain reference, enabled models.
- **clank**: id, name, avatar, role, system prompt, provider + model, tool allowlist, permission policy, budget.
- **conversation**: id, clank, title, project (optional), created/updated.
- **message**: id, conversation, role, content parts (text, tool call, tool result, attachment), tokens, cost.
- **project**: id, title, brief, workspace path or repo, status, budget.
- **ticket**: id, project, key (`CLK-101`), title, description, acceptance criteria, output type (`mr`, `research`, `email`, `doc`, `other`), column, assignee clank, priority, created by (user or clank).
- **ticket_dependency**: ticket, depends on.
- **run**: id, ticket, clank, runner (`inprocess`, `docker`, `k8s`), sandbox id, status, started/ended, tokens, cost.
- **event**: id, run or conversation, type, payload, timestamp. Append-only; the activity log and the live board are both built from it.
- **artifact**: id, ticket, run, kind, location (file, branch, PR URL, draft id), version.
- **approval**: id, run, action, payload, status, decided by, decided at.

## Ticket lifecycle

```
Backlog ──► Ready ──► Doing ──► Review ──► Done
              ▲         │         │
              │         ▼         ▼
              └──── Blocked ◄── Changes requested
```

- A ticket becomes **Ready** when all its dependencies are Done and it has an assignee or a role.
- The **scheduler** claims Ready tickets in priority order, up to the concurrency limit per project and per runner, and starts a run.
- A run moves the ticket to **Doing**. It ends in one of: output submitted (to **Review**), blocked on a question (to **Blocked**, with the question posted to chat), failed (back to Ready with the error, up to a retry limit), or budget exhausted (paused).
- In **Review**, you approve (to **Done**, and outbound actions like merge or send happen now), request changes (back to Ready with your notes in context), or reject.
- Tickets can be configured to let Atlas review first, so you only see work the lead has already checked.

The state machine lives in `packages/core` and is the only code allowed to change a ticket's column.

## Agent runtime

One loop shared by chat clanks and workers:

1. Build context: clank system prompt, ticket or conversation, relevant artifacts, tool definitions.
2. Call the model through the provider registry with streaming.
3. For each tool call: check the permission policy (allow, ask, deny). "Ask" creates an approval and suspends the run until you answer.
4. Execute the tool, record the event, feed the result back.
5. Repeat until the clank calls a terminal tool: `submit_output`, `ask_user`, `create_ticket`, or `fail`.

Planning is a specialisation of the same loop: Atlas gets board tools (`create_ticket`, `link_dependency`, `assign`, `update_ticket`) and a planning prompt. Its first pass is a proposal you edit in chat before anything is committed to the board.

Context is kept small by giving workers the ticket, its acceptance criteria, the outputs of tickets it depends on, and nothing else. Long runs are summarised and checkpointed so they can be resumed after an app restart.

## Providers

```ts
interface Provider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>; // text deltas, tool calls, usage
  capabilities(model: string): { tools: boolean; vision: boolean; contextWindow: number };
}
```

Adapters, in order: Anthropic, OpenAI, OpenAI-compatible (Ollama, vLLM, LM Studio, OpenRouter, llama.cpp server), Google. Models without native tool calling get a JSON-mode fallback so local models still work as workers. Pricing tables live in config so cost tracking works per model.

## Tools and permissions

- Built-ins: `fs.read`, `fs.write`, `fs.list`, `shell.exec`, `git.*`, `web.fetch`, `web.search`, `board.*`, `artifact.save`.
- MCP servers can be attached per clank; their tools appear alongside built-ins.
- Every tool declares a risk level. Each clank has a policy mapping tools to allow, ask or deny, with sensible defaults (reads allowed, writes inside the workspace allowed, shell and network asked, anything outbound always asked).
- Outbound integrations (push, open PR, merge, send email) are separate tools so they can be gated individually.

## Sandboxes and runners

**Docker runner (Milestone 4).** One container per run from a worker base image (Node + git + common toolchains, with per-clank image overrides). The workspace is a volume or a fresh clone. Network is off by default and enabled per clank. The container gets a short-lived run token and the orchestrator's worker API URL, nothing else.

**Kubernetes runner (Milestone 6).** Each run is a Job in a namespace you choose, using your kubeconfig. Because the desktop app is usually not reachable from the cluster, a small gateway Deployment (Helm chart in `deploy/helm`) runs in-cluster; the desktop app holds an outbound connection to it and workers talk to the gateway. In headless mode the orchestrator runs in-cluster and the gateway is not needed.

**Worker API.** HTTP + server-sent events, authenticated by the per-run token: fetch ticket context, proxy model calls, post events, request approvals, submit artifacts. Workers never see provider keys or other tickets.

## Outputs

| Output type | Delivered as | Approval step |
| --- | --- | --- |
| MR | Branch pushed and PR/MR opened via GitHub or GitLab API; CI status mirrored on the ticket | Merge |
| Research | Markdown note with sources, rendered in the ticket | Accept |
| Doc | Markdown, exported to DOCX/PDF (pandoc in the worker image) | Accept |
| Email | Draft stored in the app | Send, via your SMTP or Gmail connection |
| Other | Files saved as artifacts | Accept |

## Security

- Keys in the OS keychain only; the renderer runs with context isolation and no Node integration.
- All model output and worker traffic is validated with zod before it touches state.
- Sandboxes run unprivileged, with no host mounts beyond the workspace and no network unless granted.
- Prompt injection is assumed: content a worker reads (web pages, repo files, emails) can never grant itself new permissions; approvals are decided only in the UI.
- Budgets are enforced in the orchestrator, which is the only path to a model.

## Testing

- Unit tests (Vitest) for the state machine, scheduler, permission policy and provider adapters.
- A fake provider that replays recorded model responses, so agent loops are tested deterministically and offline.
- Integration tests for the Docker runner in CI.
- Playwright tests for the Electron app's main flows: add a provider, chat, plan a project, approve an output.

## Build order

The first steps, in the order they unblock each other:

1. Monorepo, Electron + React shell, CI with lint, typecheck and tests.
2. `core` types and the SQLite store with migrations.
3. Provider interface, Anthropic and OpenAI-compatible adapters, fake provider.
4. Chat UI with streaming against one clank. **First demo.**
5. Tool registry, permission policy, approval prompts, activity log.
6. Projects and tickets, the board view, Atlas planning tools.
7. Scheduler and the in-process runner (workers without sandboxes, for fast iteration).
8. Worker runtime package, worker API, Docker runner.
9. GitHub integration and the review flow.
10. Remaining outputs, then the Kubernetes runner and headless mode.

## Open questions

- **License.** MIT or Apache-2.0 for adoption, or AGPL to keep forks open.
- **Headless mode timing.** Whether to pull the daemon forward if long-running projects are the main use case.
- **Multi-user.** Whether shared boards for small teams are in scope, and if so whether sync is a self-hosted server or peer-to-peer.
- **Default local model.** Which local model to recommend for workers so the out-of-box experience is good without a cloud key.
