import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { control, reset, signIn } from './helpers';

/**
 * Meeting detection for review (`pnpm screenshots:meetings`, `MEETING_SCREENS=<dir>`), Spanish, light and dark: the
 * question in the window (with its task picker), the end-of-meeting question, both as Windows 11 notifications, and
 * Settings → Reuniones. The microphone reports come from the browser platform's fake heartbeat (`hooks.mic`); texts,
 * poses and buttons are the real ones produced by the running app on a fixed clock (Thursday 5 November 2026, Madrid);
 * the OS chrome is drawn.
 */
const DIR = process.env.MEETING_SCREENS ?? '';
test.skip(DIR === '', 'set MEETING_SCREENS=<dir> to write the meeting screenshots');
test.use({ locale: 'es-ES', timezoneId: 'Europe/Madrid' });
test.beforeEach(reset);

const HOURS = {
  timezone: 'Europe/Madrid',
  slots: [1, 2, 3, 4, 5].flatMap((day) => [
    { day, from: '09:00', to: '14:00' },
    { day, from: '15:00', to: '18:00' },
  ]),
};
const T0 = Date.parse('2026-11-05T10:00:00+01:00');
const MIN = 60_000;
const DOCS = { id: 'T-101', title: 'Escribir la guía de bienvenida' };

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
  setFeature(feature: string, on: boolean): Promise<void>;
  setMeetingSetting(patch: Record<string, unknown>): void;
  meetingAction(action: string): Promise<void>;
};
type Tt = { __timeTrack: { app: App; hooks: { notificationPermission: string; friendly: Note[]; mic(signal: unknown): void } } };

const png = (path: string) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
const APP_ICON = png('src-tauri/icons/128x128.png');
const pose = (id: string) => png(`src-tauri/notification-art/pose-${id}.png`);
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FONT = `'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,'Cantarell','Ubuntu',sans-serif`;
const WALL = {
  light: 'radial-gradient(120% 90% at 70% 110%, #7fb3e6 0%, #b9d6f2 40%, #e9f1fa 75%)',
  dark: 'radial-gradient(120% 90% at 70% 110%, #1d3b66 0%, #12223b 45%, #0a111d 80%)',
};

/** Microphone reports every 20 s from `from` to `to` minutes after 10:00 (the page clock follows). */
async function call(page: Page, from: number, to: number, apps: string[]): Promise<void> {
  for (let at = from * MIN; at <= to * MIN; at += 20_000) {
    await page.clock.setFixedTime(new Date(T0 + at));
    await page.evaluate(([now, list]) => (window as unknown as Tt).__timeTrack.hooks.mic({ at: now, inUse: list.length > 0, apps: list, source: 'process' }), [T0 + at, apps] as [number, string[]]);
  }
}

async function setup(page: Page, native: boolean): Promise<void> {
  await control('config', { workingHours: HOURS, locale: 'es', idleCheck: { enabled: false, threshold_minutes: 10, answer_timeout_minutes: 5 } });
  await page.clock.setFixedTime(new Date(T0 - 5 * MIN));
  await signIn(page);
  await page.evaluate(async (granted) => {
    const { app, hooks } = (window as unknown as Tt).__timeTrack;
    hooks.notificationPermission = granted ? 'granted' : 'unsupported';
    // In-app shots: desktop notifications off, so the question stays in the window only.
    if (!granted) app.state = { ...app.state, settings: { ...(app.state.settings as object), desktopNotifications: false } };
    await app.setFeature('meetingDetection', true);
  }, native);
}

/** A timer on a non-meeting task, started at 09:15. */
async function runningDocs(page: Page): Promise<void> {
  await page.evaluate((task) => {
    const { app } = (window as unknown as Tt).__timeTrack;
    app.state = { ...app.state, activeTimer: { id: 'E-1', taskId: task.id, taskTitle: task.title, startedAt: '2026-11-05T09:15:00+01:00' } };
    app.render();
  }, DOCS);
}

async function windowShot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: `${DIR}/${name}.png`, animations: 'disabled', caret: 'hide' });
}

/** Windows 11 toast with the pose (app logo), title, line and the button. */
function toast(scheme: 'light' | 'dark', note: Note): string {
  const dark = scheme === 'dark';
  const button = (label: string) =>
    `<span style="flex:1;text-align:center;padding:6px 0;border-radius:4px;font-size:13px;background:${dark ? '#4cc2ff' : '#005fb8'};color:${dark ? '#000' : '#fff'}">${esc(label)}</span>`;
  const buttons = note.action !== null ? `<div style="display:flex;gap:8px;margin-top:12px">${button(note.action.label)}</div>` : '';
  return `<div style="position:absolute;right:12px;bottom:60px;width:364px;background:${dark ? '#2b2b2b' : '#fbfbfb'};color:${dark ? '#fff' : '#1b1b1b'};border:1px solid ${dark ? '#404040' : '#e5e5e5'};border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.28);font:14px ${FONT};padding:12px 14px 14px">
    <div style="display:flex;align-items:center;gap:8px;font-size:12px;opacity:.85"><img src="${APP_ICON}" style="width:16px;height:16px">TimeTrack<span style="margin-left:auto;letter-spacing:2px">···&nbsp;&nbsp;✕</span></div>
    <div style="display:flex;gap:12px;margin-top:12px;align-items:flex-start">
      <img src="${pose(note.pose)}" style="width:48px;height:48px;flex:none">
      <div><div style="font-weight:600">${esc(note.title)}</div><div style="opacity:.85;margin-top:2px;line-height:1.35">${esc(note.body)}</div></div>
    </div>${buttons}</div>`;
}

function taskbar(scheme: 'light' | 'dark', clock: string): string {
  const dark = scheme === 'dark';
  return `<div style="position:absolute;left:0;right:0;bottom:0;height:48px;background:${dark ? 'rgba(32,32,32,.92)' : 'rgba(243,243,243,.92)'};border-top:1px solid ${dark ? '#3a3a3a' : '#dcdcdc'};display:flex;align-items:center;justify-content:center;color:${dark ? '#fff' : '#1b1b1b'};font:12px ${FONT}">
    <div style="display:flex;gap:6px">${['#0078d4', '#ffb900', '#107c10', '#5c2d91'].map((c) => `<span style="width:32px;height:32px;border-radius:6px;background:${c};opacity:.85"></span>`).join('')}</div>
    <div style="position:absolute;right:12px;display:flex;align-items:center;gap:10px"><span style="font-size:11px">^</span><img src="${APP_ICON}" style="width:18px;height:18px"><span style="text-align:right;line-height:1.2">${clock}<br>05/11/2026</span></div></div>`;
}

async function shoot(browser: Browser, scheme: 'light' | 'dark', name: string, html: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1000, height: 420 }, colorScheme: scheme, reducedMotion: 'reduce', locale: 'es-ES' });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0;height:100vh;overflow:hidden;position:relative;background:${WALL[scheme]};font-family:${FONT}">${html}</body></html>`, { waitUntil: 'load' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${DIR}/${name}-${scheme}.png` });
  await context.close();
}

const lastNote = (page: Page) => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly.at(-1) as Note);

test('meeting notifications', async ({ page, browser }) => {
  await setup(page, true);
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.setMeetingSetting({ meetingGeneric: { id: 'T-103', title: 'Customer call: quarterly review' } }));
  await runningDocs(page);
  await call(page, 0, 2, ['teams']);
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly.length)).toBe(1);
  const ask = await lastNote(page);
  expect(ask.action?.id).toBe('meeting-switch');
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.meetingAction('switch'));
  await call(page, 2.5, 34, ['teams']);
  await call(page, 34 + 1 / 3, 35.5, []);
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly.length)).toBe(2);
  const ended = await lastNote(page);
  expect(ended.body).toBe('Reunión terminada (34 min). ¿Volver a Escribir la guía de bienvenida?');
  for (const scheme of ['light', 'dark'] as const) {
    await shoot(browser, scheme, 'meeting-notification', toast(scheme, ask) + taskbar(scheme, '10:02'));
    await shoot(browser, scheme, 'meeting-ended-notification', toast(scheme, ended) + taskbar(scheme, '10:35'));
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`in-app question, task picker and end question (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await setup(page, false);
    await call(page, 0, 2, ['teams']);
    await expect(page.locator('#meeting-text')).toHaveText('Parece que estás en una reunión (Teams). ¿Qué reunión es?');
    await windowShot(page, `meeting-prompt-${scheme}`);
    await page.locator('#meeting-choose').click();
    await expect(page.locator('#meeting-tasks li').first()).toContainText('Customer call');
    await windowShot(page, `meeting-picker-${scheme}`);
    await page.locator('#meeting-picker-cancel').click();
    // With a task running: "switch", then the end of the call offers to go back.
    await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.setMeetingSetting({ meetingGeneric: { id: 'T-103', title: 'Customer call: quarterly review' } }));
    await runningDocs(page);
    await expect(page.locator('#meeting-switch')).toHaveText('Cambiar a la reunión');
    await windowShot(page, `meeting-prompt-switch-${scheme}`);
    await page.locator('#meeting-switch').click();
    await expect(page.locator('#timer-task')).toHaveText('Customer call: quarterly review');
    await call(page, 2.5, 34, ['teams']);
    await call(page, 34 + 1 / 3, 35.5, []);
    await expect(page.locator('#meeting-text')).toHaveText('Reunión terminada (34 min). ¿Volver a Escribir la guía de bienvenida?');
    await windowShot(page, `meeting-ended-${scheme}`);
  });

  test(`settings: meetings (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 400, height: 1400 });
    await setup(page, false);
    await page.evaluate(() => {
      const { app } = (window as unknown as Tt).__timeTrack;
      app.setMeetingSetting({ meetingGeneric: { id: 'T-103', title: 'Customer call: quarterly review' }, meetingMuted: ['slack'] });
      app.showSettings('meetings');
    });
    await call(page, 0, 0, ['teams']);
    const section = page.locator('#meeting-settings');
    await expect(page.locator('#meeting-status')).toHaveText('Ahora: el micrófono está en uso (Teams).');
    await section.scrollIntoViewIfNeeded();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await section.screenshot({ path: `${DIR}/settings-meetings-${scheme}.png`, animations: 'disabled', caret: 'hide' });
  });
}
