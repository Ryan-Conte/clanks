/**
 * A connection to one page over the Chrome DevTools Protocol. In the app it's Electron's
 * `webContents.debugger`; tests use a stand-in.
 */
export interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Calls `listener` with every event the page sends. Returns how to stop. */
  on(listener: (method: string, params: Record<string, unknown>) => void): () => void;
}

/** Something a browser tool couldn't do, worded for the clank. */
export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

/** A value in the accessibility tree, as `Accessibility.getFullAXTree` reports it. */
export interface AXValue {
  type: string;
  value?: unknown;
}

export interface AXProperty {
  name: string;
  value: AXValue;
}

/** One node of a page's accessibility tree. */
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  properties?: AXProperty[];
  parentId?: string;
  childIds?: string[];
  /** The DOM node it stands for, which clicks and typing act on. */
  backendDOMNodeId?: number;
  frameId?: string;
}

/** A JavaScript value in the page, as `Runtime` methods return it. */
export interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
  unserializableValue?: string;
}

export interface EvaluateResult {
  result: RemoteObject;
  exceptionDetails?: { text: string; exception?: RemoteObject };
}
