import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { control, reset, signIn } from './helpers';

/**
 * Working-hours reminders for review (`pnpm screenshots:schedule`, `SCHEDULE_SCREENS=<dir>`), Spanish, light and dark:
 * Settings → Mi horario (Beacon's week with local changes and days off), the four reminders as Windows 11 toasts with
 * their button (start, lunch, end of the day, holiday) and one as the in-app toast. Texts, poses and buttons are the
 * real ones, produced by the running app on a fixed clock (Thursday 5 November 2026, Madrid); the OS chrome is drawn.
 */
const DIR = process.env.SCHEDULE_SCREENS ?? '';
test.skip(DIR === '', 'set SCHEDULE_SCREENS=<dir> to write the schedule screenshots');
test.use({ locale: 'es-ES', timezoneId: 'Europe/Madrid' });
test.beforeEach(reset);

const HOURS = {
  timezone: 'Europe/Madrid',
  slots: [1, 2, 3, 4, 5].flatMap((day) => [
    { day, from: '09:00', to: '14:00' },
    { day, from: '15:00', to: '18:00' },
  ]),
};
const DAYS_OFF = [
  { date: '2026-11-06', kind: 'vacation', label: 'Puente' },
  { date: '2026-12-08', kind: 'holiday', label: 'Inmaculada Concepción' },
  { date: '2026-12-25', kind: 'holiday', label: 'Navidad' },
];

interface Note {
  title: string;
  body: string;
  pose: string;
  action: { id: string; label: string } | null;
}
type App = {
  state: Record<string, unknown>;
  render(): void;
  show(view: string): void;
  showSettings(tab: string): void;
  setScheduleField(day: number, name: string, value: unknown): void;
  setLocalDayOff(date: string, on: boolean): void;
  showReminderToast(note: unknown): void;
  reminderToast: unknown;
};
type Tt = { __timeTrack: { app: App; hooks: { notificationPermission: string; friendly: Note[]; wake(reason?: string): void } } };

const png = (path: string) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
const APP_ICON = png('src-tauri/icons/128x128.png');
const pose = (id: string) => png(`src-tauri/notification-art/pose-${id}.png`);
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FONT = `'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,'Cantarell','Ubuntu',sans-serif`;
const WALL = {
  light: 'radial-gradient(120% 90% at 70% 110%, #7fb3e6 0%, #b9d6f2 40%, #e9f1fa 75%)',
  dark: 'radial-gradient(120% 90% at 70% 110%, #1d3b66 0%, #12223b 45%, #0a111d 80%)',
};

const madrid = (iso: string) => new Date(iso);

async function wake(page: Page, at: string): Promise<void> {
  await page.clock.setFixedTime(madrid(at));
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.wake('tick'));
}

async function nextNote(page: Page, count: number): Promise<Note> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly.length)).toBe(count);
  return page.evaluate((index) => (window as unknown as Tt).__timeTrack.hooks.friendly[index] as Note, count - 1);
}

/** The four reminders as the app sends them to the OS (Spanish). */
async function capture(page: Page): Promise<Record<'start' | 'lunch' | 'end' | 'holiday', Note>> {
  await page.evaluate(() => {
    const { app, hooks } = (window as unknown as Tt).__timeTrack;
    hooks.notificationPermission = 'granted';
    app.state = { ...app.state, activeTimer: null, lastTask: { id: 'T-101', title: 'Escribir la guía de bienvenida' } };
    app.render();
  });
  await wake(page, '2026-11-05T09:00:20+01:00');
  const start = await nextNote(page, 1);
  const run = (startedAt: string) =>
    page.evaluate((iso) => {
      const { app } = (window as unknown as Tt).__timeTrack;
      app.state = { ...app.state, activeTimer: { id: 'E-1', taskId: 'T-101', taskTitle: 'Escribir la guía de bienvenida', startedAt: iso } };
      app.render();
    }, startedAt);
  await run('2026-11-05T09:00:00+01:00');
  await wake(page, '2026-11-05T14:00:10+01:00');
  const lunch = await nextNote(page, 2);
  await run('2026-11-05T15:05:00+01:00');
  await wake(page, '2026-11-05T18:00:10+01:00');
  const end = await nextNote(page, 3);
  await run('2026-11-06T10:00:00+01:00');
  await wake(page, '2026-11-06T10:15:00+01:00');
  const holiday = await nextNote(page, 4);
  return { start, lunch, end, holiday };
}

/** Windows 11 toast with the pose (app logo), title, line and the button row. */
function toast(scheme: 'light' | 'dark', note: Note): string {
  const dark = scheme === 'dark';
  const button = (label: string, primary: boolean) =>
    `<span style="flex:1;text-align:center;padding:6px 0;border-radius:4px;font-size:13px;${primary ? `background:${dark ? '#4cc2ff' : '#005fb8'};color:${dark ? '#000' : '#fff'}` : `background:${dark ? '#3a3a3a' : '#f0f0f0'};border:1px solid ${dark ? '#4a4a4a' : '#dcdcdc'}`}">${esc(label)}</span>`;
  const buttons = note.action !== null ? `<div style="display:flex;gap:8px;margin-top:12px">${button(note.action.label, true)}</div>` : '';
  return `<div style="position:absolute;right:12px;bottom:60px;width:364px;background:${dark ? '#2b2b2b' : '#fbfbfb'};color:${dark ? '#fff' : '#1b1b1b'};border:1px solid ${dark ? '#404040' : '#e5e5e5'};border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.28);font:14px ${FONT};padding:12px 14px 14px">
    <div style="display:flex;align-items:center;gap:8px;font-size:12px;opacity:.85"><img src="${APP_ICON}" style="width:16px;height:16px">TimeTrack<span style="margin-left:auto;letter-spacing:2px">···&nbsp;&nbsp;✕</span></div>
    <div style="display:flex;gap:12px;margin-top:12px;align-items:flex-start">
      <img src="${pose(note.pose)}" style="width:48px;height:48px;flex:none">
      <div><div style="font-weight:600">${esc(note.title)}</div><div style="opacity:.85;margin-top:2px;line-height:1.35">${esc(note.body)}</div></div>
    </div>${buttons}</div>`;
}

function taskbar(scheme: 'light' | 'dark', clock: string, date: string): string {
  const dark = scheme === 'dark';
  const ink = dark ? '#fff' : '#1b1b1b';
  return `<div style="position:absolute;left:0;right:0;bottom:0;height:48px;background:${dark ? 'rgba(32,32,32,.92)' : 'rgba(243,243,243,.92)'};border-top:1px solid ${dark ? '#3a3a3a' : '#dcdcdc'};display:flex;align-items:center;justify-content:center;color:${ink};font:12px ${FONT}">
    <div style="display:flex;gap:6px">${['#0078d4', '#ffb900', '#107c10', '#5c2d91'].map((c) => `<span style="width:32px;height:32px;border-radius:6px;background:${c};opacity:.85"></span>`).join('')}</div>
    <div style="position:absolute;right:12px;display:flex;align-items:center;gap:10px"><span style="font-size:11px">^</span><img src="${APP_ICON}" style="width:18px;height:18px"><span style="text-align:right;line-height:1.2">${clock}<br>${date}</span></div></div>`;
}

async function shoot(browser: Browser, scheme: 'light' | 'dark', name: string, html: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1000, height: 420 }, colorScheme: scheme, reducedMotion: 'reduce', locale: 'es-ES' });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0;height:100vh;overflow:hidden;position:relative;background:${WALL[scheme]};font-family:${FONT}">${html}</body></html>`, { waitUntil: 'load' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${DIR}/${name}-${scheme}.png` });
  await context.close();
}

async function setup(page: Page): Promise<void> {
  // The fixed clock jumps hours between the moments: without the "Still there?" check they are not taken for sleeps.
  await control('config', { workingHours: HOURS, daysOff: DAYS_OFF, locale: 'es', idleCheck: { enabled: false, threshold_minutes: 10, answer_timeout_minutes: 5 } });
  await page.clock.setFixedTime(madrid('2026-11-05T08:30:00+01:00'));
  await signIn(page);
}

test('reminder notifications', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await setup(page);
  const notes = await capture(page);
  const clocks = { start: ['9:00', '05/11/2026'], lunch: ['14:00', '05/11/2026'], end: ['18:00', '05/11/2026'], holiday: ['10:15', '06/11/2026'] } as const;
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, note] of Object.entries(notes) as [keyof typeof notes, Note][]) {
      await shoot(browser, scheme, `reminder-${name}`, toast(scheme, note) + taskbar(scheme, clocks[name][0], clocks[name][1]));
    }
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`settings and in-app toast (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 400, height: 1400 });
    await setup(page);
    // Local changes on this computer: an earlier Thursday start, no lunch on Fridays, a local day off.
    await page.evaluate(() => {
      const { app } = (window as unknown as Tt).__timeTrack;
      app.setScheduleField(4, 'start', '08:30');
      app.setScheduleField(5, 'lunchStart', null);
      app.setLocalDayOff('2026-11-20', true);
      app.showSettings('schedule');
    });
    await page.locator('#day-4 summary').click();
    const section = page.locator('#schedule-settings');
    await section.scrollIntoViewIfNeeded();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await section.screenshot({ path: `${DIR}/settings-schedule-${scheme}.png`, animations: 'disabled', caret: 'hide' });
    // The in-app toast (desktop notifications off): lunch with its Stop button.
    await page.setViewportSize({ width: 400, height: 640 });
    await page.evaluate(() => {
      const { app } = (window as unknown as Tt).__timeTrack;
      app.state = { ...app.state, settings: { ...(app.state.settings as object), desktopNotifications: false }, activeTimer: { id: 'E-1', taskId: 'T-101', taskTitle: 'Write onboarding guide', startedAt: '2026-11-05T09:00:00+01:00' } };
      app.show('main');
    });
    await wake(page, '2026-11-05T14:00:10+01:00');
    await expect(page.locator('#reminder-action')).toBeVisible();
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: `${DIR}/reminder-in-app-${scheme}.png`, animations: 'disabled', caret: 'hide' });
  });
}
