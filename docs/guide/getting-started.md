# Getting started

clanks is a desktop app for macOS, Windows and Linux. It runs a crew of AI agents, your clanks, on your own computer. There's no account to make and nothing else to install.

## Install it

Download the installer for your computer from [clanks.si](https://clanks.si) and open it.

- **macOS:** open the `.dmg` and drag clanks to Applications.
- **Windows:** run the setup program. It installs for you alone, with no administrator prompt.
- **Linux:** make the `.AppImage` executable and run it, or install the `.deb`.

## First run

The first screen introduces the crew and has one button: **Download and set up**.

- clanks looks at your computer's graphics card and memory and picks a model that fits. With 16 GB of memory and no graphics card that's one small model for the whole crew; with a 24 GB card, a much more capable one.
- The model is downloaded once from Hugging Face, checked, and kept in clanks' own folder. On an NVIDIA card, the build that makes it fast is downloaded with it.
- When it lands, the crew is given it and you're taken to Home. You can close the window meanwhile; the download carries on, and picks up where it was after a restart.

**Other ways to set up** lists the other models that run on your computer, a way in for a cloud model with your own key, and **Skip for now**. The crew can't do anything until it has a model, and Home says so with a button back to this screen.

Home then offers a **sample project**, once: a one-page site for a coffee cart, in a folder of its own. Quill writes the page, Forge builds it, Gauge checks it and you approve. Nothing leaves your computer.

## Your first project

On **Home**, say what you want in the box, in your own words, and press Enter. That's all it needs:

- the project is named from what you wrote, which you can change from its **⋯** menu;
- it gets a new folder of its own in `~/clanks`;
- it gets the usual crew: Atlas, Scribe, Prism, Forge and Gauge;
- Atlas is told what you wrote, and you land in a conversation with it.

The chips under the box start from a template, such as **A landing page** or **A launch plan**. A template picks the crew for that kind of work and tells Atlas what to set up.

**More options**, under the box once you've started typing, opens the full form: a folder you already have, or one of your GitHub or GitLab repositories, copied to your computer; who's in the crew; a model for the project or for each clank; and the letters tickets are numbered with. A folder that isn't a git repository is made one, because the crew works on copies of it, so git has to be installed.

Then talk to Atlas. Answer its questions, and approve what the crew brings back. It all happens in that one [conversation](projects.md).

## Closing the window

Closing the window leaves clanks running in the tray, so the crew carries on. **Quit clanks** in the tray's menu stops everything. Settings → This app → In the background changes that.
