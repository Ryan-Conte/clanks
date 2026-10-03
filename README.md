# clanks

**A full software team of clankers, on your desktop.**

clanks is a self-hosted desktop app that gives you a whole dev team made of AI agents, your own clankers. There is a Lead, a Business Analyst, a Designer, Engineers and QA, and they work the way a real team does. The Lead and the BA turn your idea into a spec. The Designer shapes it. Engineers build it and open pull requests. QA checks the work against the spec. The Lead gives the final sign-off before anything reaches you. When someone finds a problem, the ticket bounces back to whoever can fix it.

You start by creating a project: pick your models, connect GitHub and choose a repo. Then you tell the Lead something like *"build me a surfing website that sells surf boards"* and watch the team plan it, build it and ship it as pull requests. You can open a chat with any clank at any point and ask why it made a call.

There is no clanks account and no clanks cloud. You bring your own API keys (Anthropic, OpenAI, and others) or point clanks at a model you host yourself (Ollama, vLLM, LM Studio, anything OpenAI-compatible). Keys stay on your machine and go straight to the provider you chose.

> Status: pre-alpha. This repo currently holds the plan. See the [roadmap](docs/ROADMAP.md) and the [buildout plan](docs/PLAN.md).

## How it works

1. **Create or pick a project.** The home screen lists your projects. A new project asks for a name and a GitHub repo (sign in with GitHub, then pick an existing repo or create one). Then you pick the clanks you need from the premade list, or create your own with a custom prompt, and choose a model for each. You can add more clanks to the team later.
2. **Talk to the Lead.** Describe what you want. The Lead asks clarifying questions, then brings in the BA.
3. **The spec gets written.** The BA writes a spec with user stories and acceptance criteria. The Lead reviews it for scope and order. You approve it, edit it or send it back.
4. **The board fills up.** The Lead breaks the approved spec into tickets with dependencies and assigns them. UI work goes to the Designer first.
5. **The team builds.** Engineers each take a ticket in their own sandbox, write the code and tests, and open a pull request against your repo.
6. **QA validates.** QA runs the build and tests and checks the work against the BA's acceptance criteria. Failures bounce back to the Engineer with a report.
7. **The Lead signs off.** The Lead does a final review against the spec and the rest of the project, then hands the PR to you. You merge.

At any step, a clank that finds a problem with what it was handed can bounce the ticket back: an Engineer who finds a gap in the spec sends it to the BA, QA sends bugs to the Engineer, and the Lead can send anything back to anyone. Each bounce carries a reason, so the whole history is on the ticket.

## Meet the team

Every project gets its own team. Each clank keeps its own context per project: its conversations, its notes, the decisions it made and why. Ask Forge why it picked a library, ask Gauge what failed, or ask Scribe where an acceptance criterion came from, and they answer from their own record of that project.

| Clank | Role | Owns |
| --- | --- | --- |
| **Atlas** | Lead | Talks to you, plans the project with the BA, breaks the spec into tickets, assigns work, gives final sign-off. |
| **Scribe** | Business Analyst | Turns your idea into a spec: user stories, acceptance criteria, edge cases, open questions. Owns the spec when tickets bounce back. |
| **Prism** | Designer | User flows, wireframes, the design system, and UI specs the Engineers build from. Reviews UI work for fidelity. |
| **Forge** | Engineer | Writes the code and tests in a sandbox, opens pull requests. A project can run several Forges in parallel. |
| **Gauge** | QA | Runs the build, the tests and end-to-end checks, and validates every ticket against the BA's acceptance criteria. |
| **Scout** | Researcher | Optional. Looks into libraries, APIs, competitors and pricing when the team needs facts. |
| **Quill** | Writer | Optional. Docs, release notes, marketing copy and emails. |

You choose who is on each project's team. Pick only the clanks you need when you create it, and add more at any time from the premade list. A small site might need just Atlas, Forge and Gauge; a bigger product gets the whole crew.

Need a role that isn't on the list? Create a custom clank: give it a name, a role prompt, a model and the tools it may use, and decide where it sits in the workflow (for example a Security reviewer between QA and the Lead). Custom clanks are saved to your library so you can reuse them in other projects.

Every clank can run on a different model. Plan with a frontier model, build with a fast one, run QA on a local one, and swap any time.

## Features (planned)

- Chat-first desktop app for macOS, Windows and Linux (Electron).
- A home screen of projects, each with its own repo, team, board, specs and history.
- Pick the clanks each project needs from a premade list, add more later, or create custom clanks with your own prompts.
- GitHub sign-in to pick or create a repo; real branches and pull requests. GitLab later.
- A full team workflow: spec, design, build, QA, Lead sign-off, then you.
- Tickets that bounce back with a reason when anyone finds an issue, with a limit that escalates to you if a ticket keeps looping.
- Per-project memory for every clank, so you can ask any of them why.
- Bring your own model: Anthropic, OpenAI, Google, OpenRouter, and any OpenAI-compatible endpoint, including local models.
- Engineers and QA in isolated containers: local Docker first, your own Kubernetes cluster next.
- A live kanban board as the shared view of who is doing what.
- Human in the loop by default: you approve the spec and merge the PRs.
- Per-project budgets, token and cost tracking, and a full activity log of every tool call.
- Everything stored locally in SQLite. Secrets in your OS keychain.

## Tech stack

TypeScript end to end.

- **App:** Electron, React, Vite, Tailwind.
- **Orchestrator:** Node, running in Electron's main process (and later as a headless daemon).
- **Storage:** SQLite (via Drizzle), secrets in the OS keychain.
- **Models:** a provider abstraction over cloud APIs and OpenAI-compatible local servers.
- **Tools:** MCP for tool servers, plus built-in tools for files, shell, git, browser and web.
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

- [Roadmap](docs/ROADMAP.md): milestones from the first project to a full team on Kubernetes.
- [Buildout plan](docs/PLAN.md): architecture, the team workflow, data model, agent runtime and the order things get built.

## Related

- [clanks.si](https://github.com/Ryan-Conte/clanks.si): the landing page.

## License

To be decided before the first public release.
