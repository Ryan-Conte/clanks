# Roadmap

Each milestone ends with something you can actually use. Later milestones build on earlier ones; nothing is thrown away. Everything runs locally inside the desktop app. The detail on how each piece is built is in [PLAN.md](PLAN.md), and the clanks' priming docs are in [crew/](../crew/README.md).

## Milestone 0: Foundations

Get a runnable shell and the plumbing everything else sits on.

- pnpm monorepo with `apps/desktop` and `packages/*` (see the plan for the layout).
- Electron + React + Vite app that opens a window, with typed IPC between renderer and main.
- Tray icon: closing the window keeps clanks running in the background; quit from the tray.
- SQLite database with migrations (Drizzle), and the app data folder layout.
- Secrets stored in the OS keychain, never in the database or on disk in plain text.
- Lint, format, typecheck and unit tests in CI. Packaged builds for macOS, Windows and Linux in CI.

**Done when:** a packaged app opens on all three platforms and CI is green.

## Milestone 1: Pull and run models

clanks downloads and runs its own models. No Ollama, no separate model server, nothing else to install.

- Hardware probe: GPUs, VRAM, system or unified memory, and the matching bundled llama.cpp build (Metal, CUDA, Vulkan or CPU).
- Model catalog with recommended models per role and an estimate of whether each fits your machine before you download it.
- Pull by catalog name or from any Hugging Face GGUF repo (`hf.co/<owner>/<repo>:<quant>`): straight from Hugging Face into clanks' own model store, resumable, parallel, checksum-verified, with pause and cancel.
- Bundled `llama-server` runtime, started and managed by clanks: load on demand, unload when idle, fit within a memory budget, share one loaded model between clanks through parallel slots, restart on crash.
- Models screen: library, disk usage, what's loaded and on which device, memory use and tokens per second, and a prompt box to try a model. Move the models folder to another drive.
- First run: pick a model for your hardware, pull it and assign it to the crew.
- Provider interface with the built-in runtime as its first and default adapter.

**Done when:** on a fresh machine with no Ollama and nothing else installed, the app picks, pulls and loads a model and answers a prompt with the network unplugged.

## Milestone 2: Chat with a clank

The core experience works with one agent and no board yet, on the model clanks pulled itself.

- The crew's priming docs from [`crew/`](../crew/README.md), loaded and assembled into each clank's system prompt, including a project's `CLANKS.md`.
- Clank profiles: name, avatar, model, and the priming doc, editable in the app with reset to default. Ship the premade crew: Atlas, Scribe, Prism, Forge and Gauge, plus Scout, Quill and Buzz.
- Chat UI: conversation list, streaming replies, markdown and code rendering, stop and retry.
- Conversations persisted locally.
- Token and time tracking per message.
- Optional, for anyone who wants them: cloud adapters (Anthropic, OpenAI, Google, OpenRouter) and an adapter for model servers you already run elsewhere (vLLM, LM Studio, Ollama). None of them is needed.
- Optional local API, off by default: OpenAI-compatible and common Ollama-style endpoints on 127.0.0.1, so other apps can use the models clanks has pulled.
- Optional: if you already have Ollama models on disk, reuse those files instead of downloading them again.

**Done when:** you chat with each premade clank on a model clanks pulled itself, offline, close the app, and pick the conversation back up.

## Milestone 3: Tools, workspaces and the diff editor

Clanks can do things on your machine, safely, and you can see every change.

- Tool layer with a permission model: each tool call is allowed, asked or denied per clank. Approval prompts in chat, with "always allow" for a command or host in this project.
- Built-in tools: files, shell, git, web fetch and search. MCP client so any MCP server can be attached to a clank.
- Workspaces: each run gets its own git worktree and branch; every file change is checkpointed.
- The workbench, beside the chat:
  - **Diff editor** (Monaco): live as the clank writes, side-by-side or inline, accept or reject hunks, edit directly, comment on lines, scrub through checkpoints, rewind.
  - **Terminal**: live output of every command the clank runs, with a stop button, plus your own shell in the run's worktree.
  - **Activity**: every model and tool call, with inputs, outputs and duration; selecting a step moves the other panes to that moment.

**Done when:** you ask Forge to change code in a local repo, approve its commands, watch its edits land live in the diff editor, reject one hunk with a comment, and Forge acts on the comment.

## Milestone 4: The built-in browser

Clanks browse in a real browser inside the app, and you watch.

- Browser pane in the workbench: tabs per run, each isolated from the others and from your own browser.
- Browser tools: open, navigate, read the page as text with clickable refs, click, type, press, scroll, screenshot, console and back.
- Text-first page reading for local models without vision; screenshots for models with it.
- **Take over** and **Hand back**, so you can sign in or steer and then return control.
- Guard rails: per-clank site lists, no typing into password fields, downloads only with approval, no uploads.
- Forge previews its dev server in the same pane.

**Done when:** Scout answers a research question by browsing while you watch, and Forge checks the page it just built in the same pane.

## Milestone 5: Projects, specs and the board

Every project gets its own crew, and an idea becomes an approved spec and a board.

- New project flow: name it, pick a workspace (sign in with GitHub and pick or create a repo, or use a local folder), pick the crew (Atlas is always in), pick one model for the crew or one per clank.
- Spec flow: Atlas talks it through in chat and briefs Scribe; Scribe writes user stories, acceptance criteria and edge cases; Atlas signs it off; you approve it. Specs are versioned (spec v2).
- Atlas turns each approved spec version into tickets that carry their story ids and criteria, with design tickets ahead of the UI work that needs them.
- Tickets pass through only the stages they need: setup, config and backend work goes straight to Forge, and only UI work waits for a design. Work you ask for directly ("set up a Next.js app for the website") becomes a ticket straight away, without waiting for the spec.
- The [live board](BOARD.md): Backlog, Build, QA + review, Ready for you and Done, updated as events happen, with counts, the activity feed and the ticket drawer. Drag to prioritise or reassign, or add your own cards.
- Ticket detail: stories, acceptance criteria, output type, route, assignee, linked chat, activity.
- Chat and board stay in sync: Atlas answers "what's the status?" from the board.

**Done when:** "Build me a surfing website that sells surf boards" becomes an approved spec and a board of tickets with dependencies.

## Milestone 6: The crew clocks in

A real team, not a swarm: clanks hand work to each other in order and push back when it's wrong.

- Workflow engine: each ticket's route is its maker, then the checkers for its type, then Atlas, then you. Required and optional checks per project; optional ones can be skipped on a ticket, with a reason.
- Assigned and open tickets: assign a ticket to a clank, or leave it open and the first free clank that makes its type picks it up, preferring the one that built what it depends on. Reassign anything at any time.
- Forge builds tickets in parallel, each in its own worktree, and the app pushes the branch and opens a pull request on GitHub.
- Gauge runs the build, tests and browser checks against every acceptance criterion, in its own worktree of the PR branch.
- Atlas signs off every ticket against the spec and the rest of the project.
- Bounce-backs with reasons: Forge sends spec gaps to Scribe, Gauge sends bugs to Forge, Atlas can send anything back to anyone. A ticket that keeps looping comes to you, with its history on the ticket.
- [Context](CONTEXT.md): a project context shared by every clank in the project (project facts, decisions, conventions and names, written by you and the crew), and a private memory per clank per project (its chats, run summaries and decisions with reasons). Ask Forge why it picked a library and it answers from its own record.
- Your profile, `## For <clank>` sections in `CLANKS.md`, and the Context tab with a Preview of exactly what a clank sees.
- Scheduler: claims tickets whose dependencies are done, within concurrency and budget limits, and shares loaded models between runs; a run waits when its model can't be loaded yet.
- The board comes alive with the crew: a status and a live line on every card ("Running `npm test`", "Checking AC-4.2"), progress from each clank's plan, the crew strip with "● 3 clanks working", the By clank view and **Needs you**.
- **Watch** on any card opens that run's workbench in follow mode; switch between running clanks.
- Home: everything that needs you, every clank working now, what's coming up and how hard your machine is working, across all projects.
- Ready for you: approve (you merge the PR), request changes with comments, or reject.
- Optional Docker sandbox for shell commands when Docker is installed.
- Budgets per project and per clank, in tokens, time or money, with automatic pause when hit.

**Done when:** the surf shop's first tickets run end to end on a local model with several Forges in parallel, at least one Gauge bounce is fixed without you, you follow it all from the live board, and you only touch it to merge.

## Milestone 7: Studio and Prism

A design tool built into the app, and a designer clank that uses it.

- Studio: an infinite canvas with pages and frames, shapes, text, images, icons, auto layout, components with variants, instances, snapping, layers and properties panels, undo and redo, and Figma-style shortcuts.
- Design tokens and modes (light and dark) in a tokens panel, exported as CSS variables, a Tailwind theme or JSON.
- Design files stored in the project's `design/` folder, so they get worktrees, checkpoints and review like code.
- Prism builds a design language (tokens plus `DESIGN.md`), components and screens, live on the canvas. You can edit alongside it and it keeps your changes.
- Lint for off-token values, contrast, overflow and tap targets, so text-only local models can design too.
- Review in Studio: visual diff with side-by-side and overlay, a list of property changes, and comments pinned to the canvas.
- Prototype mode to click through linked frames.
- Hand-off: Forge gets the tokens, `DESIGN.md` and frame specs, and compares its build against the design in the browser.

**Done when:** Prism maps the surf shop's flows, wireframes the storefront, builds its design system and screens, you restyle a button by hand, and Forge builds the storefront from the approved design so it matches in the browser pane.

## Milestone 8: Beyond code

The optional clanks, custom clanks, and outputs beyond pull requests.

- Quill: docs, blog posts, release notes, product copy and emails. Emails are sent only on your approval, through your own SMTP or Gmail connection.
- Buzz: positioning, campaign plans, channel strategy, social post drafts and launch calendars. Nothing is posted without your approval; scheduled posting arrives with routines.
- Scout: research notes with sources and citations, with screenshots of key pages, and quick answers to other clanks.
- Prism: social graphics and mock-ups for Buzz's campaigns.
- Custom clanks: create one with a name, a role prompt, a model, its tools and a place in the workflow (for example Sentinel, a security checker between QA and Atlas). Saved to your library for other projects.
- Documents exported to DOCX and PDF; designs exported as PNG, SVG and PDF, with React and CSS starting points per component.
- GitLab alongside GitHub.
- Output artifacts stored and versioned per ticket.

**Done when:** the surf shop project ends with merged PRs, approved product copy and a launch plan to approve, and a custom Sentinel checks every PR between Gauge and Atlas.

## Milestone 9: Integrations and the marketplace

Connect clanks to the services you use, and share what you build for free.

- Integrations framework: declarative integrations built from a manifest and an OpenAPI file, so no package code runs. Connect with an API key or OAuth; credentials stay in the keychain.
- Test and live modes shown on every ticket and approval. Risk levels per operation: reads allowed, writes ask, and anything that spends money, publishes or contacts people asks every time.
- Integrations turned on per project and per clank.
- MCP-server integrations for services that need code, pinned and optionally run in Docker.
- A starter set of first-party integrations (candidates: Stripe, Shopify, Notion, Linear, Slack, Google Analytics, Vercel).
- Marketplace, free to publish and free to install: browse clanks, integrations and crews from a public index with no account.
- Install with a full preview of the priming doc, tools, hosts and permissions; checksum-verified; updates shown as diffs; nothing raises its own permissions.
- Publish from the app: validation, an open licence, and a pull request to the marketplace repo from your GitHub account.
- Extra indexes for teams that want a private marketplace.

**Done when:** you install a community clank and the Stripe integration from the marketplace, connect Stripe in test mode, Gauge verifies the surf shop's checkout against real test payments, and you publish your own Sentinel to the marketplace from the app.

## Milestone 10: Routines

Schedule work for the crew, and have things go out at an exact time once you've approved them. The full spec is in [ROUTINES.md](ROUTINES.md).

- Triggers: once, on a cron schedule in your time zone (typed in plain language, previewed as the next five times), on events (spec approved, ticket done, PR merged, a new git tag, another routine finished) or by hand.
- Ticket steps that create tickets for clanks, each with a due time so there's room for review, going through the normal workflow.
- Action steps that call an integration at a set time, such as posting to X, with content taken from earlier steps' approved outputs.
- Approval ahead of time: one card per run shows each post as it will appear, with its account and time. Approving freezes it, changing anything asks again, and nothing unapproved ever goes out.
- The orchestrator, not a model, executes scheduled actions, exactly once, with retries inside a grace window, or hands them off to the service's own scheduler.
- Works around a laptop: runs from the tray, can launch the app before a run, keeps the computer awake while work is due, and handles missed runs with skip, run late or ask. Posts never go out late on their own.
- Atlas and Buzz draft routines from chat; Buzz's campaigns schedule in one click; routine templates come from the marketplace.
- Routines tab, a Schedule calendar, run history and notifications.

**Done when:** you ask Atlas to "have Prism make a promo banner every Friday afternoon and post it on X at 5pm", approve the first Friday's banner and post from one card, and it goes out at 17:00; the next Friday the computer is asleep at 17:00, and it's marked missed rather than posted late.

## Milestone 11: Polish and first public release

- Onboarding: first-run flow that sizes up your machine, pulls a model and runs a sample project.
- Templates: starter projects and crews, also installable from the marketplace ("ship a feature", "design and build a landing page", "plan a launch", "turn a question into a report").
- Auto-update, crash reporting (opt-in), signed and notarized builds.
- Docs site and the download links on [clanks.si](https://clanks.si).
- License chosen and published.

## Milestone 12: One conversation

Make clanks something anyone can pick up, technical or not: say what you want, talk to one clank, and let the crew work it out between them.

- First run in one click: the model that suits the computer is downloaded and given to the crew when it lands, with the window open or closed.
- Home is one box: a sentence makes the project, its folder and its crew, and puts you in a conversation with Atlas.
- A project opens on that conversation, with the crew at work beside it. Whatever needs you comes to it, whichever clank it's from: questions, risky steps to allow, and finished work to approve.
- Each piece of work is a message of its own there, with what was made in it: a document as a page, a design's pictures, the site as it looked when it was checked. It stays after you've decided.
- Paste a screenshot or add a photo to any message, and a model that can see it does.
- Plain words throughout: To do, In progress, Being checked; Code and Document rather than PR and Doc; Download rather than Pull. The board, the spec and the rest stay a tab away.
- Settings in five groups, and the Models page with what the crew runs on first and the rest under Advanced.
- The crew is told to talk to you in everyday words, and to make the technical choices itself.

**Done when:** someone who has never used it types "a simple website for my bakery" and, without leaving the conversation with Atlas, answers the crew's questions, approves the spec, and approves the finished page.

## Later

Ideas worth keeping, not yet scheduled.

- A `clanks` command line (`pull`, `ls`, `rm`, `ps`, `run`) that talks to the running app.
- OS-level sandboxing for host commands: Seatbelt on macOS, bubblewrap on Linux.
- Studio: pen tool and boolean operations, Figma file import, local image generation for placeholders.
- Embeddings and local search over a project's files, served by the same runtime.
- Evaluation harness to compare models per role on your own tickets, and to test changes to the crew docs.
- Kubernetes runner and headless daemon, for running a crew on a machine that stays on.
- Shared boards for small teams over a self-hosted sync server.
- Voice chat with a clank.
- Mobile companion app for approvals on the go.
