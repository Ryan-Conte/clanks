/** What's set when the main process is built. electron-vite fills in `MAIN_VITE_*`. */
interface ImportMetaEnv {
  /** Where crash reports go, for a build that has somewhere to send them. */
  readonly MAIN_VITE_CLANKS_CRASH_URL?: string;
  /** The GitHub OAuth app signing in with a code goes through, for a build that has one. */
  readonly MAIN_VITE_CLANKS_GITHUB_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
