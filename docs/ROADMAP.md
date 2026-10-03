# Roadmap

Each milestone ends with something you can actually use. Later milestones build on earlier ones; nothing is thrown away. The detail on how each piece is built is in [PLAN.md](PLAN.md).

## Milestone 0: Foundations

Get a runnable shell and the plumbing everything else sits on.

- pnpm monorepo with `apps/desktop` and `packages/*` (see the plan for layout).
- Electron + React + Vite app that opens a window, with typed IPC between renderer and main.
- SQLite database with migrations (Drizzle).
- Secrets stored in the OS keychain, never in the database or on disk in plain text.
- Lint, format, typecheck and unit tests in CI. Packaged builds for macOS, Windows and Linux in CI.

**Done when:** a packaged app opens on all three platforms and CI is green.

## Milestone 1: Chat with a clank

The core experience works with one agent and no board yet.

- Provider abstraction with streaming and tool calling. Adapters for Anthropic, OpenAI, and any OpenAI-compatible endpoint (covers Ollama, vLLM, LM Studio, OpenRouter).
- Settings screen to add keys or local endpoints, with a "test connection" button.
- Clank profiles: name, avatar, role prompt, model. Ship Atlas, Forge, Scout and Quill as defaults.
- Chat UI: conversation list, streaming replies, markdown and code rendering, stop and retry.
- Conversations persisted locally.
- Token and cost tracking per message.

**Done when:** you can chat with a clank on a cloud model and on a local model, close the app, and pick the conversation back up.

## Milestone 2: Tools and a local workspace

Clanks can do things, safely, on your machine.

- Tool layer with a permission model: each tool call is allowed, asked or denied per clank.
- Built-in tools: read and write files in a workspace folder, run shell commands, git, web fetch and search.
- MCP client so any MCP server can be attached to a clank.
- Approval prompts in chat for anything marked "ask".
- Activity log of every tool call with inputs, outputs and duration.

**Done when:** you can ask Forge to change code in a local folder, approve its commands, and see every step it took.

## Milestone 3: The board

The lead clank plans, and the work becomes visible.

- Projects, tickets, columns (Backlog, Ready, Doing, Review, Done) and ticket dependencies.
- Kanban view as a secondary tab, kept live from the orchestrator.
- Atlas planning flow: clarifying questions in chat, then a proposed ticket breakdown you can edit before it goes on the board.
- Ticket detail: acceptance criteria, output type, assignee, linked chat, activity.
- Chat and board stay in sync: Atlas can be asked "what's the status?" and answers from the board.

**Done when:** a one-paragraph project request becomes an editable board of tickets with dependencies.

## Milestone 4: The crew clocks in (local)

Multiple workers run in parallel on your machine.

- Orchestrator scheduler: claims Ready tickets whose dependencies are done, respects concurrency and budget limits.
- Docker sandbox runner: one container per ticket run, workspace mounted, network policy per clank.
- Worker runtime inside the container that talks back to the orchestrator over a small authenticated API.
- Hand-offs: a worker can create follow-up tickets, ask another clank a question, or block on the user.
- Review column: outputs wait for you; approve, request changes (the ticket goes back with your notes) or reject.
- Budgets per project and per clank, with automatic pause when hit.

**Done when:** a "build a small site" project runs end to end with three workers in parallel and you only touch it to approve.

## Milestone 5: Real outputs

Workers deliver things you can ship, not just files in a folder.

- GitHub and GitLab integration: branches, commits, PRs/MRs, CI status back on the ticket.
- Research output: notes with sources and citations, rendered in the app.
- Documents: Markdown, exported to DOCX and PDF.
- Email: drafts composed in the app, sent only on your approval through your own SMTP or Gmail connection.
- Output artifacts stored and versioned per ticket.

**Done when:** one project produces a merged PR, a cited research note and an approved email.

## Milestone 6: Bring your own cluster

Run the crew on infrastructure you control.

- Kubernetes runner: tickets become Jobs/Pods in a namespace you choose, using your kubeconfig.
- Helm chart for a small in-cluster gateway that relays worker traffic back to the desktop app.
- Optional headless mode: the orchestrator as a standalone daemon so a crew keeps running with the laptop closed, with the desktop app as a client.
- Resource requests, image selection and secrets injection per clank.

**Done when:** the Milestone 4 demo runs on a remote cluster with the same UI.

## Milestone 7: Polish and first public release

- Onboarding: first-run flow that picks a provider and runs a sample project.
- Templates: starter projects ("ship a feature", "turn a question into a report").
- Auto-update, crash reporting (opt-in), signed and notarized builds.
- Docs site and the download links on [clanks.si](https://clanks.si).
- License chosen and published.

## Later

Ideas worth keeping, not yet scheduled.

- Shared boards for small teams over a self-hosted sync server.
- A clank marketplace: import and export clank profiles and tool bundles.
- Scheduled and recurring projects ("every Monday, research and summarise X").
- Voice chat with a clank.
- Mobile companion app for approvals on the go.
- Evaluation harness to compare models per role on your own tickets.
