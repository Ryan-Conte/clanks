export const REPO = 'https://github.com/Ryan-Conte/clanks';
export const MARKETPLACE = 'https://github.com/Ryan-Conte/clanks-marketplace';

/**
 * The newest release's installers. Their names carry no version, so these always fetch the latest
 * (see docs/RELEASING.md).
 */
const LATEST = `${REPO}/releases/latest/download`;

export type Platform = 'mac' | 'windows' | 'linux';

export interface Download {
  platform: Platform;
  name: string;
  detail: string;
  href: string;
  /** Another way to install it, such as the .deb beside the AppImage. */
  alt?: { label: string; href: string };
}

export const DOWNLOADS: Download[] = [
  {
    platform: 'mac',
    name: 'macOS',
    detail: 'Apple silicon · .dmg',
    href: `${LATEST}/clanks-arm64.dmg`,
  },
  {
    platform: 'windows',
    name: 'Windows',
    detail: 'x64 · setup .exe',
    href: `${LATEST}/clanks-setup-x64.exe`,
  },
  {
    platform: 'linux',
    name: 'Linux',
    detail: 'x86_64 · .AppImage',
    href: `${LATEST}/clanks-x86_64.AppImage`,
    alt: { label: '.deb', href: `${LATEST}/clanks-amd64.deb` },
  },
];

export const NAV = [
  { label: 'Crew', href: '/#crew' },
  { label: 'How it works', href: '/#how' },
  { label: 'Workbench', href: '/#workbench' },
  { label: 'Local models', href: '/#models' },
  { label: 'Routines', href: '/#routines' },
  { label: 'Docs', href: '/docs/' },
];

export const DESCRIPTION =
  "clanks gives every project its own crew of AI helpers on your computer: a Lead, a BA, a Designer, Engineers, QA, writers and marketers. They plan it, make it, check each other's work, and ask you before anything ships. Free, open source, and it runs on your own machine.";

/** The guides in docs/guide, in the order its README lists them. The README itself is /docs/. */
export const GUIDE_ORDER = [
  'getting-started',
  'models',
  'projects',
  'routines',
  'integrations',
  'privacy',
  'troubleshooting',
];
