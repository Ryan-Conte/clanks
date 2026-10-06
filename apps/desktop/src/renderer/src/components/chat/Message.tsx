import type { ClankSummary, MessagePart, MessageRecord } from '@clanks/core';
import { memo, useDeferredValue } from 'react';
import { formatCount, formatRate, formatSeconds } from '../../lib/format';
import { Avatar } from '../Avatar';
import { Dot, ErrorText, IconButton, RetryIcon } from '../ui';
import { CopyButton, Markdown } from './Markdown';
import { ToolCard } from './ToolCard';

export const Message = memo(function Message(props: {
  message: MessageRecord;
  clank: ClankSummary;
  /** The newest reply can be written again. */
  canRetry: boolean;
  /** What the reply is waiting on before its first word, such as the model loading. */
  waiting: string;
  /** It's the last message and nothing is being written, so a question in it can be answered. */
  answerable?: boolean;
  onAnswer?: (text: string) => void;
  onRetry: () => void;
}) {
  const { message } = props;
  if (message.role === 'user' && message.author === 'app') {
    return (
      <div
        id={`message-${message.id}`}
        className="animate-rise flex flex-col gap-1.5 rounded-2xl border border-line bg-white/[0.03] px-4 py-3"
      >
        <span className="text-[11px] font-medium tracking-[0.12em] text-dim uppercase">
          clanks → {props.clank.name}
        </span>
        <Markdown text={message.content} />
      </div>
    );
  }
  if (message.role === 'user') {
    return (
      <div
        id={`message-${message.id}`}
        className="group animate-rise flex flex-col items-end gap-1"
      >
        <p className="max-w-[80%] rounded-3xl rounded-br-lg bg-white/[0.08] px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-white">
          {message.content}
        </p>
        <div className="opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={message.content} />
        </div>
      </div>
    );
  }
  return <Reply {...props} />;
});

function Reply({
  message,
  clank,
  canRetry,
  waiting,
  answerable,
  onAnswer,
  onRetry,
}: Parameters<typeof Message>[0]) {
  const streaming = message.status === 'streaming';
  // While a reply streams in, React may skip renders it can't keep up with.
  const parts = useDeferredValue(message.parts);
  const { usage } = message;
  const last = parts.at(-1);
  // Between a tool's result and the model's next words, show that it's thinking again.
  const between =
    streaming && last?.type === 'tool' && !['pending', 'asking', 'running'].includes(last.status);

  return (
    <div id={`message-${message.id}`} className="group animate-rise flex gap-3">
      <Avatar colour={clank.avatar} live={streaming} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        {message.reasoning && (
          <details
            className="group/thinking text-[13px] text-dim"
            open={streaming && parts.length === 0}
          >
            <summary className="flex cursor-pointer items-center gap-2 select-none hover:text-white">
              {streaming && parts.length === 0 && <Dot tone="lavender" live />}
              {streaming && parts.length === 0 ? 'Thinking…' : 'Thought it through'}
            </summary>
            <p className="mt-2 max-h-72 overflow-y-auto border-l border-line pl-3 whitespace-pre-wrap">
              {message.reasoning}
            </p>
          </details>
        )}
        {parts.map((part, i) => (
          <Part
            key={part.type === 'tool' ? part.id : i}
            part={part}
            message={message}
            clank={clank}
            answerable={answerable ?? false}
            {...(onAnswer ? { onAnswer } : {})}
          />
        ))}
        {streaming && (parts.length === 0 ? !message.reasoning : between) && (
          <p className="flex items-center gap-2 text-sm text-dim">
            <Dot tone="lavender" live />
            {parts.length === 0 ? waiting : 'Thinking…'}
          </p>
        )}
        {message.status === 'failed' && (
          <ErrorText>{message.error ?? 'The reply failed.'}</ErrorText>
        )}
        {message.status === 'cancelled' && <Note>Stopped.</Note>}
        {message.finishReason === 'length' && !parts.some((p) => p.type === 'note') && (
          <Note>Stopped at the length limit.</Note>
        )}
        {message.finishReason === 'refusal' && <Note>The model declined to answer this.</Note>}
        {!streaming && (
          <footer className="flex items-center gap-1 text-[12px] text-dim">
            {usage && (
              <span
                className="mr-1 font-mono text-[11px]"
                title={message.model ? `${message.model.model}` : undefined}
              >
                {formatCount(usage.promptTokens)} in · {formatCount(usage.completionTokens)} out ·{' '}
                {formatRate(usage.tokensPerSecond)} · {formatSeconds(usage.durationMs)}
              </span>
            )}
            <span
              className={`flex items-center transition-opacity ${message.status === 'failed' ? '' : 'opacity-0 group-hover:opacity-100'}`}
            >
              {message.content && <CopyButton text={message.content} />}
              {canRetry && (
                <IconButton
                  label={message.status === 'failed' ? 'Try again' : 'Write it again'}
                  onClick={onRetry}
                >
                  <RetryIcon />
                </IconButton>
              )}
            </span>
          </footer>
        )}
      </div>
    </div>
  );
}

function Part(props: {
  part: MessagePart;
  message: MessageRecord;
  clank: ClankSummary;
  answerable: boolean;
  onAnswer?: (text: string) => void;
}) {
  const { part } = props;
  switch (part.type) {
    case 'text':
      return part.text.trim() ? <Markdown text={part.text} /> : null;
    case 'tool':
      return (
        <ToolCard
          part={part}
          conversationId={props.message.conversationId}
          clank={props.clank}
          answerable={props.answerable}
          {...(props.onAnswer ? { onAnswer: props.onAnswer } : {})}
        />
      );
    case 'note':
      return <Note>{part.text}</Note>;
    case 'feedback':
      return (
        <div className="flex flex-col gap-1 self-end rounded-2xl rounded-br-md border border-line bg-white/[0.05] px-3.5 py-2.5">
          <span className="text-[11px] font-medium tracking-[0.12em] text-dim uppercase">
            You, while {props.clank.name} worked
          </span>
          <p className="text-[13px] whitespace-pre-wrap text-white/85">{part.text}</p>
        </div>
      );
  }
}

function Note({ children }: { children: string }) {
  return <p className="text-[13px] text-dim italic">{children}</p>;
}
