import type { AXNode, CdpSession } from '../cdp';

/** A node for a test page's accessibility tree, nested as it reads. */
export interface AXSpec {
  role: string;
  name?: string;
  value?: string;
  props?: Record<string, unknown>;
  backend?: number;
  ignored?: boolean;
  children?: AXSpec[];
}

export function ax(role: string, name = '', rest: Omit<AXSpec, 'role' | 'name'> = {}): AXSpec {
  return { role, name, ...rest };
}

/** Flattens a nested tree into the list `Accessibility.getFullAXTree` returns. */
export function axTree(root: AXSpec): AXNode[] {
  const nodes: AXNode[] = [];
  let next = 1;
  const walk = (spec: AXSpec, parentId?: string): string => {
    const nodeId = String(next++);
    const node: AXNode = {
      nodeId,
      ignored: spec.ignored ?? false,
      role: { type: 'role', value: spec.role },
      ...(spec.name ? { name: { type: 'computedString', value: spec.name } } : {}),
      ...(spec.value !== undefined ? { value: { type: 'string', value: spec.value } } : {}),
      ...(spec.props
        ? {
            properties: Object.entries(spec.props).map(([name, value]) => ({
              name,
              value: { type: typeof value === 'boolean' ? 'boolean' : 'string', value },
            })),
          }
        : {}),
      ...(parentId ? { parentId } : {}),
      ...(spec.backend !== undefined ? { backendDOMNodeId: spec.backend } : {}),
    };
    nodes.push(node);
    node.childIds = (spec.children ?? []).map((child) => walk(child, nodeId));
    return nodeId;
  };
  walk(root);
  return nodes;
}

/** A page that answers CDP commands from handlers, and records what it was sent. */
export function fakeCdp(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  let listener: ((method: string, params: Record<string, unknown>) => void) | undefined;
  const session: CdpSession = {
    send<T>(method: string, params: Record<string, unknown> = {}) {
      sent.push({ method, params });
      const handler = handlers[method];
      try {
        return Promise.resolve((handler ? handler(params) : {}) as T);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    on(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    session,
    sent,
    emit: (method: string, params: Record<string, unknown>) => listener?.(method, params),
    calls: (method: string) => sent.filter((s) => s.method === method).map((s) => s.params),
  };
}
