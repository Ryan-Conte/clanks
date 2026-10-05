import type {
  ChatLiveEvent,
  ClankSummary,
  ConversationSummary,
  MessageRecord,
  ModelChoice,
} from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Composer } from '../components/chat/Composer';
import { Message } from '../components/chat/Message';
import { PromptPanel } from '../components/chat/PromptPanel';
import {
  Button,
  ErrorText,
  FolderIcon,
  IconButton,
  LayersIcon,
  PencilIcon,
  TrashIcon,
  XIcon,
  inputClass,
} from '../components/ui';
import { useClank, useClankModel, useProviders, whereItRuns } from '../lib/crew';
import { useModels } from '../lib/models';
import { useNav } from '../lib/nav';
import { useTRPC } from '../lib/trpc';

type ChatData = { conversation: ConversationSummary; messages: MessageRecord[] };

/** Applies one live event to a conversation as the window holds it. */
function apply(data: ChatData, event: ChatLiveEvent): ChatData {
  switch (event.type) {
    case 'message': {
      const { message } = event;
      const index = data.messages.findIndex((m) => m.id === message.id);
      const messages =
        index === -1
          ? [...data.messages, message]
          : data.messages.map((m, i) => (i === index ? message : m));
      const replying =
        message.role === 'assistant' ? message.status === 'streaming' : data.conversation.replying;
      return { conversation: { ...data.conversation, replying }, messages };
    }
    case 'delta':
      return {
        ...data,
        messages: data.messages.map((m) =>
          m.id === event.messageId
            ? { ...m, content: m.content + event.text, reasoning: m.reasoning + event.reasoning }
            : m,
        ),
      };
    case 'removed':
      return { ...data, messages: data.messages.filter((m) => m.id !== event.messageId) };
    case 'conversation':
      return {
        ...data,
        conversation: { ...event.conversation, replying: data.conversation.replying },
      };
  }
}

/** A chat that isn't saved yet: it becomes one with its first message. */
export function DraftChat({ clankId }: { clankId: string }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const clank = useClank(clankId);
  const start = useMutation(trpc.chat.start.mutationOptions());
  if (!clank) return null;

  return (
    <ChatFrame clank={clank} conversation={null}>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 pb-10 text-center">
        <Avatar colour={clank.avatar} size="lg" />
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">{clank.name}</h1>
          <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">{clank.role}</p>
        </div>
        <p className="max-w-md text-sm text-dim">{clank.summary}</p>
      </div>
      <ComposerArea
        clank={clank}
        replying={false}
        error={start.error?.message ?? null}
        onSend={async (text) => {
          try {
            const { conversation } = await start.mutateAsync({ clankId, text });
            go({ page: 'chat', id: conversation.id });
            return true;
          } catch {
            return false;
          }
        }}
        onStop={() => {}}
      />
    </ChatFrame>
  );
}

export function LiveChat({ id }: { id: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const snapshot = useModels();
  const key = trpc.chat.get.queryKey(id);
  const query = useQuery(trpc.chat.get.queryOptions(id));
  useSubscription(
    trpc.chat.live.subscriptionOptions(id, {
      onData: (event) =>
        queryClient.setQueryData<ChatData>(key, (data) => (data ? apply(data, event) : data)),
    }),
  );
  const clank = useClank(query.data?.conversation.clankId);
  const model = useClankModel(clank);
  const send = useMutation(trpc.chat.send.mutationOptions());
  const retry = useMutation(trpc.chat.retry.mutationOptions());
  const stop = useMutation(trpc.chat.stop.mutationOptions());
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Keep to the bottom as a reply streams in, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [query.data?.messages]);

  if (query.error) {
    return (
      <div className="p-10">
        <ErrorText>{query.error.message}</ErrorText>
      </div>
    );
  }
  if (!query.data || !clank) return null;
  const { conversation, messages } = query.data;
  const waiting = waitingFor(conversation, messages, model, snapshot);

  return (
    <ChatFrame clank={clank} conversation={conversation}>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
          {messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              clank={clank}
              canRetry={
                !conversation.replying &&
                message.role === 'assistant' &&
                message === messages.at(-1)
              }
              waiting={waiting}
              onRetry={() => {
                stick.current = true;
                retry.mutate(id);
              }}
            />
          ))}
        </div>
      </div>
      <ComposerArea
        clank={clank}
        replying={conversation.replying}
        error={(send.error ?? retry.error)?.message ?? null}
        onSend={async (text) => {
          stick.current = true;
          try {
            await send.mutateAsync({ conversationId: id, text });
            return true;
          } catch {
            return false;
          }
        }}
        onStop={() => stop.mutate(id)}
      />
    </ChatFrame>
  );
}

/** What a reply that hasn't started is waiting on. */
function waitingFor(
  conversation: ConversationSummary,
  messages: MessageRecord[],
  model: ModelChoice | null,
  snapshot: ReturnType<typeof useModels>,
): string {
  const replyModel = messages.at(-1)?.model ?? model;
  if (!conversation.replying || replyModel?.provider !== 'builtin') return 'Thinking…';
  const loaded = snapshot?.runtime.loaded.find((l) => l.modelId === replyModel.model);
  if (!loaded || loaded.state === 'loading') return `Loading ${replyModel.model}…`;
  if (loaded.state === 'restarting') return 'The model is restarting…';
  return 'Thinking…';
}

/** The header, the conversation and the box to write in. */
function ChatFrame({
  clank,
  conversation,
  children,
}: {
  clank: ClankSummary;
  conversation: ConversationSummary | null;
  children: ReactNode;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          clank={clank}
          conversation={conversation}
          showPrompt={showPrompt}
          onTogglePrompt={() => setShowPrompt((s) => !s)}
        />
        {children}
      </div>
      {showPrompt && (
        <PromptPanel
          clank={clank}
          conversationId={conversation?.id ?? null}
          onClose={() => setShowPrompt(false)}
        />
      )}
    </div>
  );
}

function ChatHeader(props: {
  clank: ClankSummary;
  conversation: ConversationSummary | null;
  showPrompt: boolean;
  onTogglePrompt: () => void;
}) {
  const { clank, conversation } = props;
  const trpc = useTRPC();
  const { go } = useNav();
  const providers = useProviders();
  const model = useClankModel(clank);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rename = useMutation(
    trpc.chat.rename.mutationOptions({ onSuccess: () => setRenaming(false) }),
  );
  const remove = useMutation(
    trpc.chat.delete.mutationOptions({ onSuccess: () => go({ page: 'home' }) }),
  );
  const pickFolder = useMutation(trpc.chat.pickFolder.mutationOptions());
  const clearFolder = useMutation(trpc.chat.clearFolder.mutationOptions());
  const error = [rename, remove, pickFolder, clearFolder].find((m) => m.error)?.error;

  return (
    <header className="flex flex-col gap-2 border-b border-line px-5 py-3">
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => go({ page: 'crew', clankId: clank.id })}
          className="flex min-w-0 items-center gap-3 rounded-lg text-left"
          title={`${clank.name}'s profile`}
        >
          <Avatar colour={clank.avatar} />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-baseline gap-2">
              <span className="text-sm font-medium">{clank.name}</span>
              <span className="text-xs text-dim">{clank.role}</span>
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {model && (
            <span
              className="mr-2 max-w-64 truncate rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-dim"
              title={`${model.model} · ${whereItRuns(model, providers)}`}
            >
              {model.model} · {whereItRuns(model, providers)}
            </span>
          )}
          {conversation &&
            (conversation.folder ? (
              <span
                className="mr-1 flex items-center gap-1.5 rounded-full border border-line py-0.5 pr-0.5 pl-2.5 text-[12px] text-white/80"
                title={`${clank.name} follows CLANKS.md or AGENTS.md in ${conversation.folder}`}
              >
                <FolderIcon />
                <span className="max-w-32 truncate">{folderName(conversation.folder)}</span>
                <IconButton
                  label="Stop using this folder"
                  onClick={() => clearFolder.mutate(conversation.id)}
                >
                  <XIcon />
                </IconButton>
              </span>
            ) : (
              <IconButton
                label="Chat about a folder: the clank follows its CLANKS.md or AGENTS.md"
                onClick={() => pickFolder.mutate(conversation.id)}
              >
                <FolderIcon />
              </IconButton>
            ))}
          <IconButton
            label={`What ${clank.name} is told`}
            onClick={props.onTogglePrompt}
            className={props.showPrompt ? 'bg-white/[0.08] text-white' : ''}
          >
            <LayersIcon />
          </IconButton>
          {conversation && (
            <>
              <IconButton
                label="Rename"
                onClick={() => {
                  setTitle(conversation.title);
                  setRenaming(true);
                }}
              >
                <PencilIcon />
              </IconButton>
              {confirmDelete ? (
                <span className="flex items-center gap-1 pl-1">
                  <Button size="sm" variant="danger" onClick={() => remove.mutate(conversation.id)}>
                    Delete chat
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <IconButton label="Delete chat" onClick={() => setConfirmDelete(true)}>
                  <TrashIcon />
                </IconButton>
              )}
            </>
          )}
        </div>
      </div>
      {renaming && conversation && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) rename.mutate({ id: conversation.id, title });
          }}
        >
          <input
            autoFocus
            aria-label="Chat title"
            className={`${inputClass} h-8 flex-1`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
          />
          <Button size="sm" type="submit" disabled={!title.trim()}>
            Rename
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && <ErrorText>{error.message}</ErrorText>}
    </header>
  );
}

function ComposerArea(props: {
  clank: ClankSummary;
  replying: boolean;
  error: string | null;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const { go } = useNav();
  const model = useClankModel(props.clank);
  return (
    <div className="shrink-0">
      {!model ? (
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 pb-2">
          <p className="text-sm text-dim">
            {props.clank.name} has no model to run on yet. Pick one for the crew, or give{' '}
            {props.clank.name} its own.
          </p>
          <span className="flex shrink-0 gap-2">
            <Button size="sm" onClick={() => go({ page: 'models' })}>
              Models
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => go({ page: 'crew', clankId: props.clank.id })}
            >
              Profile
            </Button>
          </span>
        </div>
      ) : (
        props.error && (
          <div className="mx-auto max-w-3xl px-6 pb-1">
            <ErrorText>{props.error}</ErrorText>
          </div>
        )
      )}
      <Composer
        name={props.clank.name}
        replying={props.replying}
        disabled={!model}
        onSend={props.onSend}
        onStop={props.onStop}
      />
    </div>
  );
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
