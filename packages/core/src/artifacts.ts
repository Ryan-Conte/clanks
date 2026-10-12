import { z } from 'zod';

/**
 * What an artifact is: a ticket's hand-in as a document (`doc`, `copy`, `email`, `research`,
 * `campaign`), a working note or file a clank saved, or a picture of a page it read.
 */
export const artifactKindSchema = z.enum([
  'doc',
  'copy',
  'email',
  'research',
  'campaign',
  'note',
  'file',
  'screenshot',
]);

export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/**
 * Something the crew made that isn't in the repository, kept in the app's data folder. Saving
 * under a name that exists adds a version; earlier ones stay.
 */
export interface Artifact {
  id: string;
  /** The ticket it belongs to. Null for one saved in a chat. */
  ticketId: string | null;
  /** The chat or run it was saved in. */
  conversationId: string | null;
  projectId: string | null;
  /** `user`, or the clank that saved it. */
  author: string;
  kind: ArtifactKind;
  /** Its file name, such as `research.md` or `competitors.md`. */
  name: string;
  /** 1 for the first save under this name, then 2, 3. */
  version: number;
  mediaType: string;
  /** In bytes. */
  size: number;
  /** Where it is, relative to the artifacts folder. */
  path: string;
  createdAt: Date;
}

/** A name a clank or the user gives an artifact: a file name, with no folders in it. */
export const artifactNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[\w][\w .()-]*$/,
    'Use a file name such as notes.md: letters, digits, spaces, ".", "-" and "_"',
  )
  .refine((name) => !name.includes('..'), 'A name has no ".." in it');

/** The media type a file name's ending says it is, for the kinds artifacts hold. */
export function mediaTypeOf(name: string): string {
  const ending = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return (
    {
      md: 'text/markdown',
      markdown: 'text/markdown',
      txt: 'text/plain',
      csv: 'text/csv',
      json: 'application/json',
      html: 'text/html',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }[ending] ?? 'application/octet-stream'
  );
}

/** Whether an artifact is text a person can read in the app. */
export function isTextArtifact(artifact: Pick<Artifact, 'mediaType'>): boolean {
  return artifact.mediaType.startsWith('text/') || artifact.mediaType === 'application/json';
}

/** The formats a written hand-in exports to. */
export const DOCUMENT_EXPORTS = ['md', 'docx', 'pdf', 'html'] as const;

export type DocumentExport = (typeof DOCUMENT_EXPORTS)[number];
