import { type RoutineDefinition, missedPolicyOf } from '@clanks/core';
import { describe, expect, it } from 'vitest';
import {
  actionDue,
  canonicalJson,
  foundIn,
  frozenText,
  isTransientStatus,
  mediaIn,
  retryDelay,
  withMedia,
} from './action';
import { cronProblem, nextRun, nextRuns, parseCron, runsBetween } from './cron';
import { RoutineFormatError, readDefinition, routineFromYaml, routineToYaml } from './definition';
import {
  launchTime,
  launchdPlist,
  systemdUnits,
  windowsTaskCommands,
  windowsTaskXml,
} from './launch';
import { fillTemplates, parsePath, refProblem, templateRefs } from './template';
import { resolveAt, stepTimes, timingWarning } from './timing';
import { type RoutineEnvironment, checkDefinition } from './validate';
import { cronWords, parseSchedule, triggerWords } from './words';
import { instantOf, localStamp, whenText } from './zone';

const SYDNEY = 'Australia/Sydney';
const NEW_YORK = 'America/New_York';
const utc = (text: string) => new Date(`${text}Z`);
const local = (date: Date, zone: string) => localStamp(date, zone);

describe('cron', () => {
  it('reads lists, ranges, steps and names', () => {
    const cron = parseCron('*/15 9-17 * jan,jul mon-fri');
    expect(cron.minutes).toEqual([0, 15, 30, 45]);
    expect(cron.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(cron.months).toEqual([1, 7]);
    expect(cron.weekdays.values).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('0 9 * * 7').weekdays.values).toEqual([0]);
  });

  it('says what is wrong with an expression', () => {
    expect(cronProblem('0 13 * * 5')).toBeNull();
    expect(cronProblem('0 13 * *')).toMatch(/five parts/);
    expect(cronProblem('61 * * * *')).toMatch(/between 0 and 59/);
    expect(cronProblem('0 0 31 2 *')).toMatch(/No month/);
    expect(cronProblem('0 9 * * 2#6')).toMatch(/1st to a 5th/);
  });

  it('runs at the same wall time across a daylight-saving change', () => {
    // Fridays at 13:00 in Sydney, over the change of 5 April 2026 (UTC+11 to UTC+10).
    const cron = parseCron('0 13 * * 5');
    const runs = nextRuns(cron, utc('2026-03-27T00:00:00'), SYDNEY, 3);
    expect(runs.map((r) => r.toISOString())).toEqual([
      '2026-03-27T02:00:00.000Z',
      '2026-04-03T02:00:00.000Z',
      '2026-04-10T03:00:00.000Z',
    ]);
    expect(runs.map((r) => local(r, SYDNEY).slice(11))).toEqual(['13:00', '13:00', '13:00']);
  });

  it('runs a time the clocks skip at the next minute that exists', () => {
    // New York jumps from 02:00 to 03:00 on 8 March 2026.
    const cron = parseCron('30 2 * * *');
    const run = nextRun(cron, utc('2026-03-08T05:00:00'), NEW_YORK)!;
    expect(local(run, NEW_YORK)).toBe('2026-03-08T03:00');
    // The day after, it's back at 02:30.
    expect(local(nextRun(cron, run, NEW_YORK)!, NEW_YORK)).toBe('2026-03-09T02:30');
  });

  it('runs a time that happens twice once, the first time', () => {
    // New York goes back from 02:00 to 01:00 on 1 November 2026: 01:30 happens twice.
    const cron = parseCron('30 1 * * *');
    const first = nextRun(cron, utc('2026-11-01T04:00:00'), NEW_YORK)!;
    expect(first.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    const next = nextRun(cron, first, NEW_YORK)!;
    expect(local(next, NEW_YORK)).toBe('2026-11-02T01:30');
    // Asked from inside the second 01:xx hour, it doesn't run again that night.
    expect(local(nextRun(cron, utc('2026-11-01T06:10:00'), NEW_YORK)!, NEW_YORK)).toBe(
      '2026-11-02T01:30',
    );
  });

  it('knows the last day of the month and the nth weekday', () => {
    const last = nextRuns(parseCron('0 9 L * *'), utc('2026-01-15T00:00:00'), 'UTC', 3);
    expect(last.map((r) => r.toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    const secondTuesday = nextRuns(parseCron('0 9 * * 2#2'), utc('2026-01-01T00:00:00'), 'UTC', 2);
    expect(secondTuesday.map((r) => r.toISOString().slice(0, 10))).toEqual([
      '2026-01-13',
      '2026-02-10',
    ]);
    const lastFriday = nextRun(parseCron('0 9 * * 5L'), utc('2026-01-01T00:00:00'), 'UTC')!;
    expect(lastFriday.toISOString().slice(0, 10)).toBe('2026-01-30');
  });

  it('runs on a day of the month or a day of the week when it names both', () => {
    const runs = nextRuns(parseCron('0 0 13 * 5'), utc('2026-02-01T00:00:00'), 'UTC', 4);
    expect(runs.map((r) => r.toISOString().slice(0, 10))).toEqual([
      '2026-02-06',
      '2026-02-13',
      '2026-02-20',
      '2026-02-27',
    ]);
  });

  it('lists what came due in between, up to a limit', () => {
    const cron = parseCron('0 * * * *');
    const few = runsBetween(cron, utc('2026-01-01T00:30:00'), utc('2026-01-01T03:00:00'), 'UTC');
    expect(few.runs).toHaveLength(3);
    expect(few.more).toBe(false);
    const many = runsBetween(
      cron,
      utc('2026-01-01T00:30:00'),
      utc('2026-01-03T00:00:00'),
      'UTC',
      5,
    );
    expect(many.runs).toHaveLength(5);
    expect(many.more).toBe(true);
  });

  it('never runs twice for one time, and never goes backwards', () => {
    const cron = parseCron('*/20 * * * *');
    let from = utc('2026-10-31T22:00:00');
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const next = nextRun(cron, from, NEW_YORK)!;
      expect(+next).toBeGreaterThan(+from);
      expect(seen.has(+next)).toBe(false);
      seen.add(+next);
      from = next;
    }
  });
});

describe('schedules in words', () => {
  const now = utc('2026-11-11T01:00:00'); // Wednesday midday in Sydney
  const read = (words: string) => parseSchedule(words, { now, zone: SYDNEY });

  it('reads the common phrases', () => {
    expect(read('every weekday at 9')).toEqual({ kind: 'cron', cron: '0 9 * * 1-5' });
    expect(read('Every Friday at 1pm')).toEqual({ kind: 'cron', cron: '0 13 * * 5' });
    expect(read('fridays at 13:00')).toEqual({ kind: 'cron', cron: '0 13 * * 5' });
    expect(read('every monday and thursday at 10:30')).toEqual({
      kind: 'cron',
      cron: '30 10 * * 1,4',
    });
    expect(read('daily at 5:30 pm')).toEqual({ kind: 'cron', cron: '30 17 * * *' });
    expect(read('every 15 minutes')).toEqual({ kind: 'cron', cron: '*/15 * * * *' });
    expect(read('every two hours')).toEqual({ kind: 'cron', cron: '0 */2 * * *' });
    expect(read('hourly')).toEqual({ kind: 'cron', cron: '0 * * * *' });
    expect(read('first Monday of the month')).toEqual({ kind: 'cron', cron: '0 9 * * 1#1' });
    expect(read('last friday of every month at noon')).toEqual({
      kind: 'cron',
      cron: '0 12 * * 5L',
    });
    expect(read('last day of the month at 9')).toEqual({ kind: 'cron', cron: '0 9 L * *' });
    expect(read('on the 15th of every month at 8am')).toEqual({
      kind: 'cron',
      cron: '0 8 15 * *',
    });
    expect(read('every friday afternoon')).toEqual({ kind: 'cron', cron: '0 13 * * 5' });
  });

  it('reads one-off times in the routine zone', () => {
    expect(read('tomorrow at 5pm')).toEqual({ kind: 'once', at: '2026-11-12T17:00' });
    expect(read('today at 17:00')).toEqual({ kind: 'once', at: '2026-11-11T17:00' });
    expect(read('friday at 9')).toEqual({ kind: 'once', at: '2026-11-13T09:00' });
    expect(read('14 Nov at 1pm')).toEqual({ kind: 'once', at: '2026-11-14T13:00' });
    expect(read('2026-11-14 13:00')).toEqual({ kind: 'once', at: '2026-11-14T13:00' });
    expect(read('in 2 hours')).toEqual({ kind: 'once', at: '2026-11-11T14:00' });
  });

  it('takes a cron expression as it is, and leaves the rest to Atlas', () => {
    expect(read('0 13 * * 5')).toEqual({ kind: 'cron', cron: '0 13 * * 5' });
    expect(read('whenever the surf is good')).toBeNull();
    expect(read('manually')).toEqual({ kind: 'manual' });
  });

  it('says a schedule back in words', () => {
    expect(cronWords('0 13 * * 5')).toBe('Fridays at 13:00');
    expect(cronWords('0 9 * * 1-5')).toBe('Every weekday at 09:00');
    expect(cronWords('0 9 * * *')).toBe('Every day at 09:00');
    expect(cronWords('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cronWords('0 9 L * *')).toBe('On the last day of every month at 09:00');
    expect(cronWords('0 9 * * 2#2')).toBe('On the second Tuesday of every month at 09:00');
    expect(cronWords('30 10 * * 1,4')).toBe('Mondays and Thursdays at 10:30');
    expect(cronWords('0 9 1 * *')).toBe('On the 1st of every month at 09:00');
    expect(triggerWords({ kind: 'cron', cron: '0 13 * * 5' }, SYDNEY, now)).toBe(
      'Fridays at 13:00 (Australia/Sydney)',
    );
    expect(
      triggerWords({ kind: 'event', event: 'git.tag', filters: { pattern: 'v*' } }, SYDNEY, now),
    ).toBe("When a new tag appears in the project's repository (pattern v*)");
    expect(triggerWords({ kind: 'once', at: '2026-11-14T13:00' }, SYDNEY, now)).toBe(
      'Once, on Sat 14 Nov at 13:00 (Australia/Sydney)',
    );
  });
});

describe('templates', () => {
  it('reads paths with names, indexes and quoted names', () => {
    expect(parsePath("steps.banner.output.frames['Promo / X'].png")).toEqual([
      'steps',
      'banner',
      'output',
      'frames',
      'Promo / X',
      'png',
    ]);
    expect(parsePath('steps.copy.output.posts[0].text')).toEqual([
      'steps',
      'copy',
      'output',
      'posts',
      0,
      'text',
    ]);
    expect(parsePath('1 + 1')).toBeNull();
  });

  it('fills templates in, keeping what a lone template names as it is', () => {
    const scope = {
      inputs: { offer: '20% off longboards' },
      steps: {
        copy: { output: { posts: [{ text: 'Surf more.' }] } },
        banner: { output: { frames: { 'Promo / X': { png: { $media: 'abc' } } } } },
      },
    };
    const filled = fillTemplates(
      {
        text: '{{steps.copy.output.posts[0].text}} {{ inputs.offer }}',
        image: "{{steps.banner.output.frames['promo / x'].png}}",
        list: ['{{inputs.offer}}'],
        gone: '{{inputs.nothing}}',
      },
      scope,
    );
    expect(filled.value).toEqual({
      text: 'Surf more. 20% off longboards',
      image: { $media: 'abc' },
      list: ['20% off longboards'],
      gone: null,
    });
    expect(filled.missing).toEqual(['{{inputs.nothing}}']);
    // Things kept by name can be counted off, as a small model tends to write them.
    expect(fillTemplates('{{steps.banner.output.frames[0].png}}', scope).value).toEqual({
      $media: 'abc',
    });
  });

  it('refuses what a step may not read', () => {
    const context = { inputs: ['offer'], dependsOn: ['copy'], steps: true, event: false };
    const [ok, undeclared, noInput, code] = templateRefs([
      '{{steps.copy.output.posts[0].text}}',
      '{{steps.banner.output.frames}}',
      '{{inputs.price}}',
      '{{1 + 1}}',
    ]);
    expect(refProblem(ok!, context)).toBeNull();
    expect(refProblem(undeclared!, context)).toMatch(/doesn't depend on "banner"/);
    expect(refProblem(noInput!, context)).toMatch(/no input called "price"/);
    expect(refProblem(code!, context)).toMatch(/isn't a template/);
    expect(refProblem(ok!, { ...context, steps: false })).toMatch(/before any step/);
    expect(refProblem(templateRefs('{{event.tag}}')[0]!, context)).toMatch(/only a routine/i);
  });
});

const promo = (): RoutineDefinition =>
  readDefinition(
    {
      name: 'Weekend promo',
      schedule: 'every friday at 1pm',
      time_zone: SYDNEY,
      inputs: { offer: '20% off all longboards this weekend' },
      steps: [
        {
          id: 'banner',
          ticket: {
            clank: 'prism',
            type: 'design',
            title: 'Promo banner: {{inputs.offer}}',
            criteria: "- One frame named 'Promo / X' at 1600×900\n- Readable at half size",
          },
        },
        {
          id: 'copy',
          depends_on: ['banner'],
          ticket: { clank: 'buzz', type: 'campaign', title: 'X post for {{inputs.offer}}' },
        },
        {
          id: 'publish',
          depends_on: ['banner', 'copy'],
          action: {
            integration: 'xcom',
            operation: 'create_post_with_image',
            connection: '@surfshop',
            at: '17:00',
            payload: {
              text: '{{steps.copy.output.posts[0].text}}',
              image: "{{steps.banner.output.frames['Promo / X'].png}}",
            },
          },
        },
      ],
      budget: { per_run: { tokens: 300000 } },
    },
    { now: utc('2026-11-11T01:00:00'), zone: SYDNEY },
  );

describe('definitions', () => {
  it('reads a routine as a clank or a person writes it', () => {
    const definition = promo();
    expect(definition.trigger).toEqual({ kind: 'cron', cron: '0 13 * * 5' });
    expect(definition.timeZone).toBe(SYDNEY);
    expect(definition.steps[0]!.ticket!.criteria).toEqual([
      "One frame named 'Promo / X' at 1600×900",
      'Readable at half size',
    ]);
    expect(definition.steps[2]!.dependsOn).toEqual(['banner', 'copy']);
    expect(definition.budget.perRun).toEqual({ tokens: 300000, minutes: null, dollars: null });
    expect(definition.missed.grace).toBe('15m');
    expect(missedPolicyOf(definition)).toBe('skip');
  });

  it('round-trips through YAML', () => {
    const definition = promo();
    const yaml = routineToYaml(definition);
    expect(yaml).toContain('time_zone: Australia/Sydney');
    expect(yaml).toContain('depends_on:');
    expect(yaml).not.toContain('concurrency');
    const back = routineFromYaml(yaml, { now: utc('2026-11-11T01:00:00'), zone: 'UTC' });
    expect(back).toEqual(definition);
  });

  it("reads the spec's own example", () => {
    const yaml = `
name: Release notes
trigger:
  kind: event
  event: git.tag
  match: "v*"
steps:
  - id: notes
    ticket:
      clank: quill
      type: doc
      title: "Release notes for {{event.tag}}"
missed:
  policy: run_late
  grace: 30m
concurrency: queue
`;
    const definition = routineFromYaml(yaml, { now: utc('2026-11-11T01:00:00'), zone: 'UTC' });
    expect(definition.trigger).toEqual({
      kind: 'event',
      event: 'git.tag',
      filters: { pattern: 'v*' },
    });
    expect(definition.concurrency).toBe('queue');
    expect(missedPolicyOf(definition)).toBe('run_late');
  });

  it('says what is wrong with one that does not fit', () => {
    expect(() => routineFromYaml('- just\n- a list', { now: 0, zone: 'UTC' })).toThrow(
      RoutineFormatError,
    );
    expect(() =>
      readDefinition(
        { name: 'x', trigger: { kind: 'manual' }, steps: [] },
        { now: 0, zone: 'UTC' },
      ),
    ).toThrow(/steps/);
    expect(() =>
      readDefinition(
        {
          name: 'x',
          trigger: { kind: 'manual' },
          steps: [{ id: 'a', ticket: {}, action: {} }],
        },
        { now: 0, zone: 'UTC' },
      ),
    ).toThrow(RoutineFormatError);
  });
});

describe('timing', () => {
  const start = new Date(
    instantOf({ year: 2026, month: 11, day: 13, hour: 13, minute: 0 }, SYDNEY),
  );

  it('resolves a time on the run date, an offset and a date', () => {
    expect(local(resolveAt('17:00', start, SYDNEY)!, SYDNEY)).toBe('2026-11-13T17:00');
    expect(local(resolveAt('09:00', start, SYDNEY)!, SYDNEY)).toBe('2026-11-14T09:00');
    expect(local(resolveAt('+4h', start, SYDNEY)!, SYDNEY)).toBe('2026-11-13T17:00');
    expect(local(resolveAt('2026-12-01T08:30', start, SYDNEY)!, SYDNEY)).toBe('2026-12-01T08:30');
    expect(resolveAt('teatime', start, SYDNEY)).toBeNull();
  });

  it('makes tickets due a review buffer before the action that needs them', () => {
    const times = stepTimes(promo(), start, SYDNEY);
    expect(times.map((t) => [t.stepId, t.at && local(t.at, SYDNEY).slice(11)])).toEqual([
      ['banner', '16:00'],
      ['copy', '16:00'],
      ['publish', '17:00'],
    ]);
    expect(times[0]!.why).toBe('so it can be reviewed before the 17:00 post');
    expect(whenText(times[2]!.at!, SYDNEY, start)).toBe('Fri 13 Nov at 17:00');
  });

  it('warns when there is too little room before the first action', () => {
    expect(timingWarning(promo(), start, SYDNEY)).toBeNull();
    const tight = promo();
    tight.steps[2]!.action!.at = '+70m';
    expect(timingWarning(tight, start, SYDNEY)).toMatch(/Start earlier/);
  });
});

describe('checking a routine against its project', () => {
  const env: RoutineEnvironment = {
    crew: [
      { id: 'atlas', name: 'Atlas', outputs: [] },
      { id: 'prism', name: 'Prism', outputs: ['design'] },
      { id: 'buzz', name: 'Buzz', outputs: ['campaign'] },
    ],
    integrations: [
      {
        id: 'xcom',
        name: 'X',
        connection: '@surfshop',
        operations: [
          { id: 'create_post', parameters: ['text'], required: ['text'], schedule: null },
          {
            id: 'create_post_with_image',
            parameters: ['text', 'image'],
            required: ['text', 'image'],
            schedule: null,
          },
        ],
      },
    ],
    zone: SYDNEY,
    now: utc('2026-11-11T01:00:00'),
    start: utc('2026-11-13T02:00:00'),
  };

  it('passes the promo routine', () => {
    expect(checkDefinition(promo(), env)).toEqual({ problems: [], warnings: [] });
  });

  it('lists what stops it', () => {
    const broken = promo();
    broken.steps[0]!.ticket!.clank = 'forge';
    broken.steps[1]!.ticket!.type = 'design';
    broken.steps[1]!.dependsOn = ['nowhere'];
    broken.steps[2]!.action!.payload = {
      words: '{{steps.banner.output.x}}',
      text: '{{inputs.price}}',
    };
    broken.steps[2]!.action!.deliver = 'hand_off';
    broken.trigger = { kind: 'cron', cron: '99 * * * *' };
    const { problems } = checkDefinition(broken, {
      ...env,
      integrations: [{ ...env.integrations[0]!, connection: null }],
    });
    expect(problems.join('\n')).toMatch(/schedule can't be read/);
    expect(problems.join('\n')).toMatch(/forge, who isn't in this project's crew/);
    expect(problems.join('\n')).toMatch(/Buzz doesn't make design tickets\. Prism does/);
    expect(problems.join('\n')).toMatch(/depends on "nowhere", which isn't a step/);
    expect(problems.join('\n')).toMatch(/takes no "words"/);
    expect(problems.join('\n')).toMatch(/needs "image"/);
    expect(problems.join('\n')).toMatch(/can't be handed off/);
    expect(problems.join('\n')).toMatch(
      /no account is turned on in this project for `xcom` \(X\)\. No service has an account here yet/,
    );
    expect(problems.join('\n')).toMatch(
      /a design ticket hands in no "x"\. Use output\.image for its picture/,
    );
    expect(problems.join('\n')).toMatch(/no input called "price"/);
  });

  it('catches steps that wait on each other', () => {
    const looped = promo();
    looped.steps[0]!.dependsOn = ['copy'];
    expect(checkDefinition(looped, env).problems.join('\n')).toMatch(/waiting on itself/);
  });
});

describe('scheduled actions', () => {
  it('hashes the same action the same way, whatever order its fields are in', () => {
    const action = {
      integrationId: 'xcom',
      operationId: 'create_post',
      connectionId: 'c1',
      payload: { text: 'Surf more.', image: { $media: 'abc' } },
      executeAt: 1000,
      delivery: 'at_time',
    };
    expect(frozenText(action)).toBe(
      frozenText({ ...action, payload: { image: { $media: 'abc' }, text: 'Surf more.' } }),
    );
    expect(frozenText(action)).not.toBe(frozenText({ ...action, executeAt: 1001 }));
    expect(frozenText(action)).not.toBe(
      frozenText({ ...action, payload: { ...action.payload, text: 'Surf more!' } }),
    );
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('finds the files a payload names and swaps them for their bytes', () => {
    const payload = { text: 'hi', images: [{ $media: 'abc' }, { $media: 'def' }] };
    expect(mediaIn(payload)).toEqual(['abc', 'def']);
    expect(withMedia(payload, (sha) => `<${sha}>`)).toEqual({
      text: 'hi',
      images: ['<abc>', '<def>'],
    });
  });

  it('sends only inside its window', () => {
    const action = { executeAt: 1000, graceMs: 500 };
    expect(actionDue(action, 999)).toBe('early');
    expect(actionDue(action, 1000)).toBe('due');
    expect(actionDue(action, 1500)).toBe('due');
    expect(actionDue(action, 1501)).toBe('late');
  });

  it('retries what may yet work, with a growing wait', () => {
    expect([500, 503, 429, 408].every(isTransientStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(isTransientStatus)).toBe(false);
    expect([1, 2, 3, 4, 9].map(retryDelay)).toEqual([5000, 15000, 45000, 120000, 120000]);
  });

  it('looks for a post in what a service lists', () => {
    const payload = { text: 'Longboards are 20% off\nall weekend.' };
    expect(foundIn(payload, { data: [{ text: 'Longboards are 20% off\nall weekend.' }] })).toBe(
      true,
    );
    expect(foundIn(payload, { data: [{ text: 'Something else entirely.' }] })).toBe(false);
    expect(foundIn({ text: 'hi' }, { data: [{ text: 'hi' }] })).toBe(false);
  });
});

describe('the task that starts the app', () => {
  const at = new Date(2026, 10, 13, 12, 57);

  it('words a Windows task that can wake the computer', () => {
    const xml = windowsTaskXml({ exe: 'C:\\Program Files\\clanks\\clanks.exe', at, wake: true });
    expect(xml).toContain('<StartBoundary>2026-11-13T12:57:00</StartBoundary>');
    expect(xml).toContain('<WakeToRun>true</WakeToRun>');
    expect(xml).toContain('<Command>C:\\Program Files\\clanks\\clanks.exe</Command>');
    expect(xml).toContain('<Arguments>--background</Arguments>');
    expect(windowsTaskCommands('C:\\t.xml').register).toEqual([
      'schtasks',
      '/Create',
      '/TN',
      'clanks next routine',
      '/XML',
      'C:\\t.xml',
      '/F',
    ]);
  });

  it('words a launchd agent and a systemd timer for the same minute', () => {
    const plist = launchdPlist({ app: '/Applications/clanks.app', at });
    expect(plist).toContain('<string>/Applications/clanks.app</string>');
    expect(plist).toMatch(/<key>Hour<\/key>\s*<integer>12<\/integer>/);
    expect(plist).toMatch(/<key>Minute<\/key>\s*<integer>57<\/integer>/);
    const units = systemdUnits({ exe: '/opt/clanks/clanks', at });
    expect(units.timer).toContain('OnCalendar=2026-11-13 12:57:00');
    expect(units.service).toContain('ExecStart="/opt/clanks/clanks" --background');
  });

  it('starts the app a few minutes early, and not for something about to happen', () => {
    const due = new Date(2026, 10, 13, 13, 0);
    expect(launchTime(due, new Date(2026, 10, 13, 9, 0))).toEqual(at);
    expect(launchTime(due, new Date(2026, 10, 13, 12, 56))).toBeNull();
  });
});
