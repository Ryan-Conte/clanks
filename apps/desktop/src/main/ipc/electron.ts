import { type WebContents, ipcMain } from 'electron';
import {
  IPC_REQUEST,
  IPC_SUBSCRIPTION,
  IPC_SUBSCRIPTION_EVENT,
  type IpcRequest,
  type IpcSubscriptionMessage,
} from '../../shared/ipc';
import type { IpcHandler } from './server';

/**
 * Connects the handler to Electron IPC. Only windows `isTrusted` accepts are served: the app
 * window, never the browser pane or anything else that might load content.
 */
export function attachIpcHandler(
  handler: IpcHandler,
  isTrusted: (sender: WebContents) => boolean,
): void {
  const watched = new WeakSet<WebContents>();

  ipcMain.handle(IPC_REQUEST, (event, request: IpcRequest) => {
    if (!isTrusted(event.sender)) throw new Error('This window is not allowed to call clanks');
    return handler.request(request);
  });

  ipcMain.on(IPC_SUBSCRIPTION, (event, message: IpcSubscriptionMessage) => {
    const sender = event.sender;
    if (!isTrusted(sender)) return;
    if (!watched.has(sender)) {
      watched.add(sender);
      const stop = () => handler.stopAll(sender.id);
      sender.on('did-start-loading', stop);
      sender.once('destroyed', stop);
    }
    handler.subscription(sender.id, message, (subscriptionEvent) => {
      if (!sender.isDestroyed()) sender.send(IPC_SUBSCRIPTION_EVENT, subscriptionEvent);
    });
  });
}
