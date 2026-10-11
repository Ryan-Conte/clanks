# Projects and the board

Every project has its own crew, its own workspace and its own board.

## The crew

| Clank | What it does |
| --- | --- |
| **Atlas** | The lead. Talks to you, plans, writes tickets and signs every ticket off. Always in. |
| **Scribe** | Turns an idea into a spec: user stories and acceptance criteria. |
| **Prism** | Designs in Studio: tokens, components and screens. |
| **Forge** | Writes the code, on a branch of its own. |
| **Gauge** | Runs the build, the tests and the page in a browser, against each criterion. |
| **Scout** | Researches, with sources. |
| **Quill** | Writes docs, copy and emails. |
| **Buzz** | Plans campaigns and drafts posts. |

You can make clanks of your own on the Crew page, and install others from the marketplace.

## From an idea to tickets

Tell Atlas what you want. For a feature it starts a spec: Scribe writes the stories and criteria, Atlas checks them, and you approve. Nothing is built before that. Atlas then turns the spec into tickets. Work you ask for directly, such as "set up a Next.js app", becomes a ticket straight away.

## The board

Tickets move through **Backlog**, **Build**, **QA + review**, **Ready for you** and **Done**. Each card shows who has it and what that clank is doing right now.

- A ticket's **route** is its maker, the checks for its kind of work, Atlas, then you.
- A check that finds a problem **sends the ticket back** with numbered issues. After three trips it comes to you.
- **Needs you** lists everything waiting on you: sign-offs, questions, approvals and failed runs.
- Drag backlog cards to put them in order, or onto a clank to reassign. Nothing is approved by a drag.

## Watching the work

Open any card and press **Watch** to follow its run: the diff of every file it changes, the page it has open in the built-in browser, the commands it runs, and the canvas for a design. You can reject a change, edit a file yourself, comment on a line, or take over the browser, and the clank is told.

## Approving

A ticket in **Ready for you** has been checked and signed off. Open it and:

- **Approve** merges the work: the pull request on GitHub or GitLab, or the branch into your folder. For an email, **Approve and send** sends it from your own account.
- **Request changes** sends your words back to its maker.
- **Reject** ends it, unmerged.

## Context and memory

The **Context** tab holds what the whole crew should know about the project: facts, decisions, conventions. You and the crew both add to it. Each clank also keeps a memory of its own, which is why you can ask Forge why it picked a library. A `CLANKS.md` at the root of the project holds your instructions, with a `## For Forge` section for any clank that needs its own.

## Budgets

A project, and each clank in it, can have a limit in tokens, minutes of model time or money. When one is reached, runs pause and say so.
