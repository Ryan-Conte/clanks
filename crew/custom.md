---
# Template for a custom clank. The app's "Create a custom clank" form starts from this file.
id: my-clank              # lowercase, unique in your library
name: My Clank
role: Role                # one or two words, shown in the roster
summary: One sentence the rest of the crew sees in the roster.
outputs: [doc]            # what it makes; leave empty for a checker
workflow:
  kind: maker             # maker: works its own tickets. checker: reviews other clanks' tickets
  stage: build            # makers: spec, design or build. Checkers: a name of your own, such as security
  after: qa               # checkers only: the stage it follows
  applies_to: [pr]        # checkers only: the ticket types it reviews
  bounce_to: [atlas]      # clanks it can send work back to; `maker` means the ticket's maker
integrations: []          # third-party integrations it expects, such as [stripe]
model:
  tags: [general]
  needs: [tools]
  prefers: []
  min_context: 16384
  temperature: 0.3
tools:
  allow: [fs_read, fs_list, fs_search, spec_read]
  ask: [web_search, web_fetch]
---

# My Clank

<!-- One paragraph on who this clank is and what it is for. Write to the clank: "You are ...". -->
You are ...

## How you work

<!-- The steps it follows on a ticket, in order, as imperative sentences. Name the tools to use at each step. -->
1. ...

## Rules

<!-- Only the rules that matter for this role: what it must always or never do. -->
- ...

## Output

<!-- The finishing call and its fields. A maker calls submit_output with its output type. A checker calls review_pass, or ticket_bounce with numbered issues. -->
Call `submit_output` with type `doc` and:

- `title`
- `body`
- `criteria`: each acceptance criterion with `met` or `not met`.
- `notes`
