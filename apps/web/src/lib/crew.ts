/**
 * The crew that ships with the app, as its priming docs in crew/ define them, in the plain words
 * the app introduces them with (apps/desktop/src/renderer/src/lib/crew.ts).
 */
export type ClankId = 'atlas' | 'scribe' | 'prism' | 'forge' | 'gauge' | 'scout' | 'quill' | 'buzz';

export interface Clank {
  id: ClankId;
  name: string;
  role: string;
  job: string;
  blurb: string;
  optional?: boolean;
}

export const CREW: Clank[] = [
  {
    id: 'atlas',
    name: 'Atlas',
    role: 'Lead',
    job: 'Leads the crew',
    blurb:
      'Tell Atlas what you want. It plans the work, hands it to the right clanks and checks it before it comes back to you.',
  },
  {
    id: 'scribe',
    name: 'Scribe',
    role: 'Business Analyst',
    job: 'Writes up the plan',
    blurb:
      'Turns a rough idea into a clear, written list of what will be made, for you to approve.',
  },
  {
    id: 'prism',
    name: 'Prism',
    role: 'Designer',
    job: 'Designs it',
    blurb: 'Designs how things look: pages, logos, colours and graphics, in the built-in Studio.',
  },
  {
    id: 'forge',
    name: 'Forge',
    role: 'Engineer',
    job: 'Builds it',
    blurb:
      'Builds websites, apps and anything made of code, with tests, each ticket on its own branch.',
  },
  {
    id: 'gauge',
    name: 'Gauge',
    role: 'QA',
    job: 'Checks it works',
    blurb: "Tries out what was built the way a person would, and says what's broken.",
  },
  {
    id: 'scout',
    name: 'Scout',
    role: 'Researcher',
    job: 'Does the research',
    blurb: 'Looks things up, and comes back with what it found and where it found it.',
    optional: true,
  },
  {
    id: 'quill',
    name: 'Quill',
    role: 'Writer',
    job: 'Writes the words',
    blurb: 'Writes documents, emails, the words on a website, and posts.',
    optional: true,
  },
  {
    id: 'buzz',
    name: 'Buzz',
    role: 'Marketing',
    job: 'Spreads the word',
    blurb: 'Plans how to tell people: campaigns, posts, and when they go out.',
    optional: true,
  },
];

/** Each clank's colour, as its avatar wears it in the app. */
export const GRADIENTS: Record<ClankId | 'sentinel', string> = {
  atlas: 'from-violet-300 to-indigo-400',
  scribe: 'from-rose-200 to-pink-400',
  prism: 'from-fuchsia-200 to-purple-400',
  forge: 'from-amber-200 to-orange-400',
  gauge: 'from-lime-200 to-green-400',
  scout: 'from-emerald-200 to-teal-400',
  quill: 'from-sky-200 to-blue-400',
  buzz: 'from-yellow-200 to-amber-400',
  sentinel: 'from-red-300 to-rose-500',
};
