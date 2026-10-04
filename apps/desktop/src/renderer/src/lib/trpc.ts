import type { AppRouter } from '@clanks/orchestrator';
import { createTRPCClient } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { ipcLink } from './ipc-link';

export const trpcClient = createTRPCClient<AppRouter>({
  links: [ipcLink(window.clanksIpc)],
});

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();
