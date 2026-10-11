# Troubleshooting

## A model won't load, or is slow

- **"Too large"** on the Models page means it won't fit your memory. Pick a smaller one, or a smaller quantisation of the same one.
- **Slow replies** usually mean part of the model is on the CPU. The Models page shows where it loaded. Close other programs that use the graphics card, or lower the context per slot in Settings → Running models.
- **An NVIDIA card that isn't used:** the Models page offers the CUDA build as a download.
- **The reply was cut off:** the conversation outgrew the model's context. A run recovers by itself; in a chat, start a new one or use a model with more context.

## A ticket isn't moving

Its card says why. The usual reasons:

- **Waiting for a model or a free run.** It starts when one frees up. A project runs three at once unless you change that.
- **Paused: budget.** Raise the budget in the project's settings.
- **A question.** Open the card and answer it.
- **Paused, or failed.** Open it, read what happened, and press **Carry on**, with a note if the clank needs telling something.
- **Hold new work** is on, in the project's header.

## Work that keeps coming back

A ticket sent back three times comes to you with its history. Read the issues: usually the acceptance criteria can't be met as written, or contradict each other. Fix the ticket, or tell its maker what to do, and carry on.

## A merge that won't go through

Approving merges the work. If your folder has changes you haven't committed, or the branch conflicts with what's there, the ticket stays with you and says so. Commit or stash your changes, or use **Send back to resolve the conflicts**.

## A scheduled post didn't go out

Look at its card on the project's Routines tab. It says which:

- **Missed:** it wasn't approved by its time, or clanks wasn't running, or the computer was asleep. Use **Post now** or **Reschedule**.
- **Failed:** the service turned it down, and its own words are on the card. A revoked or expired account needs connecting again in Settings → Integrations.
- **Outcome unknown:** clanks stopped while sending it. Check the service, then say whether it went out. clanks won't send it again on a guess.

## Starting over

Your data folder is shown in Settings → This app. Quitting clanks and moving that folder aside gives you a fresh start, and moving it back restores everything.

## Reporting a problem

Open an issue at [github.com/Ryan-Conte/clanks](https://github.com/Ryan-Conte/clanks/issues) with what you did, what you expected, and your version from Settings → This app. `logs/errors.log` in the data folder often says more.
