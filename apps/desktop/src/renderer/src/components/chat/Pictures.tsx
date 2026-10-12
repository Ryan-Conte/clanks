import type { ImagePart } from '@clanks/core';
import { useQuery } from '@tanstack/react-query';
import { type ChangeEvent, useRef } from 'react';
import type { Picture } from '../../lib/pictures';
import { useTRPC } from '../../lib/trpc';
import { ImageIcon, XIcon, Zoomable } from '../ui';

/** The pictures about to go with a message, each with a way to take it back off. */
export function PictureTray(props: { pictures: Picture[]; onRemove: (id: string) => void }) {
  if (props.pictures.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Pictures to send">
      {props.pictures.map((picture) => (
        <li key={picture.id} className="group/picture relative">
          <img
            src={picture.url}
            alt={picture.name || 'A picture to send'}
            className="size-16 rounded-xl border border-line object-cover"
          />
          <button
            type="button"
            aria-label={`Remove ${picture.name || 'this picture'}`}
            title="Remove"
            onClick={() => props.onRemove(picture.id)}
            className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-line bg-raised text-white/80 opacity-0 transition-opacity group-hover/picture:opacity-100 hover:text-white focus-visible:opacity-100"
          >
            <XIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The button that picks pictures from the computer, for whoever doesn't paste or drop them. */
export function AddPictures(props: { disabled?: boolean; onAdd: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    props.onAdd([...(event.target.files ?? [])]);
    // The same file can be picked again after it's taken off.
    event.target.value = '';
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        tabIndex={-1}
        onChange={onChange}
      />
      <button
        type="button"
        aria-label="Add a picture"
        title="Add a screenshot or a photo. You can also paste one, or drop it here."
        disabled={props.disabled}
        onClick={() => input.current?.click()}
        className="grid size-9 shrink-0 place-items-center rounded-full text-dim transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40"
      >
        <ImageIcon />
      </button>
    </>
  );
}

/** The pictures a message was sent with, which open large when clicked. */
export function SentPictures({ parts }: { parts: ImagePart[] }) {
  if (parts.length === 0) return null;
  return (
    <ul className="flex max-w-[80%] flex-wrap justify-end gap-2">
      {parts.map((part) => (
        <li key={part.image}>
          <SentPicture part={part} />
        </li>
      ))}
    </ul>
  );
}

function SentPicture({ part }: { part: ImagePart }) {
  const trpc = useTRPC();
  const picture = useQuery(trpc.chat.picture.queryOptions(part.image, { staleTime: Infinity }));
  if (picture.error) {
    return (
      <p className="rounded-xl border border-dashed border-line px-3 py-2 text-[12px] text-dim">
        A picture that's no longer kept
      </p>
    );
  }
  if (!picture.data) return <div className="h-40 w-56 rounded-2xl border border-line bg-white/5" />;
  return (
    <Zoomable
      src={picture.data}
      alt={part.name || 'A picture you sent'}
      className="max-h-64 max-w-full rounded-2xl border border-line object-contain"
    />
  );
}
