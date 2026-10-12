import {
  type BoardSnapshot,
  type BrowserState,
  type ChatLiveEvent,
  type ClankSummary,
  type ConversationSummary,
  LEAD_CLANK,
  type MessageImage,
  type MessageRecord,
  type ModelChoice,
  type TicketCard,
  type WorkspaceState,
} from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Composer } from '../components/chat/Composer';
import { Message } from '../components/chat/Message';
import { PromptPanel } from '../components/chat/PromptPanel';
import { Deliverable } from '../components/project/Deliverable';
import { ProjectAsks } from '../components/project/Overview';
import {
  Button,
  Chip,
  ErrorText,
  EyeIcon,
  FolderIcon,
  IconButton,
  LayersIcon,
  Menu,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
  inputClass,
} from '../components/ui';
import { Workbench } from '../components/workbench/Workbench';
import {
  plainBlurb,
  plainJob,
  startersFor,
  useClank,
  useClankModel,
  useConversations,
  useCrew,
  useProviders,
  useSeesPictures,
  whereItRuns,
} from '../lib/crew';
import { handedInAt } from '../lib/board';
import { useModels } from '../lib/models';
import { useNav } from '../lib/nav';
import { folderName, useProject } from '../lib/projects';
import { useTRPC } from '../lib/trpc';
import { type WorkbenchFocus, WorkbenchContext, useWorkbench } from '../lib/workbench';

type ChatData = { conversation: ConversationSummary; messages: MessageRecord[] };

/**
 * A chat shown as a project's conversation: the board it's about, whose questions, approvals and
 * finished work show in the thread, and what stands beside it, which is the crew at work.
 */
interface InProject {
  snapshot: BoardSnapshot;
  aside: ReactNode;
}

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
        messages: data.messages.map((m) => {
          if (m.id !== event.messageId) return m;
          const parts = [...m.parts];
          const last = parts.at(-1);
          if (event.text) {
            if (last?.type === 'text' && last.round === event.round) {
              parts[parts.length - 1] = { ...last, text: last.text + event.text };
            } else {
              parts.push({ type: 'text', round: event.round, text: event.text });
            }
          }
          return {
            ...m,
            parts,
            content: m.content + event.text,
            reasoning: m.reasoning + event.reasoning,
          };
        }),
      };
    case 'part':
      return {
        ...data,
        messages: data.messages.map((m) => {
          if (m.id !== event.messageId) return m;
          const parts = [...m.parts];
          parts[event.index] = event.part;
          return { ...m, parts };
        }),
      };
    case 'removed':
      return { ...data, messages: data.messages.filter((m) => m.id !== event.messageId) };
    case 'conversation':
      return {
        ...data,
        conversation: {
          ...event.conversation,
          replying: data.conversation.replying,
          asking: data.conversation.asking,
        },
      };
  }
}

/** Things to say to the lead in a project that already has work going. */
const PROJECT_STARTERS = ['Where are we up to?', 'What do you need from me?'];

/** A chat that isn't saved yet: it becomes one with its first message. */
export function DraftChat({
  clankId,
  projectId,
  inProject,
}: {
  clankId: string;
  projectId: string | null;
  inProject?: InProject;
}) {
  const trpc = useTRPC();
  const { go } = useNav();
  const clank = useClank(clankId);
  const project = useProject(projectId);
  const model = useClankModel(clank);
  const [folder, setFolder] = useState<string | null>(null);
  const start = useMutation(trpc.chat.start.mutationOptions());
  const choose = useMutation(
    trpc.chat.chooseFolder.mutationOptions({ onSuccess: (picked) => picked && setFolder(picked) }),
  );
  if (!clank) return null;
  const send = async (text: string, images: MessageImage[] = []) => {
    try {
      const { conversation } = await start.mutateAsync(
        project
          ? { clankId, text, images, projectId: project.id }
          : { clankId, text, images, folder },
      );
      go({ page: 'chat', id: conversation.id, projectId: conversation.projectId });
      return true;
    } catch {
      return false;
    }
  };
  const starters = project
    ? (inProject?.snapshot.tickets.length ?? 0) > 0
      ? PROJECT_STARTERS
      : []
    : startersFor(clank.id);

  return (
    <ChatFrame clank={clank} conversation={null} {...(inProject ? { inProject } : {})}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-8">
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <Avatar colour={clank.avatar} size="lg" />
            <div className="flex flex-col gap-1.5">
              <h1 className="text-2xl font-semibold tracking-[-0.02em]">
                {project ? `Tell ${clank.name} what you want` : clank.name}
              </h1>
              <p className="mx-auto max-w-md text-[15px] leading-relaxed text-dim">
                {project
                  ? `${clank.name} ${clank.id === LEAD_CLANK ? 'leads the crew on' : 'works on'} ${project.name}. Say it in your own words, and the crew takes it from there.`
                  : plainBlurb(clank)}
              </p>
            </div>
            {starters.length > 0 && model && (
              <ul className="flex max-w-xl flex-wrap justify-center gap-2 pt-1">
                {starters.map((starter) => (
                  <li key={starter}>
                    <Chip disabled={start.isPending} onClick={() => void send(starter)}>
                      {starter}
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
            {!project &&
              (folder ? (
                <span
                  className="flex items-center gap-1.5 rounded-full border border-line py-0.5 pr-0.5 pl-3 text-[13px] text-white/85"
                  title={`${clank.name} works on its own copy of ${folder}`}
                >
                  <FolderIcon />
                  <span className="max-w-64 truncate">{folderName(folder)}</span>
                  <IconButton label="Don't use a folder" onClick={() => setFolder(null)}>
                    <XIcon />
                  </IconButton>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  title={`Let ${clank.name} read and change the files in a folder. It works on its own copy.`}
                  onClick={() => choose.mutate()}
                >
                  <FolderIcon /> Work on a folder
                </Button>
              ))}
            {choose.error && <ErrorText>{choose.error.message}</ErrorText>}
          </div>
          {inProject?.snapshot.tickets
            .filter((t) => t.column === 'ready')
            .map((card) => (
              <Deliverable key={card.id} card={card} snapshot={inProject.snapshot} />
            ))}
          {inProject && <ProjectAsks snapshot={inProject.snapshot} skipConversation={null} />}
        </div>
      </div>
      <ComposerArea
        clank={clank}
        replying={false}
        notes={0}
        error={start.error?.message ?? null}
        onSend={send}
        onStop={() => {}}
      />
    </ChatFrame>
  );
}

/** A message, or a piece of the crew's work handed to the user at that point in the conversation. */
type Entry = { at: number; message: MessageRecord } | { at: number; work: TicketCard };

export function LiveChat({ id, inProject }: { id: string; inProject?: InProject }) {
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
  const board = inProject?.snapshot;
  const waitingOnUser = board?.needsYou.length ?? 0;
  const finished = board?.tickets.filter((t) => t.doneAt !== null).length ?? 0;

  // Keep to the bottom as a reply streams in, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [query.data?.messages, waitingOnUser, finished]);

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
  const last = messages.at(-1);
  // The crew's work is in the conversation where it was handed over: everything still waiting,
  // and what was decided since this conversation began.
  const entries: Entry[] = [
    ...messages.map((message) => ({ at: +message.createdAt, message })),
    ...(board?.tickets ?? [])
      .filter(
        (t) => t.column === 'ready' || (t.doneAt !== null && +t.doneAt >= +conversation.createdAt),
      )
      .map((work) => ({ at: handedInAt(work), work })),
  ].sort((a, b) => a.at - b.at);

  return (
    <ChatFrame clank={clank} conversation={conversation} {...(inProject ? { inProject } : {})}>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
          {entries.map((entry) =>
            'work' in entry ? (
              <Deliverable key={`work:${entry.work.id}`} card={entry.work} snapshot={board!} />
            ) : (
              <Message
                key={entry.message.id}
                message={entry.message}
                clank={clank}
                canRetry={
                  !conversation.replying &&
                  entry.message.role === 'assistant' &&
                  entry.message === last
                }
                waiting={waiting}
                answerable={!conversation.replying && entry.message === last}
                onAnswer={(text) => {
                  stick.current = true;
                  send.mutate({ conversationId: id, text });
                }}
                onRetry={() => {
                  stick.current = true;
                  retry.mutate(id);
                }}
              />
            ),
          )}
          {board && <ProjectAsks snapshot={board} skipConversation={id} />}
        </div>
      </div>
      <ChatComposer
        clank={clank}
        conversation={conversation}
        error={(send.error ?? retry.error)?.message ?? null}
        onSend={async (text, images) => {
          stick.current = true;
          try {
            await send.mutateAsync({ conversationId: id, text, images });
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

/** The composer, knowing how many diff editor notes will go with the next message. */
function ChatComposer(props: {
  clank: ClankSummary;
  conversation: ConversationSummary;
  error: string | null;
  onSend: (text: string, images: MessageImage[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const notes = useWorkbenchNotes();
  return (
    <ComposerArea
      clank={props.clank}
      replying={props.conversation.replying}
      notes={notes}
      error={props.error}
      onSend={props.onSend}
      onStop={props.onStop}
    />
  );
}

function useWorkbenchNotes(): number {
  const { state } = useWorkbench();
  return state?.notes.filter((n) => n.status === 'pending').length ?? 0;
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
  if (!loaded || loaded.state === 'loading') return 'Waking up. The first reply takes a moment…';
  if (loaded.state === 'restarting') return 'The model is restarting…';
  return 'Thinking…';
}

/** The chat's workspace, kept live while the chat is about a folder. */
function useWorkspaceState(conversation: ConversationSummary | null): WorkspaceState | null {
  const trpc = useTRPC();
  const [state, setState] = useState<WorkspaceState | null>(null);
  useSubscription(
    trpc.workspace.live.subscriptionOptions(conversation?.id ?? '', {
      enabled: conversation !== null && conversation.folder !== null,
      onData: setState,
    }),
  );
  return conversation?.folder ? state : null;
}

/** The chat's browser tabs, kept live once the chat is saved. */
function useBrowserState(conversation: ConversationSummary | null): BrowserState | null {
  const trpc = useTRPC();
  const [state, setState] = useState<BrowserState | null>(null);
  useSubscription(
    trpc.browser.live.subscriptionOptions(conversation?.id ?? '', {
      enabled: conversation !== null,
      onData: setState,
    }),
  );
  return conversation ? state : null;
}

/** The header, the conversation and the box to write in, with the workbench beside them. */
function ChatFrame({
  clank,
  conversation,
  inProject,
  children,
}: {
  clank: ClankSummary;
  conversation: ConversationSummary | null;
  inProject?: InProject;
  children: ReactNode;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  // A project's conversation has the crew beside it. The workbench, which shows the files and
  // commands behind the work, opens when it's asked for.
  const [open, setOpen] = useState(!inProject);
  const [focus, setFocus] = useState<WorkbenchFocus | null>(null);
  const state = useWorkspaceState(conversation);
  const browser = useBrowserState(conversation);
  const show = useCallback((next: Omit<WorkbenchFocus, 'nonce'>) => {
    setOpen(true);
    setFocus((current) => ({ ...next, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);
  // A tab the clank opens brings the browser forward, so the user sees it browse.
  const tabCount = browser?.tabs.length ?? 0;
  const [seenTabs, setSeenTabs] = useState(0);
  if (tabCount !== seenTabs) {
    setSeenTabs(tabCount);
    if (tabCount > seenTabs && !inProject) show({ tab: 'browser' });
  }
  const hasFolder = conversation?.folder != null;
  const hasWorkbench = hasFolder || tabCount > 0;
  const workbench = useMemo(
    () => ({
      state,
      browser,
      conversationId: conversation?.id ?? null,
      replying: conversation?.replying ?? false,
      open: open && hasWorkbench,
      setOpen,
      focus,
      show,
    }),
    [state, browser, conversation?.id, conversation?.replying, open, hasWorkbench, focus, show],
  );

  return (
    <WorkbenchContext value={workbench}>
      <div className="flex h-full min-h-0 flex-1">
        <div className="@container flex min-w-[22rem] flex-1 flex-col">
          <ChatHeader
            clank={clank}
            conversation={conversation}
            embedded={Boolean(inProject)}
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
        {workbench.open ? (
          <Workbench clankId={clank.id} folder={hasFolder} role={conversation?.role ?? null} />
        ) : (
          !showPrompt && inProject?.aside
        )}
      </div>
    </WorkbenchContext>
  );
}

function ChatHeader(props: {
  clank: ClankSummary;
  conversation: ConversationSummary | null;
  /** Shown as a project's conversation, under the project's own header. */
  embedded: boolean;
  showPrompt: boolean;
  onTogglePrompt: () => void;
}) {
  const { clank, conversation, embedded } = props;
  const trpc = useTRPC();
  const { go } = useNav();
  const providers = useProviders();
  const model = useClankModel(clank);
  const { open: workbenchOpen, setOpen: setWorkbenchOpen, browser } = useWorkbench();
  const browsing = (browser?.tabs.length ?? 0) > 0;
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const project = useProject(conversation?.projectId);
  const rename = useMutation(
    trpc.chat.rename.mutationOptions({ onSuccess: () => setRenaming(false) }),
  );
  const remove = useMutation(
    trpc.chat.delete.mutationOptions({
      onSuccess: () =>
        go(project ? { page: 'project', id: project.id, tab: 'overview' } : { page: 'home' }),
    }),
  );
  const pickFolder = useMutation(trpc.chat.pickFolder.mutationOptions());
  const clearFolder = useMutation(trpc.chat.clearFolder.mutationOptions());
  const error = [rename, remove, pickFolder, clearFolder].find((m) => m.error)?.error;
  const own = conversation !== null && !conversation.role;
  const projectId = project?.id ?? null;

  return (
    <header
      className={`flex flex-col gap-2 border-b border-line px-5 ${embedded ? 'py-2' : 'py-3'}`}
    >
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => go({ page: 'crew', clankId: clank.id })}
          className="flex min-w-0 items-center gap-3 rounded-lg text-left"
          title={`${clank.name}: ${plainJob(clank)}. Open its profile.`}
        >
          <Avatar colour={clank.avatar} size={embedded ? 'xs' : 'sm'} />
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="text-sm font-medium">{clank.name}</span>
            <span className="truncate text-xs text-dim">{clank.role}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {!embedded && conversation && project && (
            <button
              type="button"
              onClick={() =>
                go({
                  page: 'project',
                  id: project.id,
                  tab: conversation.ticketId ? 'board' : 'overview',
                  ticket: conversation.ticketId,
                })
              }
              className="mr-1 flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[12px] text-white/80 hover:bg-white/[0.05]"
              title={
                conversation.role
                  ? `${clank.name}'s ${conversation.role === 'planner' ? 'planning' : conversation.role === 'consult' ? "answer to another clank's question" : 'work on a ticket'} in ${project.name}. Go back to the project.`
                  : `Back to ${project.name}`
              }
            >
              <span aria-hidden="true">‹</span>
              <span className="max-w-40 truncate">{project.name}</span>
            </button>
          )}
          {conversation && !project && conversation.folder && (
            <span
              className="mr-1 flex items-center gap-1.5 rounded-full border border-line py-0.5 pr-0.5 pl-2.5 text-[12px] text-white/80"
              title={`${clank.name} works on its own copy of ${conversation.folder}, and follows its CLANKS.md or AGENTS.md`}
            >
              <FolderIcon />
              <span className="max-w-32 truncate">{folderName(conversation.folder)}</span>
              <IconButton
                label="Stop using this folder"
                disabled={conversation.replying}
                onClick={() => clearFolder.mutate(conversation.id)}
              >
                <XIcon />
              </IconButton>
            </span>
          )}
          {(conversation?.folder || browsing) && (
            <Button
              size="sm"
              variant={workbenchOpen ? 'secondary' : 'ghost'}
              title={
                workbenchOpen
                  ? `Hide the files, commands and pages behind ${clank.name}'s work`
                  : `See the files ${clank.name} changes, the commands it runs and the pages it opens, as it works`
              }
              onClick={() => setWorkbenchOpen(!workbenchOpen)}
            >
              <EyeIcon /> {workbenchOpen ? 'Hide the work' : 'Watch the work'}
            </Button>
          )}
          <Menu
            label="More"
            items={[
              embedded && projectId !== null
                ? {
                    label: 'New chat',
                    hint: `Start again with ${clank.name}. This one is kept.`,
                    icon: <PlusIcon />,
                    onSelect: () => go({ page: 'draft', clankId: clank.id, projectId }),
                  }
                : null,
              conversation &&
                !project &&
                !conversation.folder && {
                  label: 'Work on a folder',
                  hint: `${clank.name} gets its own copy of it to read and change.`,
                  icon: <FolderIcon />,
                  disabled: conversation.replying,
                  onSelect: () => pickFolder.mutate(conversation.id),
                },
              {
                label: `What ${clank.name} is told`,
                hint: model
                  ? `Its instructions. It runs on ${model.model}, ${whereItRuns(model, providers)}.`
                  : 'Its instructions, word for word.',
                icon: <LayersIcon />,
                onSelect: props.onTogglePrompt,
              },
              own && {
                label: 'Rename',
                icon: <PencilIcon />,
                onSelect: () => {
                  setTitle(conversation.title);
                  setRenaming(true);
                },
              },
              own && {
                label: 'Delete chat',
                icon: <TrashIcon />,
                danger: true,
                onSelect: () => setConfirmDelete(true),
              },
            ]}
          />
        </div>
      </div>
      {conversation?.projectId && conversation.role && <RunningNow conversation={conversation} />}
      {confirmDelete && conversation && (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-white/85">
          <span className="flex-1">
            Delete this chat?
            {conversation.folder && !project
              ? ` ${clank.name}'s copy of the folder goes too; any work left in it is kept on its branch.`
              : " It can't be brought back."}
          </span>
          <Button size="sm" variant="danger" onClick={() => remove.mutate(conversation.id)}>
            Delete chat
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
            Keep
          </Button>
        </p>
      )}
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

/** The project's other runs going now, to switch between while watching the crew. */
function RunningNow({ conversation }: { conversation: ConversationSummary }) {
  const { go } = useNav();
  const crew = useCrew();
  const conversations = useConversations() ?? [];
  const others = conversations.filter(
    (c) =>
      c.projectId === conversation.projectId &&
      c.role &&
      c.role !== 'planner' &&
      c.role !== 'consult' &&
      c.replying &&
      c.id !== conversation.id,
  );
  if (others.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <span className="text-dim">Also working:</span>
      {others.map((c) => {
        const clank = crew.find((m) => m.id === c.clankId);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => go({ page: 'chat', id: c.id })}
            title={`Watch ${clank?.name ?? c.clankId} on ${c.title}`}
            className="flex items-center gap-1.5 rounded-full border border-line py-0.5 pr-2.5 pl-0.5 text-white/80 hover:bg-white/[0.05]"
          >
            <Avatar colour={clank?.avatar ?? 'slate'} size="xs" live={!c.asking} />
            {clank?.name ?? c.clankId}
            <span className="text-[11px] text-dim">{c.title.split(':')[0]}</span>
            {c.asking && <span className="text-amber-200">!</span>}
          </button>
        );
      })}
    </div>
  );
}

function ComposerArea(props: {
  clank: ClankSummary;
  replying: boolean;
  /** Notes from the diff editor that will go with the next message. */
  notes: number;
  error: string | null;
  onSend: (text: string, images: MessageImage[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const { go } = useNav();
  const model = useClankModel(props.clank);
  const sees = useSeesPictures(props.clank);
  return (
    <div className="shrink-0">
      {!model ? (
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 pb-2">
          <p className="text-sm text-dim">
            {props.clank.name} can't answer yet: the crew needs its AI model first. It's one
            download.
          </p>
          <Button size="sm" variant="primary" onClick={() => go({ page: 'setup' })}>
            Set up the crew
          </Button>
        </div>
      ) : (
        <>
          {props.error && (
            <div className="mx-auto max-w-3xl px-6 pb-1">
              <ErrorText>{props.error}</ErrorText>
            </div>
          )}
          {props.notes > 0 && (
            <p className="mx-auto max-w-3xl px-6 pb-1 text-[12px] text-amber-200/90">
              {props.notes === 1 ? 'Your review note goes' : `Your ${props.notes} review notes go`}{' '}
              with this message.
            </p>
          )}
        </>
      )}
      <Composer
        name={props.clank.name}
        replying={props.replying}
        disabled={!model}
        blind={!sees}
        onSend={props.onSend}
        onStop={props.onStop}
      />
    </div>
  );
}
