import { MAX_MESSAGE_IMAGES, MESSAGE_IMAGE_PIXELS, type MessageImage } from '@clanks/core';
import { type ClipboardEvent, type DragEvent, useState } from 'react';

/** A picture waiting to go with a message: what's sent, and a way to show it meanwhile. */
export interface Picture extends MessageImage {
  id: string;
  /** The same picture as a `data:` address, for its thumbnail. */
  url: string;
}

/**
 * A picture file as a message carries it: scaled down to what a model takes, as a JPEG. A local
 * model reads about a megapixel, and a bigger picture has taken its server down.
 */
async function prepare(file: File): Promise<Picture> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, Math.sqrt(MESSAGE_IMAGE_PIXELS / (bitmap.width * bitmap.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas');
  // A screenshot with see-through parts would turn black as a JPEG.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL('image/jpeg', 0.9);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mediaType: 'image/jpeg',
    data: url.slice(url.indexOf(',') + 1),
    url,
  };
}

/** The pictures as they're sent, without what only the window needed. */
export function toSend(pictures: Picture[]): MessageImage[] {
  return pictures.map(({ name, mediaType, data }) => ({ name, mediaType, data }));
}

/**
 * Pictures being added to a message: pasted from the clipboard, dropped on the box, or picked from
 * the computer. Anything that isn't a picture is left for whatever else handles it.
 */
export function usePictures() {
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) return;
    setError(null);
    const room = MAX_MESSAGE_IMAGES - pictures.length;
    if (images.length > room) {
      setError(`A message takes up to ${MAX_MESSAGE_IMAGES} pictures.`);
    }
    try {
      const prepared = await Promise.all(images.slice(0, Math.max(0, room)).map(prepare));
      setPictures((current) => [...current, ...prepared].slice(0, MAX_MESSAGE_IMAGES));
    } catch {
      setError("That picture couldn't be read. Try a PNG or a JPEG.");
    }
  };

  return {
    pictures,
    error,
    add,
    remove: (id: string) => {
      setError(null);
      setPictures((current) => current.filter((picture) => picture.id !== id));
    },
    clear: () => {
      setError(null);
      setPictures([]);
    },
    /** A screenshot on the clipboard goes in as a picture; text pastes as it always did. */
    onPaste: (event: ClipboardEvent) => {
      const files = [...event.clipboardData.files];
      if (!files.some((file) => file.type.startsWith('image/'))) return;
      event.preventDefault();
      void add(files);
    },
    onDrop: (event: DragEvent) => {
      const files = [...event.dataTransfer.files];
      if (!files.some((file) => file.type.startsWith('image/'))) return;
      event.preventDefault();
      void add(files);
    },
    /** Lets a picture be dropped: without it the window would open the file instead. */
    onDragOver: (event: DragEvent) => {
      if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
    },
  };
}
