# Getting started

clanks is a desktop app for macOS, Windows and Linux. It runs a crew of AI agents, your clanks, on your own computer. There's no account to make and nothing else to install.

## Install it

Download the installer for your computer from [clanks.si](https://clanks.si) and open it.

- **macOS:** open the `.dmg` and drag clanks to Applications.
- **Windows:** run the setup program. It installs for you alone, with no administrator prompt.
- **Linux:** make the `.AppImage` executable and run it, or install the `.deb`.

## First run

1. **Your machine is sized up.** clanks looks at your graphics card and memory and recommends a model that fits. With 16 GB of memory and no graphics card that's one small model for the whole crew; with a 24 GB card, a much more capable one.
2. **Pull the model.** It's downloaded once from Hugging Face, checked by its sha256, and kept in clanks' own folder. From then on it runs offline.
3. **Give it to the crew.** Every clank uses it unless you give one a model of its own later.
4. **Watch the sample project,** if you like. It makes a small project in `~/clanks/coffee-cart` with two tickets: Quill writes the copy for a one-page site, and Forge builds the page from it. You read the copy and approve it, watch Forge's files change, see Gauge check the page in the built-in browser, and approve the result. Nothing leaves your computer.

You can skip either step. **Models** in the sidebar pulls a model later, and **New project** starts your own.

## Your first project

**New project** asks four things:

1. **A name**, and a line about what you're making.
2. **A workspace:** a folder on your computer, or one of your GitHub or GitLab repositories, cloned for you. A folder that isn't a git repository is made one, because the crew works on copies of it.
3. **The crew:** tick the clanks you want. Atlas, the lead, is always in.
4. **The models:** one for the whole crew, or one per clank.

You can also start from a template, such as **Ship a feature** or **Plan a launch**. A template picks a crew and tells Atlas what you want in your own words, in a chat you can read and steer.

Then talk to Atlas. Say what you want built, answer its questions, and approve the spec it brings back. The [board](projects.md) shows the rest.

## Closing the window

Closing the window leaves clanks running in the tray, so the crew carries on. **Quit clanks** in the tray's menu stops everything. Settings → In the background changes that.
