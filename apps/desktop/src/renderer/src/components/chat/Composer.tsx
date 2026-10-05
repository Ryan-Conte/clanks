import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, StopIcon } from '../ui';

const MAX_HEIGHT = 240;

/** Where a message is written. Enter sends; Shift+Enter starts a new line. */
export function Composer(props: {
  name: string;
  /** A reply is being written: the button stops it instead. */
  replying: boolean;
  disabled?: boolean;
  /** Resolves true once the message is accepted, which clears the box. */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a point.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  useEffect(() => box.current?.focus(), [props.name]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || props.replying || sending || props.disabled) return;
    setSending(true);
    try {
      if (await props.onSend(text)) setText('');
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <form onSubmit={(e) => void send(e)} className="px-6 pt-2 pb-5">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-[22px] border border-line bg-ink/80 py-1.5 pr-1.5 pl-4 transition-colors focus-within:border-white/20">
        <textarea
          ref={box}
          rows={1}
          value={text}
          disabled={props.disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${props.name}…`}
          aria-label={`Message ${props.name}`}
          className="max-h-60 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-2 text-[14px] leading-5 text-white outline-none placeholder:text-dim disabled:opacity-50"
        />
        {props.replying ? (
          <button
            type="button"
            aria-label="Stop"
            title="Stop"
            onClick={props.onStop}
            className="grid size-9 shrink-0 place-items-center rounded-full border border-line bg-white/10 text-white transition-colors hover:bg-white/20"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            title="Send"
            disabled={!text.trim() || sending || props.disabled}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-white text-black transition-colors hover:bg-white/85 disabled:opacity-30"
          >
            <ArrowUpIcon />
          </button>
        )}
      </div>
    </form>
  );
}
