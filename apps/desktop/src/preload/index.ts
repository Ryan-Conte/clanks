import { type IpcRendererEvent, contextBridge, ipcRenderer } from 'electron';
import {
  type ClanksIpcBridge,
  IPC_REQUEST,
  IPC_SUBSCRIPTION,
  IPC_SUBSCRIPTION_EVENT,
  type IpcResponse,
  type IpcSubscriptionEvent,
} from '../shared/ipc';

// The window gets this bridge and nothing else: no Node, no raw ipcRenderer.
const bridge: ClanksIpcBridge = {
  request: (request) => ipcRenderer.invoke(IPC_REQUEST, request) as Promise<IpcResponse>,
  subscription: (message) => ipcRenderer.send(IPC_SUBSCRIPTION, message),
  onSubscriptionEvent: (listener) => {
    const handle = (_event: IpcRendererEvent, message: IpcSubscriptionEvent) => listener(message);
    ipcRenderer.on(IPC_SUBSCRIPTION_EVENT, handle);
    return () => {
      ipcRenderer.removeListener(IPC_SUBSCRIPTION_EVENT, handle);
    };
  },
};

contextBridge.exposeInMainWorld('clanksIpc', bridge);
