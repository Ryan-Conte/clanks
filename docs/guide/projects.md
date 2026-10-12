# Projects and the board

Every project has its own crew, its own workspace and its own board. You only ever have to talk to one of them: Atlas, the lead.

## The conversation

A project opens on its **Overview**: your conversation with Atlas, with the crew at work beside it.

- **Say what you want** to Atlas. It plans the work, hands it to the right clanks, and checks it before it comes back to you.
- **Everything that needs you comes to this conversation**, whichever clank it's from: a question one of them has, with its options as buttons; something risky one of them wants to do, to allow or refuse; finished work, with **Approve**, **Ask for changes** and **Reject**; and a routine's posts, before any go out. You never have to go and find the clank that asked.
- **Each piece of work is its own message**, with what was made in it: a document or the spec as a page you can open in place, a research note with its sources and a picture of each page, a design's pictures, and a website as it looked when it was checked. Click any picture to look closer. It stays in the thread after you've approved it.
- **Show Atlas what you mean.** Paste a screenshot into the box, drop a picture on it, or use the picture button: a sketch, a site you like, a photo of the shop. Up to four go with a message. A model that can see pictures looks at them; one that can't tells you so.
- **Beside the conversation** is the crew, each with what it's doing this moment, and the work as a plain list with how far along it is. Click a clank that's working to watch it; click a piece of work to see everything about it.
- **Watch the work** opens the files a clank changes, the commands it runs and the pages it opens, as it happens.

The other tabs are there when you want them: the **Board**, the **Spec**, **Studio** for designs, **Routines**, **Knowledge** and **Settings**.

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

Tickets move through **To do**, **In progress**, **Being checked**, **Ready for you** and **Done**. Each card shows who has it and what that clank is doing right now. (The crew's own words for the first three are backlog, build and review, and you'll see them say so.)

- A ticket's **route** is its maker, the checks for its kind of work, Atlas, then you.
- A check that finds a problem **sends the ticket back** with numbered issues. After three trips it comes to you.
- **Needs you** lists everything waiting on you: sign-offs, questions, approvals and failed runs.
- Drag cards in **To do** to put them in order, or onto a clank to reassign. Nothing is approved by a drag.

## Watching the work

Open any card and press **Watch** to follow its run: the diff of every file it changes, the page it has open in the built-in browser, the commands it runs, and the canvas for a design. You can reject a change, edit a file yourself, comment on a line, or take over the browser, and the clank is told.

## Approving

A ticket in **Ready for you** has been checked by the crew and by Atlas. It shows in your conversation with Atlas, and on the board. There:

- **Approve** adds the work to your project: it merges the pull request on GitHub or GitLab (**Approve and merge**), or the branch into your folder. For an email, **Approve and send** sends it from your own account.
- **Ask for changes** sends your words back to its maker.
- **Reject** ends it, unmerged.

## Knowledge and memory

The **Knowledge** tab holds what the whole crew should know about the project: facts, decisions, conventions. You and the crew both add to it. Each clank also keeps a memory of its own, which is why you can ask Forge why it picked a library. A `CLANKS.md` at the root of the project holds your instructions, with a `## For Forge` section for any clank that needs its own.

## Budgets

A project, and each clank in it, can have a limit in tokens, minutes of model time or money. When one is reached, runs pause and say so.
