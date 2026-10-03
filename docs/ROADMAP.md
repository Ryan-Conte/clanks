# Roadmap

Each milestone ends with something you can actually use. Later milestones build on earlier ones; nothing is thrown away. The detail on how each piece is built is in [PLAN.md](PLAN.md).

The north star is the full loop: you create a project, ask the Lead for "a surfing website that sells surf boards", and the team (Lead, BA, Designer, Engineers, QA) specs it, builds it, validates it and hands you pull requests to merge.

## Milestone 0: Foundations

Get a runnable shell and the plumbing everything else sits on.

- pnpm monorepo with `apps/desktop` and `packages/*` (see the plan for layout).
- Electron + React + Vite app that opens a window, with typed IPC between renderer and main.
- SQLite database with migrations (Drizzle).
- Secrets stored in the OS keychain, never in the database or on disk in plain text.
- Lint, format, typecheck and unit tests in CI. Packaged builds for macOS, Windows and Linux in CI.

**Done when:** a packaged app opens on all three platforms and CI is green.

## Milestone 1: Projects and the Lead

The home screen and the first conversation.

- Provider abstraction with streaming and tool calling. Adapters for Anthropic, OpenAI, and any OpenAI-compatible endpoint (covers Ollama, vLLM, LM Studio, OpenRouter).
- Settings screen to add keys or local endpoints, with a "test connection" button.
- **Home screen as a project creator and selector.** Recent projects as cards; "New project" opens a short wizard:
  1. Name and one-line description.
  2. Workspace: sign in with GitHub (OAuth device flow) and pick or create a repo, or choose a local folder for projects without code.
  3. Pick the team: Atlas is always included and every other clank is optional; choose from the premade list or create a custom clank with a name, role prompt and model.
  4. Pick a default model, and optionally a model per clank.
- Clank library: the premade clanks plus any custom ones you create, reusable across projects.
- Team settings inside a project: add a clank from the library or a new custom one at any time, change its model or prompt, or remove it.
- Inside a project: chat with Atlas, the Lead, or any other clank on the team. Conversations persisted per project.
- Per-project context for each clank: its own conversation history and a notes store it can read and write.
- Token and cost tracking per message and per project.

**Done when:** you can create a project bound to a GitHub repo with a team you picked (including one custom clank), add another clank later, chat with the Lead on a cloud or local model, close the app, and pick the project back up from the home screen.

## Milestone 2: Tools and the workspace

Clanks can do things, safely.

- Tool layer with a permission model: each tool call is allowed, asked or denied per clank.
- Built-in tools: read and write files, run shell commands, git, web fetch and search.
- Each project gets a local clone of its repo as the workspace.
- MCP client so any MCP server can be attached to a clank.
- Approval prompts in chat for anything marked "ask".
- Activity log of every tool call with inputs, outputs and duration.

**Done when:** you can ask a clank to read the project's repo and make a change on a branch, approve its commands, and see every step it took.

## Milestone 3: Spec and board

The Lead and the BA turn an idea into an approved spec and a board.

- Scribe, the BA, joins the team. Atlas brings Scribe in when a request is bigger than a quick answer.
- Spec flow: clarifying questions in chat, then Scribe drafts a spec (overview, user stories, acceptance criteria, non-goals, open questions) and Atlas reviews it for scope and order.
- Spec view in the app: read it, edit it, comment, approve or send it back. Specs are versioned.
- Atlas breaks the approved spec into tickets, each linked to the stories and acceptance criteria it covers, with dependencies and an assigned role.
- Kanban board as a secondary tab, kept live from the orchestrator. Columns follow the team workflow (see the plan).
- Talk to any clank: switch the chat to Scribe and ask why a criterion exists; it answers from its own project context.

**Done when:** "build me a surfing website that sells surf boards" becomes an approved spec and a board of linked tickets.

## Milestone 4: The build loop

Engineers build, QA validates, the Lead signs off, and tickets bounce when something is wrong.

- Orchestrator scheduler: moves tickets between roles, claims work whose dependencies are done, respects concurrency and budget limits.
- Docker sandbox runner: one container per run, with the repo checked out on a ticket branch and network policy per clank.
- Forge, the Engineer: implements a ticket with tests, pushes a branch and opens a pull request on GitHub. Several Forges can run in parallel.
- Gauge, QA: checks out the PR in its own sandbox, runs the build, the tests and browser checks, and validates each acceptance criterion with evidence (test output, screenshots). Writes a QA report on the ticket.
- Atlas final sign-off: reviews the PR against the spec and the rest of the project, then moves it to you.
- Bounce-backs: any clank can return a ticket upstream with a reason (spec gap to Scribe, bug to Forge, anything from Atlas to anyone). After a configurable number of bounces the ticket escalates to you.
- CI status from GitHub mirrored on the ticket.
- Budgets per project and per clank, with automatic pause when hit.

**Done when:** a small project runs end to end with two Engineers in parallel, at least one QA bounce-back is handled without you, and you only step in to approve the spec and merge PRs.

## Milestone 5: Designer and the rest of the team

- Prism, the Designer: user flows, wireframes rendered as live HTML previews, and a design system (tokens, components) committed to the repo. UI tickets go through Prism before Forge, and Prism reviews UI work for fidelity before QA.
- Scout (Researcher), Quill (Writer) and Buzz (Marketing) as premade clanks, with research notes, docs, blog posts, campaign plans and social posts as ticket outputs.
- Non-software projects: the example "Scavr.io marketing" project (Atlas, Quill, Prism, Buzz) runs end to end on a local folder, with Atlas reviewing every piece against the approved brief.
- Custom clanks in the workflow: a custom clank (DevOps, Security, Data) gets a place in ticket routes, so Atlas can send work through it and it can hand off and bounce like the built-in roles.
- Team presets as shortcuts in the new-project wizard: "Full dev team", "Solo engineer", "Marketing team", "Research only".
- Decision log: every clank records the key decisions it makes and why, linked to tickets, so "why did you do that?" has a sourced answer.

**Done when:** a UI-heavy project goes through design before build, the Scavr.io marketing example produces an approved blog post, graphics and campaign calendar, and a custom clank can be added to the workflow without code changes.

## Milestone 6: Bring your own cluster

Run the team on infrastructure you control.

- Kubernetes runner: Engineer and QA runs become Jobs/Pods in a namespace you choose, using your kubeconfig.
- Helm chart for a small in-cluster gateway that relays worker traffic back to the desktop app.
- Optional headless mode: the orchestrator as a standalone daemon so a team keeps working with the laptop closed, with the desktop app as a client.
- Preview environments: QA can deploy a PR to a short-lived preview in the cluster and test it there.
- Resource requests, image selection and secrets injection per clank.

**Done when:** the Milestone 4 demo runs on a remote cluster with the same UI.

## Milestone 7: Polish and first public release

- Onboarding: first-run flow that adds a provider, connects GitHub and runs a sample project.
- Project templates: "marketing site", "e-commerce store", "REST API", "internal dashboard".
- GitLab support alongside GitHub.
- Auto-update, crash reporting (opt-in), signed and notarized builds.
- Docs site and the download links on [clanks.si](https://clanks.si).
- License chosen and published.

## Later

Ideas worth keeping, not yet scheduled.

- Shared projects for small teams over a self-hosted sync server.
- A clank marketplace: import and export clank roles, prompts and tool bundles.
- Publishing integrations for marketing work (CMS, social schedulers, email platforms), always behind an approval.
- Scheduled work ("every Monday, triage new issues").
- Voice chat with a clank.
- Mobile companion app for approvals on the go.
- Evaluation harness to compare models per role on your own projects.
