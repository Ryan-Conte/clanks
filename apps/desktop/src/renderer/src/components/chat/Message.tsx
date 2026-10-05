import type { ClankSummary, MessageRecord } from '@clanks/core';
import { memo, useDeferredValue } from 'react';
import { formatCount, formatRate, formatSeconds } from '../../lib/format';
import { Avatar } from '../Avatar';
import { Dot, ErrorText, IconButton, RetryIcon } from '../ui';
import { CopyButton, Markdown } from './Markdown';

export const Message = memo(function Message(props: {
  message: MessageRecord;
  clank: ClankSummary;
  /** The newest reply can be written again. */
  canRetry: boolean;
  /** What the reply is waiting on before its first word, such as the model loading. */
  waiting: string;
  onRetry: () => void;
}) {
  const { message } = props;
  if (message.role === 'user') {
    return (
      <div className="group animate-rise flex flex-col items-end gap-1">
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

function Reply({ message, clank, canRetry, waiting, onRetry }: Parameters<typeof Message>[0]) {
  const streaming = message.status === 'streaming';
  // While a reply streams in, React may skip renders it can't keep up with.
  const content = useDeferredValue(message.content);
  const { usage } = message;

  return (
    <div className="group animate-rise flex gap-3">
      <Avatar colour={clank.avatar} live={streaming} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        {message.reasoning && (
          <details className="group/thinking text-[13px] text-dim" open={streaming && !content}>
            <summary className="flex cursor-pointer items-center gap-2 select-none hover:text-white">
              {streaming && !content && <Dot tone="lavender" live />}
              {streaming && !content ? 'Thinking…' : 'Thought it through'}
            </summary>
            <p className="mt-2 max-h-72 overflow-y-auto border-l border-line pl-3 whitespace-pre-wrap">
              {message.reasoning}
            </p>
          </details>
        )}
        {content ? (
          <Markdown text={content} />
        ) : (
          streaming &&
          !message.reasoning && (
            <p className="flex items-center gap-2 text-sm text-dim">
              <Dot tone="lavender" live />
              {waiting}
            </p>
          )
        )}
        {message.status === 'failed' && (
          <ErrorText>{message.error ?? 'The reply failed.'}</ErrorText>
        )}
        {message.status === 'cancelled' && <Note>Stopped.</Note>}
        {message.finishReason === 'length' && <Note>Stopped at the length limit.</Note>}
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

function Note({ children }: { children: string }) {
  return <p className="text-[13px] text-dim italic">{children}</p>;
}
