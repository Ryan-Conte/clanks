import type { BrowserDownload, BrowserTabInfo } from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState } from 'react';
import { useClank } from '../../lib/crew';
import { formatBytes } from '../../lib/format';
import { useTRPC } from '../../lib/trpc';
import { useWorkbench } from '../../lib/workbench';
import {
  BackIcon,
  Button,
  Dot,
  ErrorText,
  ForwardIcon,
  GlobeIcon,
  IconButton,
  RetryIcon,
  XIcon,
} from '../ui';

/**
 * The pages the clank opens, live: tabs, an address bar, Take over and Hand back, and downloads
 * waiting for the user. The page itself is a view the main process lays over this pane.
 */
export function BrowserPane({ clankId }: { clankId: string }) {
  const trpc = useTRPC();
  const { browser, conversationId, focus } = useWorkbench();
  const clank = useClank(clankId);
  const name = clank?.name ?? 'The clank';
  /** A step's picture, shown instead of the live page. */
  const [picture, setPicture] = useState<string | null>(null);
  const [seenFocus, setSeenFocus] = useState(0);
  if (focus && focus.nonce !== seenFocus) {
    setSeenFocus(focus.nonce);
    if (focus.image) setPicture(focus.image);
  }
  const takeOver = useMutation(trpc.browser.takeOver.mutationOptions());
  const handBack = useMutation(trpc.browser.handBack.mutationOptions());
  const select = useMutation(trpc.browser.select.mutationOptions());
  const close = useMutation(trpc.browser.close.mutationOptions());
  const reload = useMutation(trpc.browser.reload.mutationOptions());
  const error = [takeOver, handBack, select, close, reload].find((m) => m.error)?.error;

  if (!conversationId || !browser) return null;
  if (!browser.available) {
    return <p className="p-6 text-sm text-dim">There's no browser here.</p>;
  }
  const tab = browser.tabs.find((t) => t.id === browser.current) ?? null;
  const driving = browser.control === 'user';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {browser.tabs.length > 0 && (
        <div
          className="flex items-center gap-1 overflow-x-auto border-b border-line px-2 py-1"
          role="tablist"
          aria-label="Browser tabs"
        >
          {browser.tabs.map((t) => (
            <TabButton
              key={t.id}
              tab={t}
              current={t.id === browser.current}
              onSelect={() => {
                setPicture(null);
                select.mutate({ conversationId, tabId: t.id });
              }}
              onClose={() => close.mutate({ conversationId, tabId: t.id })}
            />
          ))}
        </div>
      )}
      {tab && <AddressBar conversationId={conversationId} tab={tab} driving={driving} />}
      {browser.tabs.length > 0 &&
        (driving ? (
          <div className="flex items-center gap-3 border-b border-amber-300/20 bg-amber-300/[0.07] px-3 py-1.5 text-[12px]">
            <Dot tone="amber" live={browser.waiting} />
            <span className="min-w-0 flex-1 text-amber-100">
              {browser.waiting
                ? `You have the browser. ${name} is waiting for it.`
                : `You have the browser. ${name}'s browsing is paused.`}
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={handBack.isPending}
              onClick={() => handBack.mutate(conversationId)}
            >
              Hand back
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[12px]">
            <Dot tone={browser.busy ? 'mint' : 'dim'} live={browser.busy} />
            <span className="min-w-0 flex-1 text-white/75">
              {browser.busy ? `${name} is browsing` : `${name}'s browser`}
            </span>
            <Button
              size="sm"
              disabled={takeOver.isPending}
              title={`Pause ${name}'s browsing so you can sign in, close a pop-up or steer. Hand back when you're done.`}
              onClick={() => takeOver.mutate(conversationId)}
            >
              Take over
            </Button>
          </div>
        ))}
      {browser.downloads.map((download) => (
        <DownloadRow key={download.id} conversationId={conversationId} download={download} />
      ))}
      {error && (
        <div className="border-b border-line px-3 py-1.5">
          <ErrorText>{error.message}</ErrorText>
        </div>
      )}
      {picture ? (
        <StepPicture path={picture} onLive={() => setPicture(null)} />
      ) : !tab ? (
        <p className="p-6 text-sm text-dim">
          Pages {name} opens show up here, so you can watch it browse. You can take over at any
          point to sign in or steer.
        </p>
      ) : (
        <>
          {tab.crashed && (
            <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-[13px]">
              <span className="flex-1 text-rose-200">This page crashed.</span>
              <Button size="sm" onClick={() => reload.mutate({ conversationId, tabId: tab.id })}>
                Reload
              </Button>
            </div>
          )}
          <Viewport conversationId={conversationId} tabId={tab.id} />
        </>
      )}
    </div>
  );
}

function TabButton(props: {
  tab: BrowserTabInfo;
  current: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { tab } = props;
  const label = tab.search ? 'Search' : tab.title || hostOf(tab.url) || 'New tab';
  return (
    <div
      className={`flex max-w-52 min-w-0 shrink-0 items-center gap-1 rounded-lg py-0.5 pr-0.5 pl-2 text-[12px] ${props.current ? 'bg-white/[0.08] text-white' : 'text-dim hover:bg-white/[0.04] hover:text-white'}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={props.current}
        onClick={props.onSelect}
        title={`${tab.handle}: ${tab.url}`}
        className="flex min-w-0 items-center gap-1.5"
      >
        {tab.loading ? <Dot tone="lavender" live /> : <GlobeIcon />}
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${label}`}
        title="Close this tab"
        onClick={props.onClose}
        className="grid size-5 shrink-0 place-items-center rounded text-dim hover:bg-white/10 hover:text-white"
      >
        <XIcon />
      </button>
    </div>
  );
}

/** Back, forward, reload and the address. The user can type an address while they drive. */
function AddressBar(props: { conversationId: string; tab: BrowserTabInfo; driving: boolean }) {
  const { conversationId, tab, driving } = props;
  const trpc = useTRPC();
  const [typed, setTyped] = useState<string | null>(null);
  const back = useMutation(trpc.browser.back.mutationOptions());
  const forward = useMutation(trpc.browser.forward.mutationOptions());
  const reload = useMutation(trpc.browser.reload.mutationOptions());
  const navigate = useMutation(
    trpc.browser.navigate.mutationOptions({ onSuccess: () => setTyped(null) }),
  );
  const steer = driving ? undefined : 'Take over to steer';
  const target = { conversationId, tabId: tab.id };
  return (
    <form
      className="flex flex-col gap-1 border-b border-line px-2 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (typed?.trim()) navigate.mutate({ conversationId, url: typed.trim() });
      }}
    >
      <div className="flex items-center gap-1">
        <IconButton
          label={steer ?? 'Back'}
          disabled={!driving || !tab.canGoBack}
          onClick={() => back.mutate(target)}
        >
          <BackIcon />
        </IconButton>
        <IconButton
          label={steer ?? 'Forward'}
          disabled={!driving || !tab.canGoForward}
          onClick={() => forward.mutate(target)}
        >
          <ForwardIcon />
        </IconButton>
        <IconButton
          label={steer ?? 'Reload'}
          disabled={!driving}
          onClick={() => reload.mutate(target)}
        >
          <RetryIcon />
        </IconButton>
        <input
          aria-label="Address"
          readOnly={!driving}
          title={driving ? 'Type an address and press Enter' : tab.url}
          value={typed ?? tab.url}
          onChange={(e) => setTyped(e.target.value)}
          onFocus={(e) => driving && e.target.select()}
          onKeyDown={(e) => e.key === 'Escape' && setTyped(null)}
          className={`h-7 min-w-0 flex-1 rounded-full border border-line bg-black/30 px-3 font-mono text-[12px] focus:outline-none ${driving ? 'text-white focus:border-accent/60' : 'text-white/60'}`}
        />
      </div>
      {navigate.error && <ErrorText>{navigate.error.message}</ErrorText>}
    </form>
  );
}

/** A download a page started, until the user decides, and how it went after. */
function DownloadRow({
  conversationId,
  download,
}: {
  conversationId: string;
  download: BrowserDownload;
}) {
  const trpc = useTRPC();
  const decide = useMutation(trpc.browser.decideDownload.mutationOptions());
  const dismiss = useMutation(trpc.browser.dismissDownload.mutationOptions());
  const size = download.size ? ` (${formatBytes(download.size)})` : '';
  const answer = (save: boolean) =>
    decide.mutate({ conversationId, downloadId: download.id, save });
  const ids = { conversationId, downloadId: download.id };
  return (
    <div
      className={`flex flex-col gap-1.5 border-b px-3 py-2 text-[12.5px] ${download.status === 'waiting' ? 'border-amber-300/20 bg-amber-300/[0.06]' : 'border-line'}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-white/85" title={download.url}>
          {download.status === 'waiting' && (
            <>
              A page wants to download <b className="font-medium text-white">{download.filename}</b>
              {size} from {hostOf(download.url)}.
            </>
          )}
          {download.status === 'saving' && <>Saving {download.filename}…</>}
          {download.status === 'saved' && (
            <>
              Saved {download.filename} to{' '}
              <span className="font-mono text-[11.5px]">{download.path}</span>
            </>
          )}
          {download.status === 'blocked' && <>Blocked the download of {download.filename}.</>}
          {download.status === 'failed' && (
            <>
              Couldn't save {download.filename}: {download.error}
            </>
          )}
        </span>
        {download.status === 'waiting' ? (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={decide.isPending}
              onClick={() => answer(true)}
            >
              Save to Downloads
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={decide.isPending}
              onClick={() => answer(false)}
            >
              Block
            </Button>
          </>
        ) : (
          download.status !== 'saving' && (
            <IconButton label="Dismiss" onClick={() => dismiss.mutate(ids)}>
              <XIcon />
            </IconButton>
          )
        )}
      </div>
      {decide.error && <ErrorText>{decide.error.message}</ErrorText>}
    </div>
  );
}

/** The page as it looked after a step, from the chat's pictures. */
function StepPicture({ path, onLive }: { path: string; onLive: () => void }) {
  const trpc = useTRPC();
  const picture = useQuery(trpc.chat.picture.queryOptions(path, { staleTime: Infinity }));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[12px]">
        <span className="flex-1 text-dim">The page as it looked at that step</span>
        <Button size="sm" onClick={onLive}>
          Back to live
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-black/40 p-2">
        {picture.data ? (
          <img src={picture.data} alt="The page at that step" className="w-full rounded-lg" />
        ) : picture.error ? (
          <ErrorText>{picture.error.message}</ErrorText>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Where the page shows. The main process lays the tab's view over this box, so it reports where
 * the box is whenever that may have changed, and hides the view when the box goes.
 */
function Viewport({ conversationId, tabId }: { conversationId: string; tabId: string }) {
  const trpc = useTRPC();
  const box = useRef<HTMLDivElement>(null);
  const show = useMutation(trpc.browser.show.mutationOptions());
  const latest = useRef(show.mutate);
  useLayoutEffect(() => {
    latest.current = show.mutate;
  });

  useLayoutEffect(() => {
    const el = box.current!;
    let frame = 0;
    let last = '';
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        // A hidden pane measures nothing: the view hides with it.
        const bounds =
          rect.width >= 1 && rect.height >= 1
            ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
            : null;
        const key = JSON.stringify(bounds);
        if (key === last) return;
        last = key;
        latest.current({ conversationId, tabId: bounds ? tabId : null, bounds });
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener('resize', sync);
    // The box can move without changing size, such as when a panel beside it opens.
    const timer = setInterval(sync, 400);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', sync);
      clearInterval(timer);
      latest.current({ conversationId, tabId: null, bounds: null });
    };
  }, [conversationId, tabId]);

  return <div ref={box} className="min-h-0 flex-1 bg-white/[0.03]" />;
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'about:' ? '' : parsed.host;
  } catch {
    return url;
  }
}
