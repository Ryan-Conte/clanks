# clanks

**Put the clankers to work.**

clanks is a self-hosted desktop app for running a crew of AI agents, your own clankers. You chat with one of your clanks the way you would with any assistant. Hand it something big, like "build a booking site for my barber shop" or "write me a report on the local coffee market", and the lead clank breaks it into tickets on a live kanban board. Worker clanks pick those tickets up, each in its own sandbox, and hand back real outputs: merge requests, research notes, emails and documents. You review and sign off.

There is no clanks account and no clanks cloud. You bring your own API keys (Anthropic, OpenAI, and others) or point clanks at a model you host yourself (Ollama, vLLM, LM Studio, anything OpenAI-compatible). Keys stay on your machine and go straight to the provider you chose.

> Status: pre-alpha. This repo currently holds the plan. See the [roadmap](docs/ROADMAP.md) and the [buildout plan](docs/PLAN.md).

## How it works

1. **Chat it through.** Open a chat with a clank. Small asks get answered right there, like any assistant.
2. **The lead clank plans.** For bigger work, the lead clank (Atlas in the examples) asks what it needs to, then turns the project into tickets with acceptance criteria, dependencies and an output type.
3. **The crew clocks in.** Each ticket is claimed by a worker clank running in an isolated container, on local Docker or your own Kubernetes cluster. Workers use the tools their ticket needs, post progress back to the board, and hand off to each other.
4. **You sign off.** Outputs land in a review column: an MR to approve, a doc to read, an email draft to send. Nothing leaves your machine or touches your repos without the permissions you gave it.

The chat is the main way you use clanks. The board is the shared view of what the crew is doing, and you can drag cards, reassign them or add your own.

## Meet the crew

Clanks are configurable agents: a name, a role, a model, a set of tools and a set of permissions. The defaults ship as:

| Clank | Role | Typical outputs |
| --- | --- | --- |
| **Atlas** | Lead. Plans projects, writes tickets, assigns work, reviews hand-offs. | Ticket breakdowns, status summaries |
| **Forge** | Engineer. Works in a git checkout inside a sandbox. | Branches, merge requests, test runs |
| **Scout** | Researcher. Browses, reads and cites. | Research notes, comparison tables |
| **Quill** | Writer. Drafts and edits. | Emails, docs, reports |

Every clank can run on a different model. Plan with a frontier model, run the crew on a local one, and swap any time.

## Features (planned)

- Chat-first desktop app for macOS, Windows and Linux (Electron).
- Bring your own model: Anthropic, OpenAI, Google, OpenRouter, and any OpenAI-compatible endpoint, including local models.
- A lead clank that turns a project into a dependency-aware kanban board.
- Worker clanks in isolated containers: local Docker first, your own Kubernetes cluster next.
- Output types beyond code: research, email drafts, documents, spreadsheets.
- Git integrations that open real MRs/PRs on GitHub and GitLab.
- Human-in-the-loop by default: approvals for merges, sends and anything outbound.
- Per-clank budgets, token and cost tracking, and a full activity log of every tool call.
- Everything stored locally in SQLite. Secrets in your OS keychain.

## Tech stack

TypeScript end to end.

- **App:** Electron, React, Vite, Tailwind.
- **Orchestrator:** Node, running in Electron's main process (and later as a headless daemon).
- **Storage:** SQLite (via Drizzle), secrets in the OS keychain.
- **Models:** a provider abstraction over cloud APIs and OpenAI-compatible local servers.
- **Tools:** MCP for tool servers, plus built-in tools for files, shell, git and web.
- **Sandboxes:** Docker locally, Kubernetes Jobs/Pods on a cluster you control.

The reasoning behind each choice is in [docs/PLAN.md](docs/PLAN.md).

## Getting started

Not runnable yet. Once Milestone 0 lands, development will look like:

```bash
git clone https://github.com/Ryan-Conte/clanks
cd clanks
pnpm install
pnpm dev
```

## Docs

- [Roadmap](docs/ROADMAP.md): milestones from first chat to a full crew on Kubernetes.
- [Buildout plan](docs/PLAN.md): architecture, data model, agent runtime and the order things get built.

## Related

- [clanks.si](https://github.com/Ryan-Conte/clanks.si): the landing page.

## License

To be decided before the first public release.
