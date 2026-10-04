# clanks

**Put the clankers to work.**

*clank (n.): short for clanker, slang for an AI.*

clanks gives every project its own crew of clankers on your desktop: a Lead, a BA, a Designer, Engineers, QA, writers and marketers. Chat with any of them, and they plan it, make it, check it and hand it to you. Software, marketing, research and content all run the same way.

Everything runs on your own computer. clanks downloads open models and runs them itself, with its own built-in runtime: no Ollama, no separate model server, nothing else to install, and nothing has to leave your machine. You watch the crew work in a built-in diff editor, browser, terminal and design tool, and nothing ships without you.

There is no clanks account and no clanks cloud. Local models need nothing else. If you want, a clank can use a cloud model with your own API key (Anthropic, OpenAI, Google, OpenRouter) instead, or a model server you already run elsewhere (vLLM, LM Studio, Ollama). Keys stay in your OS keychain and go straight to the provider you chose.

> Status: pre-alpha. This repo currently holds the plan and the crew's priming docs. See the [roadmap](docs/ROADMAP.md), the [buildout plan](docs/PLAN.md) and [the crew](crew/README.md).

## Every project gets its own crew

1. **Name it.** A name and a line about what you're making.
2. **Pick a workspace.** Sign in with GitHub and pick or create a repo. No code? Use a local folder.
3. **Pick the crew.** Tick the clanks you need from the premade list, or create your own. Atlas is always in.
4. **Pick the models.** One default for the crew, or a different model for each clank.

## A real team, not a swarm

Clankers hand work to each other in order, and push back when what they were handed is wrong.

1. **Spec: Atlas and Scribe.** Your idea becomes user stories and acceptance criteria. You approve it before anything is built.
2. **Design: Prism.** UI tickets get flows, wireframes and design tokens first.
3. **Build: Forge.** Each ticket is built in its own workspace with tests, then opened as a pull request. Several Forges can work at once.
4. **QA: Gauge.** Runs the build, tests and browser checks against every acceptance criterion.
5. **Sign-off: Atlas.** A final review against the spec and the rest of the project, then it's yours to merge.

**Bounce-backs:** Forge sends spec gaps to Scribe, Gauge sends bugs to Forge, and Atlas can send anything back to anyone. Every bounce carries a reason, so the whole history lives on the ticket. If a ticket keeps looping, it comes to you.

The board shows it all: Backlog, Build, QA + review, Ready for you, Done. You can drag cards, reassign them or add your own.

## Meet the crew

Pick from the premade clanks, or build your own. Each clank is a name, a role, a model, a set of tools and permissions, and a priming doc that tells the model how to do its job.

| Clank | Role | What it does | Priming doc |
| --- | --- | --- | --- |
| **Atlas** | Lead | Talks to you, plans with the team, breaks work into tickets and gives the final sign-off. Always in. | [atlas.md](crew/atlas.md) |
| **Scribe** | Business Analyst | Turns your idea into a spec: user stories, acceptance criteria, edge cases. | [scribe.md](crew/scribe.md) |
| **Prism** | Designer | User flows, wireframes, the design system, social graphics and mock-ups, in Studio. | [prism.md](crew/prism.md) |
| **Forge** | Engineer | Writes the code and tests in its own workspace and opens pull requests. Run several at once. | [forge.md](crew/forge.md) |
| **Gauge** | QA | Runs the build, tests and browser checks, and validates every ticket against the spec. | [gauge.md](crew/gauge.md) |
| **Scout** *(optional)* | Researcher | Digs into libraries, APIs, competitors and pricing when the crew needs facts. | [scout.md](crew/scout.md) |
| **Quill** *(optional)* | Writer | Docs, blog posts, release notes, copy and emails. | [quill.md](crew/quill.md) |
| **Buzz** *(optional)* | Marketing | Positioning, campaign plans, channel strategy, social posts and launch calendars. | [buzz.md](crew/buzz.md) |

Every clank also gets the shared rules in [CREW.md](crew/CREW.md). You can edit any priming doc in the app, or add project-specific instructions in a `CLANKS.md` at the root of your project.

**Need a role that isn't on the list?** Create a custom clank with a name, a role prompt, a model and the tools it can use, then give it a place in the workflow. Custom clanks are saved to your library for your other projects, and you can share them for free on the marketplace. The [template](crew/custom.md) is what the app starts from, and [Sentinel](crew/examples/sentinel.md), a security checker between QA and Atlas, is a worked example.

**Each clank keeps its own memory per project:** its chats, notes and the calls it made and why. Ask Forge why it picked a library and it answers from its own record.

## Integrations and the marketplace

**Integrations** connect clanks to the services you already use: payments, stores, analytics, docs, trackers, chat and hosting. Connect an account with an API key or OAuth, then choose which projects and which clanks can use it. Most integrations are just a manifest over the service's OpenAPI description, so no third-party code runs on your machine. For everything else there are MCP servers.

- Keys stay in your OS keychain and never reach the model.
- Test and live modes are shown on every ticket and approval.
- Reads are allowed. Writes ask first. Anything that spends money, publishes or contacts people asks every time.

**The marketplace** is free: free to publish, free to install, no paid listings and no account. Share clanks, integrations, whole crews ("Shopify store", "podcast launch") and routine templates, and install what others have built.

- Before you install anything, you see the full priming doc, every tool and permission it asks for, every host it calls and whether it runs code.
- Nothing raises its own permissions, and updates show you what changed before you accept them.
- Publish from the app with one click: clanks checks the package and opens a pull request to the public marketplace repo from your GitHub account.
- Teams can add their own private index alongside the public one.

## Routines

Put the crew on a schedule. A routine starts work at a time, on repeat or when something happens, and can have things go out at an exact time once you've approved them.

> "Every Friday, have Prism make a promo banner for the weekend sale and post it on X at 5pm."

Atlas turns that into a routine: at 1pm Prism designs the banner and Buzz writes the post, and by mid-afternoon one card shows you the post exactly as it will appear, with its account and time. Approve it, and clanks posts it at 5pm. If you don't approve it in time, it doesn't go out, and if your laptop was asleep at 5, it isn't posted late.

- Run once, on a schedule in your time zone, when something happens (a spec approved, a PR merged, a release tagged) or by hand.
- Every step is a normal ticket for a clank, with a due time that leaves room for review.
- You approve every post or send ahead of time, for its exact content, account and time. The app does the posting, not a clank.
- A Schedule view shows everything coming up. Routine templates are on the marketplace.

The full spec is in [docs/ROUTINES.md](docs/ROUTINES.md).

## Local models

clanks runs models itself. You don't need Ollama, a separate model server or the command line.

- **Pull models** from a built-in catalog by short name, or from any GGUF repo on Hugging Face, straight into clanks' own model store. Downloads resume and are checksum-verified. (If you happen to have Ollama models on disk already, clanks can reuse the files instead of downloading them again.)
- **See what fits.** clanks detects your GPU and memory and tells you, before you download, whether a model will run well.
- **Runs them with llama.cpp**, bundled inside the app for Metal, CUDA, Vulkan and CPU. Models load when a clank needs them and unload when idle, and several clanks can share one loaded model.
- **A model per clank.** Plan with a large model, build with a fast one, run QA on a small one. Swap any time.
- **Serve other apps.** Optionally expose your models on localhost through OpenAI-compatible and Ollama-compatible endpoints.

## The workbench

Chat on the left, the work on the right, much like Claude's desktop app. Open any ticket and watch it happen.

- **Diff editor.** Every file change, live as the clank writes it. Accept or reject hunks, edit directly, comment on lines, step through checkpoints and rewind.
- **Browser.** A real browser built into the app. Watch Gauge click through the site, Scout research, or Forge check the page it's building, and take over whenever you need to.
- **Terminal.** Every command a clank runs and its output, with a stop button.
- **Studio.** A design tool in the spirit of Figma: an infinite canvas with auto layout, components and variants, design tokens, prototyping and visual diffs. Prism builds flows, wireframes, design systems and screens there, and you can design alongside it.
- **Activity.** Every model and tool call on a timeline. Click a step to see the diff, page, command or design as it was at that moment.

## Features (planned)

- Desktop app for macOS, Windows and Linux (Electron), running entirely on your machine.
- Built-in model runtime: pull, store and run local models inside the app, with no Ollama or other server needed. Cloud models optional.
- A crew per project, with a model per clank, and custom clanks saved to your library.
- A spec you approve before anything is built, and a workflow with QA, sign-off and bounce-backs.
- Several Forges in parallel, each in its own git worktree, with optional Docker isolation for commands.
- Pull requests on GitHub (GitLab later), signed off by Atlas and merged by you.
- A workbench to watch and steer: diff editor, browser, terminal, Studio and an activity timeline.
- Outputs beyond code: designs, copy, docs, emails, research and launch plans.
- Integrations for third-party APIs, from a manifest or an MCP server, with keys in your keychain and approval for anything outbound.
- A free marketplace for clanks, integrations, crews and routines, with everything visible before you install.
- Routines: scheduled and event-driven work, with posts and sends approved ahead of time and sent at the exact time.
- Memory per clank per project, so every decision has a reason on record.
- Per-clank budgets, token and time tracking, and a full log of every tool call.
- Everything stored locally in SQLite. Secrets in your OS keychain.

## Tech stack

TypeScript end to end.

- **App:** Electron, React, Vite, Tailwind.
- **Orchestrator:** Node, in Electron's main process: workflow engine, scheduler, agent runtime, memory.
- **Models:** llama.cpp (`llama-server`) for local models, plus a provider layer over cloud APIs and OpenAI-compatible servers.
- **Workbench:** Monaco for the diff editor, Electron `WebContentsView` driven over CDP for the browser, xterm.js and node-pty for the terminal.
- **Studio:** a JSON scene graph rendered as DOM and CSS, with W3C-format design tokens.
- **Storage:** SQLite (via Drizzle, with FTS5 for memory), secrets in the OS keychain.
- **Tools:** built-in tools for files, shell, git, web, browser, design, specs and the board; MCP for tool servers; declarative OpenAPI-based integrations for third-party APIs.
- **Marketplace:** a public GitHub repo with a static, checksummed index. Publishing is a pull request.
- **Workspaces:** git worktrees and checkpoints; Docker optional.

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

- [Roadmap](docs/ROADMAP.md): milestones from first chat to a full crew with its own models, browser, design tool, integrations and marketplace.
- [Routines](docs/ROUTINES.md): the full spec for scheduled and event-driven work and timed posts.
- [Buildout plan](docs/PLAN.md): architecture, workflow, data model, model runtime, integrations, marketplace, workbench, Studio and the order things get built.
- [The crew](crew/README.md): the priming docs for each premade clank, the custom-clank template, and how to write your own.

## Related

- [clanks.si](https://github.com/Ryan-Conte/clanks.si): the landing page.

## License

To be decided before the first public release.
