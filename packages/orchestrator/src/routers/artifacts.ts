import {
  DOCUMENT_EXPORTS,
  type DocumentExport,
  type Ticket,
  emailConfigured,
  isTextArtifact,
  keepLineBreaks,
  outputDocument,
  ticketIdSchema,
} from '@clanks/core';
import { z } from 'zod';
import { ArtifactError } from '../artifacts/service';
import { fileName } from '../design/service';
import { htmlPage, printableHtml, wordDocument } from '../exports/document';
import { userProcedure } from '../procedures';
import { type OrchestratorContext, publicProcedure, router } from '../trpc';

const artifactId = z.uuid();

/** A written hand-in, or one earlier version of it, as a file in the format asked for. */
export async function documentFile(
  ctx: OrchestratorContext,
  ticket: Ticket,
  format: DocumentExport,
  versionId?: string,
): Promise<{ name: string; data: Uint8Array }> {
  let text: string;
  let plain: boolean;
  let title: string;
  if (versionId) {
    const artifact = ctx.artifacts.get(versionId);
    if (artifact.ticketId !== ticket.id) throw new ArtifactError("That file isn't this ticket's");
    text = ctx.artifacts.text(versionId);
    plain = artifact.mediaType !== 'text/markdown';
    title = ticket.title;
  } else {
    const document = outputDocument(ticket.output);
    if (!document) throw new ArtifactError(`${ticket.key} has nothing written to export yet`);
    ({ text, title } = document);
    plain = document.mediaType !== 'text/markdown';
  }
  // Copy is set out a piece to a line, which the exported page keeps.
  if (ticket.type === 'copy' && !plain && format !== 'md') text = keepLineBreaks(text);
  const stem = `${ticket.key}-${fileName(title)}`.slice(0, 100);
  const project = ctx.projects.find(ticket.projectId);
  switch (format) {
    case 'md':
      return { name: `${stem}.${plain ? 'txt' : 'md'}`, data: Buffer.from(text, 'utf8') };
    case 'html':
      return { name: `${stem}.html`, data: Buffer.from(htmlPage({ title, text, plain }), 'utf8') };
    case 'docx':
      return {
        name: `${stem}.docx`,
        data: await wordDocument({
          title,
          text,
          plain,
          author: ctx.settings.get().profile.name || 'clanks',
        }),
      };
    case 'pdf':
      return {
        name: `${stem}.pdf`,
        data: await ctx.design.printDocument(
          printableHtml({
            text,
            plain,
            meta: [project?.name, ticket.key].filter(Boolean).join(' · '),
          }),
        ),
      };
  }
}

/** Asks where to save a file and writes it there. Null when the user cancels. */
async function saveAs(
  ctx: OrchestratorContext,
  file: { name: string; data: Uint8Array },
  title: string,
): Promise<string | null> {
  if (!ctx.host) throw new ArtifactError("Saving a file needs the app's file dialog");
  const ending = /\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? '';
  return ctx.host.saveFile(
    { title, defaultName: file.name, extensions: ending ? [ending] : [] },
    file.data,
  );
}

/** What the crew made that isn't in a repository, and taking it elsewhere as a file. */
export const artifactsRouter = router({
  /** Everything kept with a ticket: every name, every version, the newest first. */
  forTicket: userProcedure
    .input(ticketIdSchema)
    .query(({ ctx, input }) => ctx.artifacts.forTicket(input)),

  /** One artifact's text, for reading a note or an earlier version in the app. */
  text: userProcedure.input(artifactId).query(({ ctx, input }) => ctx.artifacts.text(input)),

  /** A picture kept with a ticket, such as a page a research note cites, as a data URL. */
  picture: userProcedure.input(artifactId).query(({ ctx, input }) => {
    const artifact = ctx.artifacts.get(input);
    if (!artifact.mediaType.startsWith('image/')) throw new ArtifactError("That isn't a picture");
    const data = Buffer.from(ctx.artifacts.read(input));
    return `data:${artifact.mediaType};base64,${data.toString('base64')}`;
  }),

  /** Saves one artifact, as it is, where the user picks. */
  save: userProcedure.input(artifactId).mutation(({ ctx, input }) => {
    const artifact = ctx.artifacts.get(input);
    return saveAs(
      ctx,
      { name: artifact.name, data: ctx.artifacts.read(input) },
      `Save ${artifact.name}`,
    );
  }),

  /**
   * Saves a ticket's written hand-in as Markdown, HTML, a Word document or a PDF, where the user
   * picks. With `version`, an earlier version of it instead of the newest.
   */
  export: userProcedure
    .input(
      z.object({
        ticketId: ticketIdSchema,
        format: z.enum(DOCUMENT_EXPORTS),
        version: artifactId.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ticket = ctx.board.ticket(input.ticketId);
      if (input.version && !isTextArtifact(ctx.artifacts.get(input.version))) {
        throw new ArtifactError("That file isn't text, so it has no other formats");
      }
      const file = await documentFile(ctx, ticket, input.format, input.version);
      return saveAs(ctx, file, `Export ${ticket.key}`);
    }),
});

/** The account approved emails go out through. Its settings are in Settings; its password in the keychain. */
export const emailRouter = router({
  status: publicProcedure.query(({ ctx }) => ({
    ...ctx.email.status(),
    configured: emailConfigured(ctx.settings.get().email),
  })),

  /** Signs in to the mail server and out again, to check the account works. */
  test: userProcedure.mutation(({ ctx }) => ctx.email.test()),
});
