import { useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useTRPC } from './trpc';

/** Integrations and the accounts connected to each, kept live: a sign-in finishes in the background. */
export function useIntegrations() {
  const trpc = useTRPC();
  const initial = useQuery(trpc.integrations.list.queryOptions());
  const live = useSubscription(trpc.integrations.live.subscriptionOptions());
  return live.data ?? initial.data;
}

/** What the marketplaces list and what's installed from them, kept live. */
export function useMarketplace() {
  const trpc = useTRPC();
  const initial = useQuery(trpc.marketplace.snapshot.queryOptions());
  const live = useSubscription(trpc.marketplace.live.subscriptionOptions());
  return live.data ?? initial.data;
}

/** A marketplace's address as a person reads it: its host, or a folder's last part. */
export function indexLabel(url: string): string {
  if (/^https:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      const repo = /^\/([^/]+\/[^/]+)\//.exec(parsed.pathname)?.[1];
      return parsed.host === 'raw.githubusercontent.com' && repo
        ? `github.com/${repo}`
        : parsed.host;
    } catch {
      return url;
    }
  }
  // A folder: its last two parts say enough, and the whole path is in Settings.
  const parts = url.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : url;
}
