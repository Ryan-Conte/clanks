/**
 * The wire protocol tRPC uses between the window and the orchestrator over Electron IPC.
 * Electron's structured clone carries Dates, Maps and Sets, so no transformer is needed.
 */

export const IPC_REQUEST = 'clanks:trpc:request';
export const IPC_SUBSCRIPTION = 'clanks:trpc:subscription';
export const IPC_SUBSCRIPTION_EVENT = 'clanks:trpc:subscription-event';

export interface IpcRequest {
  type: 'query' | 'mutation';
  path: string;
  input: unknown;
}

/** The error shape tRPC formats on the server, as `TRPCClientError` expects it. */
export interface IpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export type IpcResponse = { ok: true; data: unknown } | { ok: false; error: IpcErrorShape };

export type IpcSubscriptionMessage =
  { kind: 'start'; id: number; path: string; input: unknown } | { kind: 'stop'; id: number };

export type IpcSubscriptionEvent =
  | { id: number; kind: 'started' }
  | { id: number; kind: 'data'; data: unknown }
  | { id: number; kind: 'error'; error: IpcErrorShape }
  | { id: number; kind: 'complete' };

/** What the preload script exposes to the window as `window.clanksIpc`. Nothing else is exposed. */
export interface ClanksIpcBridge {
  request(request: IpcRequest): Promise<IpcResponse>;
  subscription(message: IpcSubscriptionMessage): void;
  onSubscriptionEvent(listener: (event: IpcSubscriptionEvent) => void): () => void;
}
