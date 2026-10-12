import type { MessageImage } from '@clanks/core';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { toSend, usePictures } from '../../lib/pictures';
import { ArrowUpIcon, StopIcon } from '../ui';
import { AddPictures, PictureTray } from './Pictures';

const MAX_HEIGHT = 240;

/**
 * Where a message is written. Enter sends; Shift+Enter starts a new line. A screenshot pasted in,
 * or a picture dropped on it or picked with its button, goes with the message.
 */
export function Composer(props: {
  name: string;
  /** A reply is being written: the button stops it instead. */
  replying: boolean;
  disabled?: boolean;
  /** The clank's model can't see pictures, so it's only told that one was sent. */
  blind?: boolean;
  /** Resolves true once the message is accepted, which clears the box. */
  onSend: (text: string, images: MessageImage[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const { pictures, error, add, remove, clear, onPaste, onDrop, onDragOver } = usePictures();
  const ready = text.trim() !== '' || pictures.length > 0;

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
    if (!ready || props.replying || sending || props.disabled) return;
    setSending(true);
    try {
      if (await props.onSend(text, toSend(pictures))) {
        setText('');
        clear();
      }
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
    <form
      onSubmit={(e) => void send(e)}
      onDrop={onDrop}
      onDragOver={onDragOver}
      className="px-6 pt-2 pb-5"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2 rounded-[26px] border border-line bg-raised/80 py-2 pr-2 pl-2 shadow-xl shadow-black/30 transition-colors focus-within:border-white/25">
        {pictures.length > 0 && (
          <div className="px-3 pt-2">
            <PictureTray pictures={pictures} onRemove={remove} />
          </div>
        )}
        <div className="flex items-end gap-1">
          <AddPictures disabled={props.disabled ?? false} onAdd={(files) => void add(files)} />
          <textarea
            ref={box}
            rows={1}
            value={text}
            disabled={props.disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={`Message ${props.name}…`}
            aria-label={`Message ${props.name}`}
            className="max-h-60 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-2 pr-1 pl-1 text-[15px] leading-5 text-white outline-none placeholder:text-white/35 disabled:opacity-50"
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
              disabled={!ready || sending || props.disabled}
              className="grid size-9 shrink-0 place-items-center rounded-full bg-white text-black transition-colors hover:bg-white/85 disabled:opacity-30"
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
      {(error ?? (props.blind && pictures.length > 0)) && (
        <p className="mx-auto max-w-3xl px-4 pt-1.5 text-[12px] text-amber-200/90">
          {error ??
            `${props.name}'s model can't see pictures. It will know you sent one, but not what's in it.`}
        </p>
      )}
    </form>
  );
}
