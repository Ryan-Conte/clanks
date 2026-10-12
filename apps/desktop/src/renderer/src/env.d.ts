/// <reference types="vite/client" />

import type { ClanksIpcBridge } from '../../shared/ipc';

declare global {
  interface Window {
    /** The orchestrator, through the preload script. Use the tRPC client, not this directly. */
    clanksIpc: ClanksIpcBridge;
  }
}
