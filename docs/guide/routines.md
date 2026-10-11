# Routines

A routine is work that starts at a time, on a schedule or when something happens, and optionally something that goes out at a set time once you've approved it. "Every Monday at 9, Scout summarises last week's competitor pricing" is a routine. So is "every Friday afternoon, have Prism make a promo banner and post it on X at 5pm".

## Making one

- **Ask Atlas.** Say what you want in a project chat. Atlas drafts a routine and shows it as a card: what starts it, the next five times, each step with when it's due, and the rules. Edit it if you like, then press **Activate**. Nothing is scheduled until you do.
- **In the editor.** A project's **Routines** tab has **New routine**. Type the schedule in plain words, such as "every weekday at 9" or "first Monday of the month"; the editor reads it back as cron and as dates before you can save.
- **From a template** installed from the marketplace, or from YAML that someone exported.

## Steps

- A **ticket step** makes a ticket for a clank. It goes through the board like any ticket: its maker, its checks, Atlas.
- An **action step** calls a connected service at a time, such as posting to X, with what earlier steps made.

Each ticket is due a while before the first action that needs it, an hour unless you change it, so there's room to look it over.

## Approving what goes out

When a run's work is signed off, you get one card that shows everything it will send, exactly as it will appear: the words, the picture, the account and the time. Approve it all, or one at a time.

- Approving **freezes** it. clanks sends exactly that, at that time, with no model involved.
- **Changing** the words or the time afterwards asks for your approval again.
- Something **not approved by its time** doesn't go out.

## When your computer is off or asleep

Routines run inside clanks, so it has to be running at the time. Closing the window leaves it in the tray, which is enough.

- An action goes out at its time, or up to 15 minutes late. After that it's **missed**, and never sent on its own: a post meant for 5pm doesn't appear at 9. You get **Post now**, **Reschedule** and **Dismiss**.
- A run that was missed is skipped, started late, or left for you to decide, as the routine says.
- Settings → Routines can start clanks when you sign in, keep the computer awake while work is due, and have your operating system start clanks a few minutes before a run. On Windows that can wake a sleeping computer; on macOS and Linux it can't.
- Some services can hold a post themselves. A step handed over that way goes out even with your computer off.

## Pausing

Each routine has a switch. **Pause routines** in the tray, or in Settings, stops them all: nothing starts and nothing goes out until you turn it back on, and nothing is made up afterwards.

## Posts from a campaign

An approved campaign from Buzz has **Schedule the posts**. Each post with a time, a channel clanks can post to and an account is shown in full, and the ones you tick go out at their times.
