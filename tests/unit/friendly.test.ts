// @vitest-environment happy-dom
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CARD_TTL_MINUTES,
  CATALOG,
  CHEER_EVERY_HOURS,
  CHEER_FIRST_HOURS,
  EMPTY_MESSAGES,
  KIND_GROUP,
  MESSAGE_LOCALES,
  MIN_GAP_MINUTES,
  NO_REPEAT,
  WEEKEND_REST_AFTER_MINUTES,
  WEEKEND_START_MINUTES,
  MILESTONE_HOURS,
  MEETING_LONG_MINUTES,
  OVERTIME_FROM_HOURS,
  afterStop,
  beaconLocale,
  beaconTimeZone,
  cheerStep,
  inWindow,
  isTimeZone,
  lineAllowed,
  lineText,
  messageLocale,
  nextCard,
  normalizeLocale,
  pickDailyDone,
  pickIdleLine,
  pickLine,
  planMessage,
  remember,
  sanitizeMessages,
  stepHours,
  stretchKind,
  taskKind,
  visibleCard,
  zonedParts,
  type MessageState,
  type PlanInput,
} from '../../src/lib/friendly';
import { POOL_KINDS, POSE_IDS, type Line } from '../../src/lib/messages/types';
import { POSE_ART, POSE_FALLBACK, poseArt, poseFile } from '../../src/ui/mascot';

const MADRID = 'Europe/Madrid';
const ON = { fun: true, wellbeing: true };
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] as number;
};

/** Plan input for a timer started at `start` and checked at `now` (ISO, with offset). */
function input(start: string, now: string, patch: Partial<PlanInput> = {}): PlanInput {
  return { now: new Date(now), startedAt: new Date(start).toISOString(), entry: 'T-1@x', switches: ON, windows: CATALOG.en.windows, timeZone: MADRID, state: EMPTY_MESSAGES, ...patch };
}
const kind = (value: PlanInput) => planMessage(value)?.kind ?? null;

describe('message pools', () => {
  it('every locale has native pools of the same minimum size, every line a known pose and only known placeholders', () => {
    const minimum: Record<string, number> = { idle: 15, cheer: 15, milestone: 6, overtime: 6, meetingIdle: 6, meetingAfter: 6, dailyDone: 6 };
    for (const locale of MESSAGE_LOCALES) {
      const { pools } = CATALOG[locale];
      for (const name of POOL_KINDS) {
        const lines = pools[name];
        expect(lines.length, `${locale}.${name}`).toBeGreaterThanOrEqual(minimum[name] ?? 8);
        expect(lines.length, `${locale}.${name} same size as en`).toBe(CATALOG.en.pools[name].length);
        expect(new Set(lines.map((line) => line.text)).size, `${locale}.${name} unique`).toBe(lines.length);
        for (const line of lines) {
          expect(POSE_IDS, `${locale}.${name}: ${line.text}`).toContain(line.pose);
          expect(line.text.replace(/\{hours\}/g, ''), line.text).not.toMatch(/[{}]/);
          expect(line.text.trim()).toBe(line.text);
        }
      }
      // A few wellbeing nudges among the cheers, never all of them.
      const wellbeing = pools.cheer.filter((line) => line.wellbeing).length;
      expect(wellbeing).toBeGreaterThanOrEqual(3);
      expect(wellbeing).toBeLessThan(pools.cheer.length / 2);
      // Every "Still there?" phrasing is a question.
      for (const line of [...pools.idle, ...pools.meetingIdle]) expect(line.text, `${locale} idle`).toMatch(/\?/);
    }
  });

  it('pools are written per language, not copied from English', () => {
    for (const locale of MESSAGE_LOCALES.filter((item) => item !== 'en')) {
      const english = new Set(POOL_KINDS.flatMap((name) => CATALOG.en.pools[name].map((line) => line.text)));
      const own = POOL_KINDS.flatMap((name) => CATALOG[locale].pools[name]);
      expect(own.filter((line) => english.has(line.text)), locale).toEqual([]);
    }
  });

  it('every pose with art is used, every pose without art has an existing fallback; art is 1x / @2x WebP', () => {
    const used = new Set(MESSAGE_LOCALES.flatMap((locale) => POOL_KINDS.flatMap((name) => CATALOG[locale].pools[name].map((line) => line.pose))));
    for (const id of POSE_ART) expect(used, id).toContain(id);
    for (const id of POSE_IDS) {
      if (!POSE_ART.has(id)) expect(existsSync(`public/mascot/${POSE_FALLBACK[id] ?? 'missing'}.webp`), id).toBe(true);
      if (POSE_ART.has(id)) {
        expect(existsSync(`public/mascot/pose-${id}.webp`)).toBe(true);
        expect(existsSync(`public/mascot/pose-${id}@2x.webp`)).toBe(true);
        expect(statSync(`public/mascot/pose-${id}@2x.webp`).size).toBeLessThan(45_000);
      }
    }
    for (const id of POSE_ART) expect(POSE_IDS as readonly string[]).toContain(id);
  });

  it('each locale has its own time windows (Spanish lunch is later)', () => {
    expect(CATALOG.es.windows.lunch[0]).toBeGreaterThan(CATALOG.en.windows.lunch[0]);
    expect(CATALOG.es.windows.lateFrom).toBeGreaterThan(CATALOG.en.windows.lateFrom);
    for (const locale of MESSAGE_LOCALES) {
      const w = CATALOG[locale].windows;
      expect(w.earlyBefore).toBeLessThan(w.earlyUntil);
      expect(w.coffeeAm[1]).toBeLessThanOrEqual(w.lunch[0]);
      expect(w.lunch[1]).toBeLessThanOrEqual(w.coffeePm[0]);
      expect(w.fridayFrom).toBeLessThan(w.lateFrom);
    }
  });
});

describe('poses (data-driven art)', () => {
  it('uses its own art once imported, else the closest existing pose', () => {
    expect(poseFile('beach', new Set())).toBe(POSE_FALLBACK.beach);
    expect(poseFile('coffee', new Set())).toBe('mascot-small');
    expect(poseFile('coffee', new Set(['coffee']))).toBe('pose-coffee');
  });

  it('is decorative and tagged with the message pose id', () => {
    const image = poseArt('sofa', 'mascot tiny');
    expect(image.getAttribute('data-pose')).toBe('sofa');
    expect(image.getAttribute('alt')).toBe('');
    expect(image.getAttribute('aria-hidden')).toBe('true');
    expect(image.getAttribute('src')).toBe(`mascot/${poseFile('sofa')}.webp`);
    expect(image.getAttribute('srcset')).toContain('@2x.webp 2x');
  });

  it('the import script and the manifest stay in step', () => {
    const script = readFileSync('scripts/mascot/import-poses.sh', 'utf8');
    expect(script).toContain('cwebp');
    expect(script).toContain('src/ui/pose-art.json');
    expect(JSON.parse(readFileSync('src/ui/pose-art.json', 'utf8'))).toEqual([...POSE_ART]);
  });
});

describe('locale and time zone', () => {
  it('normalises Beacon locales to a pool language', () => {
    expect(normalizeLocale('es_ES')).toBe('es');
    expect(normalizeLocale('pt-BR')).toBe('pt');
    expect(normalizeLocale(' DE ')).toBe('de');
    expect(normalizeLocale('ja')).toBeNull();
    expect(normalizeLocale(42)).toBeNull();
  });

  it('Beacon user locale first, then the UI locale, then English', () => {
    expect(messageLocale('fr_FR', 'es')).toBe('fr');
    expect(messageLocale(null, 'es')).toBe('es');
    expect(messageLocale('ja', 'es')).toBe('es');
    expect(messageLocale('ja', 'ko')).toBe('en');
    expect(messageLocale(undefined, undefined)).toBe('en');
    expect(beaconLocale({ locale: 'it' })).toBe('it');
    expect(beaconLocale({ identifier: 'x' })).toBeNull();
    expect(beaconLocale(null)).toBeNull();
  });

  it('Beacon time zone from the working hours, else me.timezone, else the system (null)', () => {
    expect(beaconTimeZone({ workingHours: { timezone: 'America/New_York', slots: [] } })).toBe('America/New_York');
    expect(beaconTimeZone({ workingHours: { timezone: 'Not/AZone', slots: [] }, timezone: MADRID })).toBe(MADRID);
    expect(beaconTimeZone({ workingHours: null })).toBeNull();
    expect(beaconTimeZone(null)).toBeNull();
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(3)).toBe(false);
  });

  it('local parts follow the zone and DST', () => {
    // 2026-03-29: Madrid moves from UTC+1 to UTC+2 at 01:00 UTC.
    expect(zonedParts(new Date('2026-03-29T00:30:00Z'), MADRID)).toEqual({ date: '2026-03-29', day: 7, minute: 90 });
    expect(zonedParts(new Date('2026-03-29T01:30:00Z'), MADRID)).toEqual({ date: '2026-03-29', day: 7, minute: 210 });
    expect(zonedParts(new Date('2026-11-06T23:30:00Z'), 'America/New_York').day).toBe(5);
    expect(zonedParts(new Date('2026-11-06T23:30:00Z'), MADRID).day).toBe(6);
    expect(zonedParts(new Date('2026-11-06T23:30:00Z'), 'Asia/Tokyo')).toMatchObject({ date: '2026-11-07', day: 6 });
    expect(zonedParts(new Date('2026-11-06T23:30:00Z'), null).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('windows wrap past midnight', () => {
    expect(inWindow(23 * 60, [20 * 60, 5 * 60])).toBe(true);
    expect(inWindow(4 * 60, [20 * 60, 5 * 60])).toBe(true);
    expect(inWindow(12 * 60, [20 * 60, 5 * 60])).toBe(false);
    expect(inWindow(12 * 60, [12 * 60, 13 * 60])).toBe(true);
    expect(inWindow(13 * 60, [12 * 60, 13 * 60])).toBe(false);
  });
});

describe('selection', () => {
  const lines: Line[] = Array.from({ length: 10 }, (_, i) => ({ text: `l${i}`, pose: 'wave', ...(i < 2 ? { wellbeing: true as const } : {}) }));

  it('random with an injectable RNG', () => {
    expect(pickLine(lines, [], () => 0)).toBe(0);
    expect(pickLine(lines, [], () => 0.99)).toBe(9);
    expect(pickLine(lines, [], () => 1)).toBe(9);
    expect(pickLine(lines, [], () => -1)).toBe(0);
  });

  it(`never repeats one of the last ${NO_REPEAT}`, () => {
    let recent: number[] = [];
    for (let round = 0; round < 50; round++) {
      const index = pickLine(lines, recent, Math.random) as number;
      expect(recent.slice(-NO_REPEAT)).not.toContain(index);
      recent = remember(recent, index);
    }
    expect(recent.length).toBe(NO_REPEAT * 2);
  });

  it('a small allowed subset still avoids the very last line', () => {
    const wellbeing = (line: Line) => line.wellbeing === true;
    expect(pickLine(lines, [0, 1], () => 0, wellbeing)).toBe(0);
    expect(pickLine(lines, [1, 0], () => 0, wellbeing)).toBe(1);
    expect(pickLine([lines[0] as Line], [0], () => 0)).toBe(0);
    expect(pickLine(lines, [], () => 0, () => false)).toBeNull();
  });

  it('cheer lines follow their own switch, the other pools their group', () => {
    const fun = { text: 'x', pose: 'wave' } as Line;
    const care = { text: 'y', pose: 'water', wellbeing: true } as Line;
    expect(lineAllowed('cheer', fun, { fun: true, wellbeing: false })).toBe(true);
    expect(lineAllowed('cheer', care, { fun: true, wellbeing: false })).toBe(false);
    expect(lineAllowed('cheer', care, { fun: false, wellbeing: true })).toBe(true);
    expect(lineAllowed('lunch', fun, { fun: true, wellbeing: false })).toBe(false);
    expect(lineAllowed('weekend', fun, { fun: true, wellbeing: false })).toBe(true);
    expect(KIND_GROUP.idle).toBe('fun');
  });

  it('fills {hours} and tolerates an index that no longer exists', () => {
    expect(lineText('en', 'cheer', 0, { hours: 4 })?.text).toBe('4 hours in and still going strong. Look at you!');
    expect(lineText('en', 'cheer', 0)?.text).toContain(`${CHEER_FIRST_HOURS} hours`);
    expect(lineText('en', 'cheer', 999)).toBeNull();
  });

  it('idle phrasing: picked from the locale pool without repeats; none with Fun messages off', () => {
    let state: MessageState = EMPTY_MESSAGES;
    const shown: number[] = [];
    for (let i = 0; i < NO_REPEAT + 1; i++) {
      state = pickIdleLine(state, 'es', seq(0), ON);
      shown.push(state.idleLine as number);
    }
    expect(new Set(shown.slice(0, NO_REPEAT)).size).toBe(NO_REPEAT);
    expect(lineText('es', 'idle', shown[0] as number)?.text).toBe(CATALOG.es.pools.idle[0]?.text);
    expect(pickIdleLine(state, 'es', seq(0), { fun: false, wellbeing: true }).idleLine).toBeNull();
  });
});

describe('thresholds and moments', () => {
  it(`cheers at ${CHEER_FIRST_HOURS} h, then every ${CHEER_EVERY_HOURS} h`, () => {
    expect(cheerStep(119)).toBe(0);
    expect(cheerStep(120)).toBe(1);
    expect(cheerStep(239)).toBe(1);
    expect(cheerStep(240)).toBe(2);
    expect(cheerStep(360)).toBe(3);
    expect(cheerStep(90, 1, 1)).toBe(1);
  });

  it('a long stretch on a quiet Tuesday afternoon: cheer step by step, each once', () => {
    const start = '2026-11-03T12:30:00+01:00';
    expect(kind(input(start, '2026-11-03T14:20:00+01:00'))).toBeNull();
    const first = planMessage(input(start, '2026-11-03T14:31:00+01:00'));
    expect(first).toEqual({ kind: 'milestone', slot: 'cheer:T-1@x:1' });
    expect(planMessage(input(start, '2026-11-03T14:31:00+01:00', { state: { ...EMPTY_MESSAGES, seen: ['cheer:T-1@x:1'] } }))).toBeNull();
    expect(planMessage(input(start, '2026-11-03T16:45:00+01:00', { windows: CATALOG.es.windows, state: { ...EMPTY_MESSAGES, seen: ['cheer:T-1@x:1'] } }))?.slot).toBe('cheer:T-1@x:2');
  });

  it('early start: before the locale threshold, in its time zone, across DST', () => {
    // 06:00 UTC is 07:00 in Madrid in winter (early) …
    expect(kind(input('2026-01-13T06:00:00Z', '2026-01-13T06:01:00Z'))).toBe('earlyBird');
    // … and 08:00 in summer (not early).
    expect(kind(input('2026-07-14T06:00:00Z', '2026-07-14T06:01:00Z'))).toBeNull();
    // The morning after the spring change: 05:20 UTC = 07:20 CEST.
    expect(kind(input('2026-03-30T05:20:00Z', '2026-03-30T05:21:00Z'))).toBe('earlyBird');
    expect(kind(input('2026-03-30T05:20:00Z', '2026-03-30T05:21:00Z', { timeZone: 'America/New_York' }))).toBe('lateWork');
    // German default is 07:00.
    expect(kind(input('2026-01-13T06:15:00Z', '2026-01-13T06:16:00Z', { windows: CATALOG.de.windows }))).toBeNull();
    // A timer started yesterday is no early start today.
    expect(kind(input('2026-01-12T22:00:00Z', '2026-01-13T06:01:00Z', { switches: { fun: true, wellbeing: false } }))).toBe('cheer');
  });

  it('coffee and lunch use the locale windows (Spanish lunch at 14:00)', () => {
    const start = '2026-11-03T09:00:00+01:00';
    expect(planMessage(input(start, '2026-11-03T10:15:00+01:00'))).toEqual({ kind: 'coffee', slot: 'coffeeAm:2026-11-03' });
    expect(planMessage(input(start, '2026-11-03T15:30:00+01:00', { windows: CATALOG.en.windows, state: { ...EMPTY_MESSAGES, seen: ['cheer:T-1@x:3'] } }))).toEqual({ kind: 'coffee', slot: 'coffeePm:2026-11-03' });
    expect(kind(input(start, '2026-11-03T12:15:00+01:00'))).toBe('lunch');
    const care = { windows: CATALOG.es.windows, switches: { fun: false, wellbeing: true } };
    expect(kind(input('2026-11-03T11:30:00+01:00', '2026-11-03T12:15:00+01:00', care))).toBeNull();
    expect(kind(input('2026-11-03T11:30:00+01:00', '2026-11-03T14:15:00+01:00', care))).toBe('lunch');
  });

  it('late work: once per night, also after midnight', () => {
    const start = '2026-11-03T19:30:00+01:00';
    const first = planMessage(input(start, '2026-11-03T20:30:00+01:00'));
    expect(first).toEqual({ kind: 'lateWork', slot: 'lateWork:2026-11-03' });
    const seen = { ...EMPTY_MESSAGES, seen: ['lateWork:2026-11-03'] };
    expect(planMessage(input(start, '2026-11-04T00:30:00+01:00', { state: seen }))?.kind).not.toBe('lateWork');
    expect(kind(input(start, '2026-11-04T00:30:00+01:00'))).toBe('lateWork');
  });

  it('Friday afternoon from the locale time, not in the evening', () => {
    const start = '2026-11-06T13:00:00+01:00';
    expect(kind(input(start, '2026-11-06T14:30:00+01:00'))).toBeNull();
    expect(kind(input(start, '2026-11-06T14:30:00+01:00', { windows: CATALOG.de.windows }))).toBe('friday');
    expect(kind(input(start, '2026-11-06T15:30:00+01:00'))).toBe('coffee');
    expect(kind(input(start, '2026-11-06T16:30:00+01:00'))).toBe('friday');
    expect(kind(input('2026-11-05T13:00:00+01:00', '2026-11-05T14:30:00+01:00'))).toBeNull();
  });

  it('weekend: greeting at the start, a nudge to enjoy the day later; in the user time zone', () => {
    const saturday = '2026-11-07T10:00:00+01:00';
    expect(planMessage(input(saturday, '2026-11-07T10:05:00+01:00'))).toEqual({ kind: 'weekend', slot: 'weekend:2026-11-07' });
    expect(kind(input(saturday, `2026-11-07T${String(10 + Math.floor(WEEKEND_START_MINUTES / 60)).padStart(2, '0')}:05:00+01:00`))).toBeNull();
    const later = new Date(Date.parse(saturday) + (WEEKEND_REST_AFTER_MINUTES + 5) * 60_000).toISOString();
    expect(planMessage(input(saturday, later))).toEqual({ kind: 'weekendRest', slot: 'weekendRest:2026-11-07' });
    expect(kind(input(saturday, later, { switches: { fun: true, wellbeing: false } }))).toBeNull();
    // Sunday too.
    expect(kind(input('2026-11-08T11:00:00+01:00', '2026-11-08T11:01:00+01:00'))).toBe('weekend');
  });

  it('weekend boundaries: Friday → Saturday and Sunday → Monday at midnight, per time zone', () => {
    const fun = { fun: true, wellbeing: false };
    // 23:59 Friday in Madrid is not the weekend; 00:01 Saturday is.
    expect(kind(input('2026-11-06T23:58:00+01:00', '2026-11-06T23:59:00+01:00', { switches: fun }))).toBeNull();
    expect(kind(input('2026-11-07T00:00:30+01:00', '2026-11-07T00:01:00+01:00', { switches: fun }))).toBe('weekend');
    // 23:59 Sunday is; 00:01 Monday is not.
    expect(kind(input('2026-11-08T23:58:00+01:00', '2026-11-08T23:59:00+01:00', { switches: fun }))).toBe('weekend');
    expect(kind(input('2026-11-09T00:00:30+01:00', '2026-11-09T00:01:00+01:00', { switches: fun }))).toBeNull();
    // The same instant: Saturday in Madrid and Tokyo, still Friday in New York.
    const instant = '2026-11-06T23:30:00Z';
    expect(kind(input('2026-11-06T23:20:00Z', instant, { switches: fun }))).toBe('weekend');
    expect(kind(input('2026-11-06T23:20:00Z', instant, { switches: fun, timeZone: 'Asia/Tokyo' }))).toBe('weekend');
    expect(kind(input('2026-11-06T23:20:00Z', instant, { switches: fun, timeZone: 'America/New_York' }))).toBe('friday');
    // Monday 00:01 in Tokyo is still Sunday afternoon in New York.
    expect(kind(input('2026-11-08T14:55:00Z', '2026-11-08T15:01:00Z', { switches: fun, timeZone: 'Asia/Tokyo' }))).toBeNull();
    expect(kind(input('2026-11-08T14:55:00Z', '2026-11-08T15:01:00Z', { switches: fun, timeZone: 'America/New_York' }))).toBe('weekend');
  });

  it(`global rate limit: one card every ${MIN_GAP_MINUTES} min at most`, () => {
    const start = '2026-11-03T09:00:00+01:00';
    const recent = { ...EMPTY_MESSAGES, lastShownAt: new Date('2026-11-03T09:40:00+01:00').toISOString() };
    expect(kind(input(start, '2026-11-03T10:15:00+01:00', { state: recent }))).toBeNull();
    expect(kind(input(start, '2026-11-03T10:31:00+01:00', { state: recent }))).toBe('coffee');
  });

  it('both switches off: nothing', () => {
    expect(planMessage(input('2026-11-07T10:00:00+01:00', '2026-11-07T10:05:00+01:00', { switches: { fun: false, wellbeing: false } }))).toBeNull();
  });
});

describe('cards', () => {
  const base = { startedAt: '2026-11-03T09:00:00+01:00', entry: 'T-1@x', switches: ON, windows: CATALOG.en.windows, timeZone: MADRID, locale: 'en' as const, rng: () => 0 };

  it('nextCard picks a line, records the slot, the history and the time', () => {
    const now = new Date('2026-11-03T10:15:00+01:00');
    const next = nextCard({ ...base, now, state: EMPTY_MESSAGES });
    expect(next?.card).toEqual({ kind: 'coffee', line: 0, locale: 'en', entry: 'T-1@x', shownAt: now.toISOString(), dismissed: false });
    expect(next?.state).toMatchObject({ seen: ['coffeeAm:2026-11-03'], lastShownAt: now.toISOString(), recent: { coffee: [0] } });
    // Once per window per day, even after the rate limit.
    const again = nextCard({ ...base, now: new Date('2026-11-03T10:59:00+01:00'), state: { ...(next?.state as MessageState), lastShownAt: null } });
    expect(again).toBeNull();
  });

  it('a cheer with only wellbeing on picks a wellbeing line; nothing allowed marks the slot used', () => {
    const now = new Date('2026-11-03T11:30:00+01:00');
    const care = nextCard({ ...base, now, switches: { fun: false, wellbeing: true }, state: EMPTY_MESSAGES });
    expect(care?.card.kind).toBe('cheer');
    expect(CATALOG.en.pools.cheer[care?.card.line as number]?.wellbeing).toBe(true);
    // Fun on: 2 h is a milestone (medal, pom-poms).
    const fun = nextCard({ ...base, now, switches: { fun: true, wellbeing: false }, state: EMPTY_MESSAGES });
    expect(fun?.card.kind).toBe('milestone');
  });

  it('visible for its entry until dismissed, expired or switched off', () => {
    const shownAt = '2026-11-03T10:15:00.000Z';
    const card = { kind: 'coffee' as const, line: 0, locale: 'en' as const, entry: 'T-1@x', shownAt, dismissed: false };
    const state = { ...EMPTY_MESSAGES, card };
    const at = (minutes: number) => new Date(Date.parse(shownAt) + minutes * 60_000);
    expect(visibleCard(state, 'T-1@x', at(1), ON)).toBe(card);
    expect(visibleCard(state, 'T-2@y', at(1), ON)).toBeNull();
    expect(visibleCard(state, null, at(1), ON)).toBeNull();
    expect(visibleCard(state, 'T-1@x', at(CARD_TTL_MINUTES), ON)).toBeNull();
    expect(visibleCard({ ...state, card: { ...card, dismissed: true } }, 'T-1@x', at(1), ON)).toBeNull();
    expect(visibleCard(state, 'T-1@x', at(1), { fun: true, wellbeing: false })).toBeNull();
    expect(visibleCard({ ...state, card: { ...card, line: 999 } }, 'T-1@x', at(1), ON)).toBeNull();
    expect(visibleCard(EMPTY_MESSAGES, 'T-1@x', at(1), ON)).toBeNull();
  });

  it('stored state is sanitised', () => {
    expect(sanitizeMessages(null)).toEqual(EMPTY_MESSAGES);
    expect(sanitizeMessages('x')).toEqual(EMPTY_MESSAGES);
    const card = { kind: 'lunch', line: 2, locale: 'es', entry: 'e', shownAt: '2026-11-03T10:00:00Z' };
    expect(
      sanitizeMessages({ recent: { idle: [1, -1, 'x', 2.5, 3], bogus: [1], lunch: 'no' }, idleLine: 4, card, lastShownAt: 'nope', seen: ['a', 3] }),
    ).toEqual({ recent: { idle: [1, 3] }, idleLine: 4, card: { ...card, dismissed: false }, lastShownAt: null, seen: ['a'], afterMeeting: null });
    expect(sanitizeMessages({ afterMeeting: '2026-11-03T10:00:00Z' }).afterMeeting).toBe('2026-11-03T10:00:00Z');
    expect(sanitizeMessages({ afterMeeting: 'soon', card: { ...card, kind: 'dailyDone' } })).toMatchObject({ afterMeeting: null, card: null });
    expect(sanitizeMessages({ card: { ...card, kind: 'idle' }, idleLine: -2, recent: null }).card).toBeNull();
    expect(sanitizeMessages({ card: { ...card, locale: 'ja' } }).card).toBeNull();
    expect(sanitizeMessages({ card: { ...card, shownAt: 'never' }, lastShownAt: '2026-11-03T10:00:00Z' })).toMatchObject({ card: null, lastShownAt: '2026-11-03T10:00:00Z', idleLine: null });
  });
});

describe('stretch thresholds', () => {
  it(`milestones at ${MILESTONE_HOURS.join(' h and ')} h, "take a real break" from ${OVERTIME_FROM_HOURS} h`, () => {
    expect([1, 2, 3, 4].map(stepHours)).toEqual([2, 4, 6, 8]);
    expect([1, 2, 3, 4].map((step) => stretchKind(step, ON))).toEqual(['milestone', 'milestone', 'overtime', 'overtime']);
    expect([1, 2, 3].map((step) => stretchKind(step, { fun: true, wellbeing: false }))).toEqual(['milestone', 'milestone', 'cheer']);
    expect([1, 3].map((step) => stretchKind(step, { fun: false, wellbeing: true }))).toEqual(['cheer', 'overtime']);
  });

  it('no line hard-codes an hour count; {hours} only where the real elapsed time is filled in', () => {
    const hourWords = /\d+\s*(h|hrs?|hours?|horas?|stunden?|heures?|ore|uur)\b/i;
    for (const locale of MESSAGE_LOCALES) {
      for (const name of POOL_KINDS) {
        for (const line of CATALOG[locale].pools[name]) {
          expect(line.text, `${locale}.${name}`).not.toMatch(hourWords);
          if (line.text.includes('{hours}')) expect(['cheer', 'milestone', 'overtime'], `${locale}.${name}`).toContain(name);
        }
      }
    }
    // Overtime shows the real hours (6 or more), never a smaller milestone number.
    expect(lineText('es', 'overtime', 0, { hours: 7 })?.text).toContain('7 horas');
  });
});

describe('task kind (meetings, dailies)', () => {
  it('reads the name with the locale table and English, without accents, as whole words', () => {
    expect(taskKind({ title: 'Daily stand-up' }, 'en')).toBe('daily');
    expect(taskKind({ taskTitle: 'Reunion con cliente' }, 'es')).toBe('meeting');
    expect(taskKind({ title: 'Reunión técnica' }, 'es')).toBe('meeting');
    expect(taskKind({ title: 'Sprint planning' }, 'es')).toBe('technical');
    expect(taskKind({ title: 'Formación Symfony' }, 'es')).toBe('training');
    expect(taskKind({ title: '1:1 with Ana' }, 'en')).toBe('meeting');
    expect(taskKind({ title: 'Besprechung Vertrieb' }, 'de')).toBe('meeting');
    expect(taskKind({ title: 'Point quotidien' }, 'fr')).toBe('daily');
    expect(taskKind({ title: 'Riunione settimanale' }, 'it')).toBe('meeting');
    expect(taskKind({ title: 'Overleg team' }, 'nl')).toBe('meeting');
    expect(taskKind({ title: 'Reunião de equipa' }, 'pt')).toBe('meeting');
    // Whole words only: "recall", "reviewer" or "dailymotion" are no meetings.
    expect(taskKind({ title: 'Fix recall bug' }, 'en')).toBeNull();
    // A code review is work, not a meeting; a sprint review is a meeting.
    expect(taskKind({ title: 'Review pull request queue' }, 'en')).toBeNull();
    expect(taskKind({ title: 'Sprint review' }, 'en')).toBe('technical');
    expect(taskKind({ title: 'Dailymotion embed' }, 'en')).toBeNull();
    expect(taskKind({ title: 'Write onboarding guide' }, 'en')).toBeNull();
    expect(taskKind({ title: '   ' }, 'en')).toBeNull();
  });

  it('falls back to English words in another locale, but not to other languages', () => {
    expect(taskKind({ title: 'Weekly meeting' }, 'es')).toBe('meeting');
    expect(taskKind({ title: 'Besprechung' }, 'es')).toBeNull();
    expect(taskKind({ title: 'Reunión' }, 'en')).toBeNull();
  });

  it("prefers Beacon's own type, labels or tags over the name", () => {
    expect(taskKind({ title: 'Daily stand-up', type: 'training' }, 'en')).toBe('training');
    expect(taskKind({ title: 'Acme', labels: ['Billing', 'Meeting'] }, 'en')).toBe('meeting');
    expect(taskKind({ title: 'Acme', tags: [{ name: 'retro' }, 3] }, 'en')).toBe('technical');
    expect(taskKind({ title: 'Acme', kind: 'daily' }, 'es')).toBe('daily');
    expect(taskKind({ title: 'Acme', labels: 'urgent' }, 'en')).toBeNull();
    expect(taskKind(null, 'en')).toBeNull();
  });

  it('a long meeting earns the next card a coffee / stretch line; short ones or plain tasks do not', () => {
    const start = '2026-11-03T09:00:00Z';
    expect(afterStop(EMPTY_MESSAGES, 'meeting', start, new Date('2026-11-03T09:30:00Z'))).toBe(EMPTY_MESSAGES);
    expect(afterStop(EMPTY_MESSAGES, null, start, new Date('2026-11-03T11:00:00Z'))).toBe(EMPTY_MESSAGES);
    const after = afterStop(EMPTY_MESSAGES, 'technical', start, new Date(Date.parse(start) + MEETING_LONG_MINUTES * 60_000));
    expect(after.afterMeeting).toBe(new Date(Date.parse(start) + MEETING_LONG_MINUTES * 60_000).toISOString());
    const plan = input('2026-11-03T14:00:00+01:00', '2026-11-03T14:05:00+01:00', { state: after });
    expect(planMessage(plan)?.kind).toBe('meetingAfter');
    const next = nextCard({ ...plan, locale: 'es', rng: () => 0 });
    expect(next?.card.kind).toBe('meetingAfter');
    expect(next?.state.afterMeeting).toBeNull();
    expect(planMessage({ ...plan, switches: { fun: true, wellbeing: false } })).toBeNull();
  });

  it('meeting idle phrasing and "daily done" lines, without repeats; none with Fun messages off', () => {
    const meeting = pickIdleLine(EMPTY_MESSAGES, 'fr', () => 0, ON, true);
    expect(meeting.recent.meetingIdle).toEqual([0]);
    expect(lineText('fr', 'meetingIdle', meeting.idleLine as number)?.text).toContain('réunion');
    const first = pickDailyDone(EMPTY_MESSAGES, 'es', () => 0, ON);
    expect(first?.line.text).toBe(CATALOG.es.pools.dailyDone[0]?.text);
    const second = pickDailyDone(first?.state as MessageState, 'es', () => 0, ON);
    expect(second?.line.text).toBe(CATALOG.es.pools.dailyDone[1]?.text);
    expect(pickDailyDone(EMPTY_MESSAGES, 'es', () => 0, { fun: false, wellbeing: true })).toBeNull();
  });
});
