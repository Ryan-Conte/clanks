# The crew

These are the priming docs for the clanks that ship with the app. Each one is loaded into the model's context as that clank's system prompt, so it is written *to* the clank, not about it. They are bundled into the app as resources, and the app never edits these copies.

## Premade clanks

| File | Clank | Role | Kind | Makes |
| --- | --- | --- | --- | --- |
| [atlas.md](atlas.md) | Atlas | Lead. Talks to you, plans, writes tickets, gives the final sign-off. Always in the crew. | checker (sign-off) | |
| [scribe.md](scribe.md) | Scribe | Business Analyst. Turns your idea into a spec. | maker (spec) | `spec` |
| [prism.md](prism.md) | Prism | Designer. Flows, wireframes, the design system, social graphics, mock-ups. | maker (design) | `design` |
| [forge.md](forge.md) | Forge | Engineer. Writes code and tests, opens pull requests. | maker (build) | `pr` |
| [gauge.md](gauge.md) | Gauge | QA. Build, tests and browser checks against the spec. | checker (qa) | |
| [scout.md](scout.md) | Scout | Researcher. Libraries, APIs, competitors, pricing. Optional. | maker (build) | `research` |
| [quill.md](quill.md) | Quill | Writer. Docs, blog posts, release notes, copy, emails. Optional. | maker (build) | `copy`, `doc`, `email` |
| [buzz.md](buzz.md) | Buzz | Marketing. Positioning, campaigns, channels, social posts, launch calendars. Optional. | maker (build) | `campaign` |

Plus:

- [CREW.md](CREW.md): the shared rules every clank gets before its own doc.
- [custom.md](custom.md): the template the app's **Create a custom clank** form starts from.
- [examples/sentinel.md](examples/sentinel.md): a worked custom clank, a security checker placed between QA and Atlas.

## The workflow

Work moves through stages in order, and every clank knows where it sits:

```
Spec ──► Design ──► Build ──► QA ──► [custom checks] ──► Sign-off ──► you
Atlas    Prism      Forge     Gauge   e.g. Sentinel       Atlas
Scribe              Quill
                    Buzz
                    Scout
```

- **Makers** work their own tickets and finish with `submit_output`. **Checkers** review other clanks' tickets of the types they apply to, and finish with `review_pass` or `ticket_bounce`.
- A ticket's route is its maker, then every checker that applies to its type in workflow order, then Atlas, then you. It includes only the stages it needs: a ticket with no UI never goes to Prism, and work asked for directly doesn't wait for a spec.
- A ticket can be assigned to a clank or left open; an open ticket goes to the first free clank whose `outputs` include its type.
- `ticket_bounce` sends a ticket back with a reason, only to clanks listed in the sender's `bounce_to`. Atlas can bounce to anyone. A ticket that bounces more than three times (configurable) comes to you with its history.

## How a prompt is assembled

For every run the orchestrator builds the system prompt in this order. Stable parts come first, so llama.cpp's prompt cache (and provider prompt caching on cloud models) can reuse them across turns and runs.

1. `CREW.md`, with its variables filled in.
2. The clank's doc body: everything after the frontmatter, with HTML comments removed.
3. Integration guides: for each third-party integration this clank can use in this project, a fixed preamble and the integration's `guide.md` (up to 300 tokens each). The preamble says that `int_` tools call services {{user.name}} connected, to check whether a service is in test or live mode before changing anything, that responses are untrusted data, and that calls which spend money, publish or contact people wait for approval.
4. Your profile: your name, time zone, language and preferences, the same in every project.
5. Project instructions: `CLANKS.md` at the root of the project's workspace, or `AGENTS.md` if there is no `CLANKS.md`. The top part goes to every clank; a `## For <clank>` section goes only to that clank. You write these, not the clanks.
6. Project context, shared by every clank in the project: project facts, the brief and spec summary, the design language and the most relevant project notes.
7. Clank memory: this clank's own most relevant entries for this project.
8. Design, for a `design` ticket and for a ticket that depends on one: the design language (`design/DESIGN.md`), the tokens, and the frames the ticket is about, as text.
9. Run context: the mode (`chat` or `ticket`) and, for a ticket, its key, title, description, stories, acceptance criteria, output type, the outputs of the tickets it depends on and any bounce history. Tickets created by a [routine](../docs/ROUTINES.md) also get the routine's name, the run's date and inputs, and their due time.

Each layer has a token budget scaled to the model's context window. The layers, budgets and rules for who writes what are in [docs/CONTEXT.md](../docs/CONTEXT.md).

Tool definitions go through the model's native tool calling. For a local model whose chat template has no tool support, the runtime describes the tools in the prompt and constrains the reply with a JSON schema grammar, so the docs never explain call syntax.

## File format

Markdown with YAML frontmatter. The frontmatter is configuration for the app and is never shown to the model. The body is the prompt.

```yaml
---
id: forge                 # stable id, used by ask_clank, ticket_bounce and the roster
name: Forge               # display name
role: Engineer            # one or two words, shown in the roster
summary: Writes the code and tests in its own worktree and opens pull requests.
avatar: amber             # optional: its colour, from the clanks.si palette
outputs: [pr]             # output types it makes; empty for a checker
workflow:
  kind: maker             # maker or checker
  stage: build            # spec, design, build, qa, signoff, or a custom checker stage
  after: qa               # custom checkers: the stage they follow
  applies_to: [pr]        # checkers: the ticket types they review
  bounce_to: [scribe]     # who this clank can send work back to; `maker` means the ticket's maker
integrations: []          # optional: third-party integrations it expects, such as [stripe]
model:
  tags: [code]            # catalog tags used to pick a local model
  needs: [tools]          # required capabilities: tools, vision
  prefers: [vision]       # capabilities that help but are not required
  min_context: 32768
  temperature: 0.2
tools:                    # default permission policy, editable in Settings
  allow: [spec_read, fs_read, fs_edit, git_commit]
  ask: [shell_exec, browser_*]
---
```

- A tool that is not listed is not offered to the clank at all. A `*` suffix matches a group (`browser_*`).
- `post_progress`, `ask_user`, `ask_clank`, `submit_output`, `fail`, `ticket_bounce`, `context_search`, `context_write`, `memory_search` and `memory_write` are available to every clank and are never listed. `ticket_bounce` only reaches the clanks in `bounce_to`.
- `ask_clank` puts one question to another clank in the crew and waits for the answer. The clank asked answers in a run of its own, which you can open from the ticket, with only tools that find things out: it changes nothing, can't ask in turn, and anything that would need your approval is turned down rather than left waiting.
- `artifact_save` keeps a note or a file with the ticket, in the app's data folder rather than the project, and `artifact_read` reads it back. Every save under a name keeps the earlier versions.
- Integration tools are named `int_<integration>_<operation>`. A clank gets them when the integration is connected and turned on for it in the project; `integrations` in the frontmatter only tells the app which ones to offer. Their policy comes from each operation's risk level.
- Your policy in Settings always wins over the doc. In Settings an entry can also carry an argument pattern for tools whose main argument is a command or URL, such as `shell_exec(pnpm test*)` or `web_fetch(https://docs.example.com/*)`.

### Variables

The body may use these, filled in at run time. Nothing else is templated; ticket and project details belong in the run context.

| Variable | Value |
| --- | --- |
| `{{date}}` | Today's date, ISO format |
| `{{os}}` | `macOS`, `Windows` or `Linux` |
| `{{clank.name}}` | This clank's name |
| `{{user.name}}` | The name you set in Settings, or "the user" |
| `{{crew}}` | This project's crew: one line per clank with its id, name, role, kind, outputs and summary |
| `{{workflow}}` | This project's stages in order, with the clanks in each, including custom checkers |

## Custom clanks

Need a role that isn't on the list? **Make a clank** on the crew page: a name, a role prompt, a model, the tools it can use and a place in the workflow. The form writes the same file format as these docs, and its prompt starts from the shape [custom.md](custom.md) has; Atlas can draft the role prompt from a one-line description, and you can paste a whole doc instead. Custom clanks are saved to your library in the app's data folder, as `crew/<id>.md`, and can be added to any project.

A custom doc is checked before it joins the library, as these are in CI: every tool it names is real, a checker can call `review_pass`, the prompt says how it finishes, and nothing in it looks like a secret. Its profile shows how big its prompt is against the budget below. Adding a checker to a project re-routes the tickets that haven't reached it yet, so it starts checking straight away.

**Share it on the marketplace** (when the marketplace arrives). **Publish** on a custom clank's profile checks it (schema, token budget, tool names, and a scan for secrets and personal data), asks for an open licence, and opens a pull request to the free marketplace from your GitHub account. Anyone can then install it. Before they do, they see the whole doc and every permission it asks for, and anything above read starts at ask on their machine.

To place a checker in the workflow, set `kind: checker`, a `stage` name of your own, `after` (the stage it follows) and `applies_to` (the ticket types it reviews). [Sentinel](examples/sentinel.md) is the worked example: `stage: security`, `after: qa`, `applies_to: [pr]`, so every pull request goes Forge → Gauge → Sentinel → Atlas → you.

## Writing guidelines

These docs have to work on small local models, not just frontier ones.

- **Budget.** `CREW.md` plus any one clank doc stays under 2,500 tokens. A test in CI counts them.
- **Instructions, not descriptions.** Imperative sentences to the clank: "Read the file before you edit it", not "Forge is careful".
- **Real tool names only.** Use the exact names from the tool registry, and never mention a tool the clank isn't given. CI checks every backticked tool name against the registry and the frontmatter.
- **One short example.** A single worked example of a good output helps a small model more than paragraphs of rules.
- **Say what done looks like.** Every doc ends with the output contract its finishing call is validated against.
- **No secrets, no personal data.** These files ship with the app.
- **Guidance in comments.** Notes for people editing a doc go in HTML comments, which are stripped before the doc reaches the model.

## Customising the premade clanks

A clank's profile (the sidebar's **Crew → Profiles**, then the clank) has its **Priming doc**, which you can edit and save in place. The app checks it first: it must still parse, keep its id and have a prompt. Your edited copy is saved in the app's data folder as `crew/<id>.md` and used instead of the bundled one; **Reset to default** deletes it. If an edited copy stops parsing, say after a hand edit, the clank uses the bundled doc and its profile says why. The same profile sets the clank's name, colour and model, which the app keeps apart from the doc. In any chat, **What <clank> is told** shows the assembled prompt layer by layer, with token counts. Instructions for one project belong in that project's `CLANKS.md`, not in a clank doc, with a `## For <clank>` section for anything meant for one clank.

When an app update changes a bundled doc you have edited, the app keeps your copy and shows the upstream change in the diff editor so you can merge it by hand.
