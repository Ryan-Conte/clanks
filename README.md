# clanks

**Put the clankers to work.**

*clank (n.): short for clanker, slang for an AI.*

clanks gives every project its own crew of clankers on your desktop: a Lead, a BA, a Designer, Engineers, QA, writers and marketers. Chat with any of them, and they plan it, make it, check it and hand it to you. Software, marketing, research and content all run the same way.

Everything runs on your own computer. clanks downloads open models and runs them itself, with its own built-in runtime: no Ollama, no separate model server, nothing else to install, and nothing has to leave your machine. You watch the crew work in a built-in diff editor, browser, terminal and design tool, and nothing ships without you.

There is no clanks account and no clanks cloud. Local models need nothing else. If you want, a clank can use a cloud model with your own API key (Anthropic, OpenAI, Google, OpenRouter) instead, or a model server you already run elsewhere (vLLM, LM Studio, Ollama). Keys stay in your OS keychain and go straight to the provider you chose.

> Status: pre-alpha, with everything the [roadmap](docs/ROADMAP.md) lists before a first public release built; signing certificates for the installers are what's left. [Milestone 11](docs/ROADMAP.md#milestone-11-polish-and-first-public-release) is in: first run ends with a sample project the crew works while you watch, a project can start from a template (ship a feature, a landing page, a launch plan, a question turned into a report), the app looks for a newer version and installs one only when you say, crash reports stay on your computer unless you turn sending on, and builds are signed and notarised when the certificates are there. The [guides](docs/guide/README.md) are for using it. [Milestone 10](docs/ROADMAP.md#milestone-10-routines) is in too: routines. Ask Atlas for "a promo banner every Friday afternoon, posted on X at 5pm" and it drafts a routine you edit and turn on. Each run puts its tickets on the board with a due time; when the work is signed off, one card shows everything that will go out, as it will appear, with its account and time. Approving freezes it, and clanks, not a model, sends exactly that at exactly then. Unapproved, it never goes out, and if the computer was asleep at its time it's marked missed rather than posted late. Routines start on a schedule in your time zone, typed in plain words, or when a spec is approved, a ticket is done, a pull request is merged or a release is tagged. Before that, [Milestone 9](docs/ROADMAP.md#milestone-9-integrations-and-the-marketplace): integrations and the marketplace. Connect Stripe, Notion, Slack, Vercel or Google Analytics with a key or a sign-in that stays in your keychain, turn each on per project and per clank, and the crew gets tools for it: reads run, changes ask you first, and anything that spends money, publishes or contacts people asks every time, with the account's test or live mode on every approval and ticket. An integration is a manifest over an OpenAPI description, so no package code runs, and you can add one of your own from a folder. The Marketplace page installs clanks, integrations and crews from a public index with no account: you see a clank's whole priming doc and every tool it asks for, or an integration's every host and operation, checked against its checksum, before anything is installed; a marketplace clank can't give itself more than ask above read; updates show what changed; and you publish your own from the app as a pull request from your GitHub account. Before that, [Milestone 8](docs/ROADMAP.md#milestone-8-beyond-code): the crew makes more than code. Quill writes docs, copy and emails, Scout researches with cited sources and a picture of each page it read, and Buzz plans campaigns and drafts posts. Each hand-in is checked against its type, kept with its ticket in every version, and exports to Word and PDF. An email goes out from your own account only when you approve it, and nothing is ever posted for you. You can make clanks of your own, such as a security checker that reviews every pull request between Gauge and Atlas; clanks can put quick questions to each other; Studio exports frames as PNG, SVG and PDF and components as React and CSS; and a project can live on GitLab as well as GitHub. Before that came Studio, a design tool built into the app, and Prism, who designs in it. A design is tokens, components and frames in the project's `design/` folder; Prism builds it on a ticket while you watch the canvas, and you can edit alongside, compare versions and pin comments. Forge is handed the tokens and frames and builds from them. And before that, the crew works the board. Start a project on a local folder or a GitHub repository and tell Atlas what you want; Scribe writes the spec, you approve it, and Atlas turns it into tickets. The scheduler hands each ticket to a free clank within your limits and your machine's model slots, several Forges at once, each on its own branch. Gauge checks every pull request in a copy of its branch and sends bugs back to Forge, a clank can ask Scribe about a gap in the spec, Atlas signs off, and approving merges the work, opening and merging the pull request on GitHub for a repository there. The crew shares project notes and each clank keeps its own memory; the board, Home and the Context tab show what everyone is doing, knows and spends, and the crew asks before risky commands only. Budgets pause runs, and commands can run in Docker. See the [roadmap](docs/ROADMAP.md), the [buildout plan](docs/PLAN.md) and [the crew](crew/README.md).

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

**Not every ticket walks the whole chain.** "Set up a Next.js app for the website" goes straight to Forge. Only UI work waits for Prism's design, and work you ask for directly doesn't wait for the spec. Tickets can be assigned to a clank or left open for the first free clank that can do them, and you can reassign anything.

## The live board

The board is where you watch the crew work: every ticket, the clank on it, and what that clank is doing right now.

```
┌────────────────────┐
│ CLK-104         PR │
│ AU shipping rates  │
│ ● Forge  3/5 steps │
│ Running npm test   │
└────────────────────┘
```

- **Live.** Cards move through Backlog, Build, QA + review, Ready for you and Done as the work moves. Each shows its clank, its status and a live line from what the clank is doing this second.
- **The crew at a glance.** "● 3 clanks working", every clank's avatar with its current tickets, and a **By clank** view with one lane per bot.
- **A running feed.** "Gauge › bounced CLK-103 to Forge: AC-4 failed", "Atlas › signed off CLK-101, ready for you". Click a line to see that moment.
- **Watch anything.** Open any card to follow its work live in the diff editor, browser, terminal or Studio.
- **Needs you.** Everything waiting on you in one list: sign-offs, approvals, questions and scheduled posts.
- **Yours to steer.** Drag cards to prioritise, reassign, start or stop them, or add your own. Approving always opens the approval card; nothing ships on a drag.
- **Home** shows the same overview across every project: what needs you, who's working, what's coming up and how hard your machine is working.

The full spec is in [docs/BOARD.md](docs/BOARD.md).

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

**Shared context, and a memory of its own.** Every clank in a project shares that project's context: its facts, decisions, conventions and names, written by you and the crew. Each clank also keeps its own memory per project: its chats, notes and the calls it made and why. Ask Forge why it picked a library and it answers from its own record. See [docs/CONTEXT.md](docs/CONTEXT.md).

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
- An approved campaign's posts can be scheduled the same way, each shown in full first.
- The tray lists what's coming up and pauses every routine with one switch. The app can start with your computer, keep it awake while work is due, and be started by your operating system a few minutes before a run.

The full spec is in [docs/ROUTINES.md](docs/ROUTINES.md).

## Local models

clanks runs models itself. You don't need Ollama, a separate model server or the command line.

- **Pull models** from a built-in catalog by short name, or from any GGUF repo on Hugging Face, straight into clanks' own model store. Downloads resume and are checksum-verified. (If you happen to have Ollama models on disk already, clanks can reuse the files instead of downloading them again.)
- **See what fits.** clanks detects your GPU and memory and tells you, before you download, whether a model will run well.
- **Runs them with llama.cpp**, bundled inside the app for Metal, Vulkan and CPU, with a CUDA build downloaded on request for NVIDIA cards. Models load when a clank needs them and unload when idle, and several clanks can share one loaded model.
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
- A live board that shows every clank working, with an activity feed, a By clank view and a Home overview across projects.
- A workbench to watch and steer: diff editor, browser, terminal, Studio and an activity timeline.
- Outputs beyond code: designs, copy, docs, emails, research and launch plans.
- Integrations for third-party APIs, from a manifest or an MCP server, with keys in your keychain and approval for anything outbound.
- A free marketplace for clanks, integrations, crews and routines, with everything visible before you install.
- Routines: scheduled and event-driven work, with posts and sends approved ahead of time and sent at the exact time.
- A project context the whole crew shares, plus a memory per clank per project, so every decision has a reason on record.
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

## Development

You need Node 22.12 or later and pnpm 10 (`corepack enable` gives you the version the repo pins). Nothing else: the SQLite driver and the terminal's pty ship prebuilt binaries, Electron downloads itself on first run, and `pnpm dev` fetches the pinned llama.cpp builds for your platform (about 50 MB, checked by sha256) the first time. For clanks to work on a folder, the app needs git on the `PATH`, as it does for anyone using it; on Windows its commands run in the bash that comes with Git for Windows.

```bash
git clone https://github.com/Ryan-Conte/clanks
cd clanks
pnpm install
pnpm dev
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the app from source with hot reload. Its data goes in a `clanks-dev` folder, apart from an installed copy's. |
| `pnpm test` | Unit tests for every package. |
| `pnpm test:e2e` | Pulls a 19 MB model from Hugging Face and answers a prompt on the real bundled llama.cpp. Needs the network and `pnpm fetch-llama`. |
| `pnpm fetch-llama` | Fetches the pinned llama.cpp builds that ship inside the app into `apps/desktop/resources/llama`. |
| `pnpm lint`, `pnpm format`, `pnpm typecheck` | The same checks CI runs. |
| `pnpm db:generate` | Writes a migration after you change the schema in `packages/orchestrator/src/store/schema.ts`. |
| `pnpm package` | Builds installers for your platform into `apps/desktop/dist`. |
| `pnpm dev:web` | Runs clanks.si, the landing page and guides in `apps/web`, at `localhost:4321`. `pnpm build` builds it into `apps/web/out` with everything else. |
| `pnpm --filter @clanks/models catalog:update` | Fills in new model catalog entries from Hugging Face: pinned revision, sha256 and size of each file, and the facts the memory estimate needs. `--refresh` moves every entry to its repo's latest commit. |

`CLANKS_DATA_DIR` points the app at another data folder. Add `--smoke-test` to a packaged app to check that it starts, loads its window, reads its database and runs its bundled llama.cpp, then quits. CI does this on macOS, Windows and Linux for every push.

## Docs

- [Using clanks](docs/guide/README.md): the guides, from installing it to routines and troubleshooting. clanks.si renders these same files under `/docs`.
- [Roadmap](docs/ROADMAP.md): milestones from first chat to a full crew with its own models, browser, design tool, integrations and marketplace.
- [Context and memory](docs/CONTEXT.md): what each clank knows, what the whole crew shares, and who can change it.
- [Live board](docs/BOARD.md): the full spec for the board, the activity feed and Home.
- [Routines](docs/ROUTINES.md): the full spec for scheduled and event-driven work and timed posts.
- [Buildout plan](docs/PLAN.md): architecture, workflow, data model, model runtime, integrations, marketplace, workbench, Studio and the order things get built.
- [The crew](crew/README.md): the priming docs for each premade clank, the custom-clank template, and how to write your own.
- [Releasing](docs/RELEASING.md): how a version is tagged, built, signed and published, and what the updater reads.

## Related

- [clanks.si](https://clanks.si): the landing page and the guides, built from [`apps/web`](apps/web).

## License

[Apache-2.0](LICENSE). Use it, change it and ship what you make with it, closed or open; keep the licence and the notices with it. The licence covers the code and the docs, not the clanks name or logo.

The installers bundle [llama.cpp](https://github.com/ggml-org/llama.cpp) and a set of open-licence fonts, each under its own licence. What you publish to a marketplace carries the open licence you pick for it.
