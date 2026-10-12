# Integrations and the marketplace

## Connecting a service

Settings → Connections lists the services clanks can work with: Stripe, Notion, Slack, Vercel, Google Analytics and X ship with the app. For each you can see every address it calls and everything it can do before you connect anything.

1. **Connect** an account with an API key or by signing in. The key or token goes into your operating system's keychain. The app can use it; nothing can read it back, including the window.
2. **Turn it on in a project**, in the project's Settings, for the clanks you choose there. A connection does nothing until you do.

A service that offers test credentials, such as Stripe, is connected in **test** or **live** mode, shown on every approval and every ticket that could use it.

## What a clank may do with it

- **Reading** runs without asking.
- **Changing something** asks first. You can allow it for the project.
- **Anything that spends money, publishes, deletes or contacts people** asks every time. No setting turns that off. A [routine](routines.md) can get that approval ahead of time, for one exact post at one exact time.

## X

Posting to X needs a developer app of your own, since X has no client anyone can use. At developer.x.com, make an app with OAuth 2.0 as a native app, with read and write permission and the callback address `http://127.0.0.1:8739/callback`, and paste its client id when you connect. How much you can post depends on your X API plan.

## The marketplace

The **Marketplace** page lists what people have shared: clanks, integrations, crews, routines to start from and project templates. It's free to install from and free to publish to, with no account and nothing counted.

- **Before you install,** you see all of it: a clank's whole prompt and every tool it asks for, an integration's every address and operation, a routine's every step. It's checked against its checksum, and what you install is exactly what you saw.
- **A clank from the marketplace can't give itself permissions.** Whatever its prompt asks, anything beyond reading starts at "ask".
- **An update** shows what changed, as a diff, with any new tool or address pointed out. Accept it, or stay on the version you have.
- **Publishing** is on a clank you made, or an integration you added from a folder. It shows what would be sent, asks for an open licence, and opens a pull request from your GitHub account.

A team can add a marketplace of its own in Settings → Connections, under Marketplaces.

## Integrations of your own

An integration is three files in a folder: a manifest, a trimmed OpenAPI description and a short guide for the clanks. No code runs. **Add from a folder** takes one you wrote, which may also call a server on your own computer.
