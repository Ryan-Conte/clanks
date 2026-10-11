# Releasing

How a version of clanks gets from this repository to someone's computer. The app has no server of its own: a release is a set of files on this repository's GitHub releases page, which clanks.si links to and the app's updater reads.

## Cutting a release

1. Set the version in `apps/desktop/package.json`, such as `0.2.0`, and commit it.
2. Tag that commit `v0.2.0` and push the tag.
3. The [release workflow](../.github/workflows/release.yml) checks the tag against the version, builds on macOS, Windows and Linux, signs what it has certificates for, and uploads everything to a **draft** release.
4. Read the draft: the installers, and `latest.yml`, `latest-mac.yml` and `latest-linux.yml`, which the updater reads. Write the notes; the app shows them beside the update.
5. Publish the draft. That is what ships it: installed copies find it the next time they look, and clanks.si's download buttons point at it.

`pnpm package` builds the same installers on your own machine and never uploads anything.

## What a release holds

| Platform | Files | Updates itself |
| --- | --- | --- |
| macOS | `clanks-arm64.dmg`, and a `.zip` the updater uses | Yes, once signed and notarised |
| Windows | `clanks-setup-x64.exe` | Yes |
| Linux | `clanks-x86_64.AppImage`, `clanks-amd64.deb` | The AppImage does; a `.deb` is replaced by installing a newer one |

The names carry no version, so `https://github.com/Ryan-Conte/clanks/releases/latest/download/<file>` always fetches the newest.

## Signing

Unsigned builds work for testing and are what CI makes, with `CSC_IDENTITY_AUTO_DISCOVERY=false`. A release wants signed ones: macOS won't open an unsigned download without a detour through System Settings, and won't update one at all, and Windows shows a SmartScreen warning.

The release workflow reads these repository secrets. None is in this repository.

| Secret | What it is |
| --- | --- |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | A Developer ID Application certificate as a base64 `.p12`, and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | What notarising needs. An App Store Connect API key works too: see electron-builder's notarisation docs |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | A Windows code-signing certificate as a base64 `.pfx`, and its password |
| `CLANKS_CRASH_URL` | Optional. Where opt-in crash reports are sent. Without it, reports only ever stay on the user's computer |
| `CLANKS_GITHUB_CLIENT_ID` | Optional. A GitHub OAuth app's client id, so users can sign in with a code instead of pasting a token |

macOS builds use the hardened runtime with the entitlements in `apps/desktop/build/entitlements.mac.plist`: what Electron's JavaScript engine needs, and library validation off so the bundled llama.cpp server can load its own libraries.

## Checking a release before publishing it

- Install it on a machine it wasn't built on, with no development tools on it.
- Start it with an empty data folder and go through first run: a model pulls, the crew gets it, and the sample project's first ticket starts.
- From the version before, Settings → Updates finds it, fetches it and restarts into it.
- On macOS, `spctl -a -vv /Applications/clanks.app` says "accepted" and "Notarized Developer ID".

## The landing page

clanks.si is its own repository. Its download buttons link to the latest release's files by the names above, and its `/docs` pages are copies of [`docs/guide`](guide/README.md), brought over with `npm run docs:sync` there.
