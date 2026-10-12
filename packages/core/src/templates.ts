import { z } from 'zod';
import { clankIdSchema, outputTypeSchema } from './crew';

/**
 * A project template: a kind of project to start from, with the crew it wants and what the crew is
 * asked to do first. A few ship with the app, and more install from a marketplace as `template`
 * packages. A template is data: it picks clanks that are already there and words a first message.
 */

/** A ticket a template puts on the board as the project is made, with no planning in between. */
export const templateTicketSchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: outputTypeSchema,
  /** Who makes it. Left out, the first free clank that makes its type picks it up. */
  clank: clankIdSchema.optional(),
  description: z.string().trim().max(20_000).default(''),
  criteria: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
  /** The tickets it waits on, by their place in the list, from 0. */
  dependsOn: z.array(z.number().int().min(0).max(49)).max(20).default([]),
});

export type TemplateTicket = z.infer<typeof templateTicketSchema>;

/** `template.yaml`: what a template package holds. */
export const projectTemplateFileSchema = z.object({
  /** The crew the project starts with. Atlas is added if it's left out. */
  crew: z.array(clankIdSchema).min(1).max(12),
  /** What the user is asked for, such as "What should it do, and for whom?" */
  ask: z.string().trim().max(200).default(''),
  /** A brief to start from, which the user changes. */
  example: z.string().trim().max(500).default(''),
  /**
   * What Atlas is told when the project is made, in a chat the user can read and carry on.
   * `{{brief}}` is what the user wrote, `{{name}}` the project's name. Empty starts no chat.
   */
  kickoff: z.string().trim().max(4000).default(''),
  /** Tickets put on the board straight away. Text can use `{{brief}}` and `{{name}}` too. */
  tickets: z.array(templateTicketSchema).max(50).default([]),
  /** It makes code, so its workspace has to be a folder the crew can build in. */
  code: z.boolean().default(true),
});

export type ProjectTemplateFile = z.infer<typeof projectTemplateFileSchema>;

/** A template as the new project page lists it. */
export interface ProjectTemplate extends ProjectTemplateFile {
  id: string;
  name: string;
  summary: string;
  /** Shipped with the app, or installed from a marketplace. */
  source: 'builtin' | 'marketplace';
}

/** The template the first-run tour offers: small enough to finish while the user watches. */
export const SAMPLE_TEMPLATE = 'sample';

const builtin = (
  template: Omit<ProjectTemplate, 'source' | keyof ProjectTemplateFile> &
    z.input<typeof projectTemplateFileSchema>,
): ProjectTemplate => {
  const { id, name, summary, ...file } = template;
  return { id, name, summary, source: 'builtin', ...projectTemplateFileSchema.parse(file) };
};

/** The templates that ship with the app. */
export const BUILTIN_TEMPLATES: readonly ProjectTemplate[] = [
  builtin({
    id: 'ship-a-feature',
    name: 'Ship a feature',
    summary:
      'A spec you approve, a design where it has a screen, the code and QA, ending in a pull request to merge.',
    crew: ['atlas', 'scribe', 'prism', 'forge', 'gauge'],
    ask: 'What should it do, and for whom?',
    example: 'Let shoppers save boards to a wishlist and share it with a link.',
    kickoff:
      'I want to ship this: {{brief}}\n\nLook at what the project has already, then start a spec for it. Ask me only what would change the plan.',
  }),
  builtin({
    id: 'landing-page',
    name: 'Design and build a landing page',
    summary:
      'Copy, a design built from it, and the page itself, checked in the browser against the design.',
    crew: ['atlas', 'quill', 'prism', 'forge', 'gauge'],
    ask: 'What is the page for, and who should it speak to?',
    example:
      'A landing page for a weekend surf school in Byron Bay, to get people to book a lesson.',
    kickoff:
      'Design and build a landing page: {{brief}}\n\nIt needs no spec. Create the tickets now: Quill writes the page copy, Prism designs the page from that copy, and Forge sets up the site and builds the page to match the design. Each waits on the one before it.',
  }),
  builtin({
    id: 'plan-a-launch',
    name: 'Plan a launch',
    summary:
      'Research on who it is for, a campaign plan with posts to approve, the announcement, and the graphics.',
    crew: ['atlas', 'scout', 'buzz', 'quill', 'prism'],
    ask: 'What are you launching, and when?',
    example:
      'Our surf school opens for bookings on 1 December. We have Instagram and a mailing list.',
    kickoff:
      'Plan the launch of this: {{brief}}\n\nIt needs no spec. Create the tickets now: Scout researches the audience and how similar launches went, Buzz plans the campaign and drafts its posts from that research, Quill writes the announcement, and Prism makes the graphics the posts need.',
    code: false,
  }),
  builtin({
    id: 'question-to-report',
    name: 'Turn a question into a report',
    summary: 'Research with sources you can check, written up as a short report to share.',
    crew: ['atlas', 'scout', 'quill'],
    ask: 'What do you want to know?',
    example: 'Which payment providers suit a small shop in Australia, and what does each cost?',
    kickoff:
      'I have a question: {{brief}}\n\nIt needs no spec. Create a research ticket for Scout to answer it with sources, then a doc ticket for Quill, waiting on the research, that turns it into a short report I can share.',
    code: false,
  }),
  builtin({
    id: SAMPLE_TEMPLATE,
    name: 'Sample: a page for a coffee cart',
    summary:
      'A small project to watch the crew work: Quill writes a page, Forge builds it, Gauge checks it, and you approve.',
    crew: ['atlas', 'quill', 'forge', 'gauge'],
    ask: 'Whose coffee cart is it?',
    example: 'Bean There, a coffee cart at the Saturday market in Fremantle.',
    tickets: [
      {
        title: 'Write the copy for a one-page site',
        type: 'copy',
        clank: 'quill',
        description:
          'The words for a one-page website for this business: {{brief}}\n\nA headline, a sentence under it, three short reasons to stop by, the opening hours and where to find it. Make up plausible details where none are given, and say in your notes which you made up.',
        criteria: [
          'A headline of at most eight words and one sentence under it',
          'Three reasons to stop by, each one line',
          'Opening hours and a location',
        ],
        dependsOn: [],
      },
      {
        title: 'Build the one-page site',
        type: 'pr',
        clank: 'forge',
        description:
          'A one-page website for this business: {{brief}}\n\nOne `index.html` with its own CSS, no framework and no build step, using the copy from the ticket this one waits on, word for word. A warm, simple look that reads well on a phone.',
        criteria: [
          'index.html opens in a browser with no errors in the console',
          'Every line of the copy is on the page, word for word',
          'The page reads well at 390px wide and at 1280px wide',
        ],
        dependsOn: [0],
      },
    ],
  }),
];

/** Fills a template's `{{brief}}` and `{{name}}` in. */
export function fillTemplate(text: string, values: { brief: string; name: string }): string {
  return text
    .replace(/\{\{\s*brief\s*\}\}/g, values.brief.trim() || values.name)
    .replace(/\{\{\s*name\s*\}\}/g, values.name);
}
