import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TRPCProvider, trpcClient } from './lib/trpc';
import './styles.css';

// The title bar makes room for macOS's traffic lights.
if (navigator.userAgent.includes('Macintosh')) document.documentElement.dataset.platform = 'mac';

// The orchestrator is local and owns the state, so there's no point refetching on focus.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <App />
      </TRPCProvider>
    </QueryClientProvider>
  </StrictMode>,
);
