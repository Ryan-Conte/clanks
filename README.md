# clanks

**Put the clankers to work.**

*clank (n.): short for clanker, slang for an AI.*

clanks is a desktop app that gives every project its own crew of AI helpers: a Lead, a BA, a Designer, Engineers, QA, writers and marketers. Tell them what you want in your own words. They plan it, make it, check each other's work, and hand it to you. Software, marketing, research and content all run the same way.

It all runs on your computer. clanks downloads an open model that fits your machine and runs it itself, so there's no account, no cloud and nothing else to install. If you'd rather, any clank can use a cloud model with your own key instead.

**[Download from clanks.si](https://clanks.si)** for macOS, Windows or Linux, then read [Getting started](docs/guide/getting-started.md).

> **Status: pre-alpha.** Everything on the [roadmap](docs/ROADMAP.md) before a first public release is built. Signed installers are what's left; see [Releasing](docs/RELEASING.md).

## How it works

1. **Say it.** Type what you want on Home, such as "a simple website for my coffee cart". clanks makes the project, its folder and its crew, and puts you in a chat with Atlas.
2. **Approve the plan.** Scribe writes a spec with user stories and acceptance criteria. Nothing is built until you approve it.
3. **Watch them work.** Atlas splits the spec into tickets on a live board. Several clanks work at once, each on its own copy of the project.
4. **Approve what comes back.** Gauge checks every ticket against the spec, Atlas signs it off, and approving merges it, opening and merging the pull request for you if the project lives on GitHub.

Work moves in order, spec → design → build → check → sign-off, but only through the stages a ticket needs. When something's wrong it **bounces back** with a reason: Gauge sends bugs to Forge, Forge sends spec gaps to Scribe, and Atlas can send anything to anyone. If a ticket keeps looping, it comes to you.

## The crew

| Clank | Role | What it does |
| --- | --- | --- |
| **Atlas** | Lead | Talks to you, plans the work, hands it out and signs it off. Always on the crew. |
| **Scribe** | Business Analyst | Turns your idea into a spec: stories, acceptance criteria, edge cases. |
| **Prism** | Designer | Flows, wireframes, design systems and graphics, in the built-in Studio. |
| **Forge** | Engineer | Writes the code and tests on its own branch. Run several at once. |
| **Gauge** | QA | Runs the build, tests and browser checks against every acceptance criterion. |
| **Scout** | Researcher | Looks things up and cites where it found them. Optional. |
| **Quill** | Writer | Docs, copy, posts and emails. Optional. |
| **Buzz** | Marketing | Positioning, campaigns, posts and launch calendars. Optional. |

Each clank is a name, a role, a model, a set of tools and a priming doc in [`crew/`](crew/README.md). You can edit any of them, add project rules in a `CLANKS.md`, or make your own clank, like [Sentinel](crew/examples/sentinel.md), a security checker that sits between Gauge and Atlas.

The crew shares a project's context (its facts, decisions and conventions), and each clank keeps its own memory of the calls it made and why. Ask Forge why it picked a library and it answers from its own record. See [docs/CONTEXT.md](docs/CONTEXT.md).

## What's in the app

- **The live board.** Every ticket in To do, In progress, Being checked, Ready for you and Done, with the clank on it and what it's doing this second. Plus a feed of every hand-off and bounce, and a **Needs you** list. Spec: [docs/BOARD.md](docs/BOARD.md).
- **The workbench.** Open any ticket to watch it happen: a diff editor with keep/reject per change, a real browser you can take over, a terminal with a stop button, Studio, and an activity timeline you can rewind.
- **Studio.** A design tool built in, with a canvas, components, tokens, prototyping and visual diffs. Prism designs there while you watch, and exports to PNG, SVG, PDF, React and CSS.
- **Local models.** Pull from a built-in catalog or any GGUF on Hugging Face. clanks checks what fits your GPU and memory first, and runs models on bundled llama.cpp (Metal, Vulkan, CPU, or CUDA on request). You can give each clank its own model, and optionally serve them to other apps on localhost.
- **Cloud models, if you want.** Anthropic, OpenAI, Google, OpenRouter, or any OpenAI-compatible server, with your own key.
- **Routines.** "Every Friday, make a promo banner and post it on X at 5pm." The crew does the work ahead of time, you approve exactly what goes out, and clanks sends exactly that at exactly then. Spec: [docs/ROUTINES.md](docs/ROUTINES.md).
- **Integrations.** Stripe, Notion, Slack, Vercel, Google Analytics, X and your email, plus any MCP server. Most are a manifest over an OpenAPI description, so no third-party code runs.
- **A free marketplace.** Share and install clanks, integrations, crews and routines, with no account. You see every tool, permission and host before anything installs.

## Privacy and permissions

- Projects, chats and models stay in a folder on your computer. There's no clanks server.
- Keys live in your OS keychain. They never reach a model or a log, and go only to the provider you chose.
- Reads run freely. Risky commands and changes ask first. Anything that spends money, publishes or contacts people asks every time.
- Nothing is merged, sent, posted or bought until you approve it, and the app does it, not a model.

Details: [docs/guide/privacy.md](docs/guide/privacy.md).

## Development

You need Node 22.12+ and pnpm 10 (`corepack enable` gives you the pinned version). Nothing else: native modules ship prebuilt, Electron downloads itself, and `pnpm dev` fetches the pinned llama.cpp builds (about 50 MB, sha256-checked) on first run. The app needs git on the `PATH`; on Windows it uses the bash from Git for Windows.

```bash
git clone https://github.com/Ryan-Conte/clanks
cd clanks
pnpm install
pnpm dev
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the app with hot reload. Its data goes in a separate `clanks-dev` folder. |
| `pnpm dev:web` | Runs clanks.si (`apps/web`) at `localhost:4321`. |
| `pnpm build` | Builds every package with Turborepo. |
| `pnpm test` | Unit tests for every package. |
| `pnpm test:e2e` | Pulls a 19 MB model and runs a prompt on the bundled llama.cpp. Needs the network. |
| `pnpm lint`, `pnpm format`, `pnpm typecheck` | The checks CI runs. |
| `pnpm db:generate` | Writes a migration after a change to `packages/orchestrator/src/store/schema.ts`. |
| `pnpm package` | Builds installers for your platform into `apps/desktop/dist`. Never uploads. |
| `pnpm --filter @clanks/models catalog:update` | Fills in new model catalog entries from Hugging Face (`--refresh` moves all to the latest commit). |

`CLANKS_DATA_DIR` points the app at another data folder. `--smoke-test` on a packaged app checks it starts, opens its database and runs llama.cpp, then quits; CI does this on all three platforms.

### Repository layout

| Path | What's there |
| --- | --- |
| `apps/desktop` | The Electron app: main process, preload and the React window. |
| `apps/web` | [clanks.si](https://clanks.si): the landing page, with `docs/guide` rendered under `/docs`. Static Astro. |
| `packages/orchestrator` | Owns all state and model traffic: workflow, scheduler, agent runtime, memory, store. |
| `packages/core` | Shared types and zod schemas. |
| `packages/models` | Model catalog, pulls, hardware probe and the llama-server supervisor. |
| `packages/providers` | The provider interface and its adapters. |
| `packages/tools` | Built-in tools, the permission policy and the MCP client. |
| `packages/workspace` | Worktrees, checkpoints, diffs and command execution. |
| `packages/browser` | Drives the built-in browser over CDP. |
| `packages/design` | Studio's design engine: file format, tokens, rendering and lint. |
| `packages/integrations` | Integration manifests, OpenAPI operations as tools, auth and redaction. |
| `packages/marketplace` | The marketplace index, package verification and updates. |
| `packages/routines` | Schedules, time zones, plain-words parsing and OS wake-ups. |
| `crew/` | The priming docs for each clank. |
| `integrations/` | The bundled integration manifests. |
| `docs/` | The plan, the roadmap, specs and the user guides. |

## Docs

- [Using clanks](docs/guide/README.md): the user guides, also on [clanks.si/docs](https://clanks.si/docs/).
- [Roadmap](docs/ROADMAP.md): the milestones, from first chat to the first public release.
- [Buildout plan](docs/PLAN.md): architecture, data model, model runtime and the reasoning behind each choice.
- [The crew](crew/README.md): the priming docs and how to write your own clank.
- [Context and memory](docs/CONTEXT.md), [Live board](docs/BOARD.md), [Routines](docs/ROUTINES.md): the full specs.
- [Releasing](docs/RELEASING.md): how a version is tagged, built, signed and published.

## License

[Apache-2.0](LICENSE). Use it, change it and ship what you make with it, closed or open; keep the licence and notices with it. The licence covers the code and docs, not the clanks name or logo.

The installers bundle [llama.cpp](https://github.com/ggml-org/llama.cpp) and open-licence fonts, each under its own licence.
