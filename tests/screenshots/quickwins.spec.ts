import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { control, reset, signIn } from './helpers';

/**
 * Review screenshots of the desktop quick wins (`pnpm screenshots:quickwins`, `QUICKWIN_SCREENS=<dir>`), Spanish, light
 * and dark: the three-choice "Still there?" prompt and its task picker (the real prompt window page in a Windows 11
 * frame), the tray's elapsed time (macOS menu bar, Windows tooltip), the "Working without a timer?" notification
 * (Windows toast and GNOME, with its two buttons) and its in-app toast, and the Settings additions. Texts, poses and
 * views are the real ones from the running app with the browser platform's fake OS; only the OS chrome is drawn here.
 */
const DIR = process.env.QUICKWIN_SCREENS ?? '';
test.skip(DIR === '', 'set QUICKWIN_SCREENS=<dir> to write the quick-win screenshots');
test.use({ locale: 'es-ES', timezoneId: 'Europe/Madrid' });
test.beforeEach(async () => {
  await reset();
  // Working hours all week, so "Working without a timer?" may come whatever the day the screenshots are taken.
  await control('config', { workingHours: { timezone: 'Europe/Madrid', slots: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, from: '00:00', to: '23:59' })) } });
});

type View = Record<string, unknown>;
interface Note {
  title: string;
  body: string;
  pose: string;
  actions?: { id: string; label: string }[];
}
interface Hooks {
  nativePrompt: boolean;
  notificationPermission: string;
  idleSeconds: number;
  friendly: Note[];
  prompt: View | null;
  tray: { title: string | null; tooltip: string; status: string };
  wake(reason?: string): void;
  answerPrompt(answer: { action: string; query?: string }): void;
}
type App = {
  state: Record<string, unknown> & { activeTimer: { taskId: string; taskTitle: string; startedAt: string } | null };
  render(): void;
  refresh(): Promise<void>;
  updateTray(): Promise<void>;
  tick(): Promise<void>;
  stop(): Promise<void>;
};
type Tt = { __timeTrack: { app: App; hooks: Hooks } };

const png = (path: string) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
const APP_ICON = png('src-tauri/icons/128x128.png');
const pose = (id: string) => png(`src-tauri/notification-art/pose-${id}.png`);
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FONT = `'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,'Cantarell','Ubuntu',sans-serif`;
const WALL = {
  light: 'radial-gradient(120% 90% at 70% 110%, #7fb3e6 0%, #b9d6f2 40%, #e9f1fa 75%)',
  dark: 'radial-gradient(120% 90% at 70% 110%, #1d3b66 0%, #12223b 45%, #0a111d 80%)',
};

interface Captured {
  three: View;
  picker: View;
  tray: Hooks['tray'];
  nudge: Note;
}

async function capture(page: Page): Promise<Captured> {
  await signIn(page);
  await page.evaluate(() => {
    const hooks = (window as unknown as Tt).__timeTrack.hooks;
    hooks.nativePrompt = true;
    hooks.notificationPermission = 'granted';
  });
  await page.locator('[data-task="T-101"] .row-action').click();
  await expect(page.locator('#timer .elapsed')).toBeVisible();
  await control('timer/backdate', { seconds: 65 * 60 });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.updateTray());
  const tray = await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.tray);
  // "Still there?" about the last 11 minutes, answered "back": the three choices.
  const three = await page.evaluate(() => {
    const { app, hooks } = (window as unknown as Tt).__timeTrack;
    const timer = app.state.activeTimer!;
    const now = Date.now();
    app.state = { ...app.state, idleCheck: { phase: 'asking', taskId: timer.taskId, taskTitle: timer.taskTitle, from: new Date(now - 11 * 60_000).toISOString(), askedAt: new Date(now - 60_000).toISOString(), returnedAt: new Date(now - 5_000).toISOString(), timerStartedAt: timer.startedAt } };
    app.render();
    return hooks.prompt as View;
  });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.answerPrompt({ action: 'reassign-open' }));
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.answerPrompt({ action: 'reassign-search', query: 'review' }));
  await expect.poll(() => page.evaluate(() => JSON.stringify((window as unknown as Tt).__timeTrack.hooks.prompt))).toContain('tareas encontradas');
  const picker = await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.prompt as View);
  // "Working without a timer?": the timer stopped, typing for 11 minutes.
  await page.evaluate(async () => {
    const { app, hooks } = (window as unknown as Tt).__timeTrack;
    app.state = { ...app.state, idleCheck: { phase: 'watching' } };
    await app.stop();
    hooks.idleSeconds = 3;
    app.state = { ...app.state, messages: { ...(app.state.messages as object), lastShownAt: null }, nudge: { activeSince: new Date(Date.now() - 11 * 60_000).toISOString(), measured: true, lastAt: null, recent: [] } };
    await app.tick();
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly.length)).toBeGreaterThan(0);
  const nudge = await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly.at(-1) as Note);
  expect(nudge.actions?.length).toBe(2);
  return { three, picker, tray, nudge };
}

async function shoot(browser: Browser, scheme: 'light' | 'dark', name: string, size: { width: number; height: number }, html: string, prompt?: View) {
  const context = await browser.newContext({ viewport: size, colorScheme: scheme, reducedMotion: 'reduce', locale: 'es-ES', timezoneId: 'Europe/Madrid' });
  const page = await context.newPage();
  if (prompt !== undefined) {
    await page.addInitScript((view) => {
      (window as unknown as { __timeTrackPrompt: unknown }).__timeTrackPrompt = { view, answers: [] };
    }, { ...prompt, theme: scheme });
  }
  await page.setContent(html, { waitUntil: 'load' });
  if (prompt !== undefined) await expect(page.frameLocator('iframe').locator('.still-there')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}-${scheme}.png` });
  await context.close();
}

const desktop = (scheme: 'light' | 'dark', inner: string) =>
  `<!doctype html><html><body style="margin:0;height:100vh;overflow:hidden;position:relative;background:${WALL[scheme]};font-family:${FONT}">${inner}</body></html>`;

function taskbar(scheme: 'light' | 'dark', extra = ''): string {
  const dark = scheme === 'dark';
  const ink = dark ? '#fff' : '#1b1b1b';
  return `<div style="position:absolute;left:0;right:0;bottom:0;height:48px;background:${dark ? 'rgba(32,32,32,.92)' : 'rgba(243,243,243,.92)'};border-top:1px solid ${dark ? '#3a3a3a' : '#dcdcdc'};display:flex;align-items:center;justify-content:center;color:${ink};font:12px ${FONT}">
    <div style="display:flex;gap:6px">${['#0078d4', '#ffb900', '#107c10', '#5c2d91'].map((c) => `<span style="width:32px;height:32px;border-radius:6px;background:${c};opacity:.85"></span>`).join('')}</div>
    <div style="position:absolute;right:12px;display:flex;align-items:center;gap:10px">
      <span style="font-size:11px">^</span><span style="width:18px;height:14px;border-radius:3px;background:#1d63ed"></span>
      <span style="position:relative;display:inline-flex"><img src="${APP_ICON}" style="width:18px;height:18px">${extra}</span>
      <span style="width:16px;height:12px;border:2px solid ${ink};border-radius:2px;opacity:.7"></span>
      <span style="text-align:right;line-height:1.2">15:50<br>05/11/2026</span>
    </div></div>`;
}

function promptDesktop(scheme: 'light' | 'dark', title: string, base: string, height = 592): string {
  const dark = scheme === 'dark';
  const ink = dark ? '#fff' : '#1b1b1b';
  const behind = `<div style="position:absolute;left:80px;top:60px;width:760px;height:520px;background:${dark ? '#1f1f1f' : '#fff'};border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.2);opacity:.9;padding:20px;color:${dark ? '#999' : '#888'};font:13px ${FONT}">Editor de código — la ventana activa</div>`;
  const win = `<div style="position:absolute;left:50%;top:calc(50% - 24px);transform:translate(-50%,-50%);width:440px;height:${height}px;border-radius:8px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,.45);border:1px solid ${dark ? '#3c3c3c' : '#cfcfcf'};background:${dark ? '#202020' : '#f3f3f3'}">
    <div style="height:32px;display:flex;align-items:center;gap:8px;padding:0 0 0 12px;color:${ink};font:12px ${FONT}"><img src="${APP_ICON}" style="width:16px;height:16px">${esc(title)}<span style="margin-left:auto;width:46px;text-align:center;opacity:.35">✕</span></div>
    <iframe src="${base}/?window=prompt" style="border:0;width:440px;height:${height - 32}px;display:block"></iframe></div>`;
  return desktop(scheme, behind + win + taskbar(scheme));
}

/** macOS menu bar with the elapsed time next to the icon (`set_tray_status` title, refreshed every minute). */
function macTray(scheme: 'light' | 'dark', tray: Captured['tray']): string {
  const dark = scheme === 'dark';
  const ink = dark ? '#f5f5f7' : '#1d1d1f';
  const bar = `<div style="position:absolute;top:0;left:0;right:0;height:26px;background:${dark ? 'rgba(30,30,30,.6)' : 'rgba(255,255,255,.6)'};display:flex;align-items:center;gap:18px;padding:0 14px;color:${ink};font:13px -apple-system,'SF Pro Text',${FONT}"><b></b><b>Código</b><span>Archivo</span><span>Editar</span>
    <span style="margin-left:auto;display:flex;gap:14px;align-items:center"><span style="display:flex;gap:6px;align-items:center;padding:1px 6px;border-radius:4px;background:${dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.08)'}"><img src="${APP_ICON}" style="width:16px;height:16px">${esc(tray.title ?? '')}</span><span>◔</span><span>jue 5 nov 15:50</span></span></div>`;
  const tip = `<div style="position:absolute;top:34px;right:150px;max-width:420px;background:${dark ? '#323232' : '#f6f6f6'};color:${ink};border:1px solid ${dark ? '#4a4a4a' : '#d6d6d6'};border-radius:6px;padding:5px 9px;font:12px -apple-system,${FONT};box-shadow:0 4px 12px rgba(0,0,0,.2)">${esc(tray.tooltip)}</div>`;
  return desktop(scheme, bar + tip);
}

/** Windows notification area: the tooltip of the TimeTrack icon with the elapsed time. */
function windowsTray(scheme: 'light' | 'dark', tray: Captured['tray']): string {
  const dark = scheme === 'dark';
  const tip = `<span style="position:absolute;bottom:34px;right:-60px;white-space:nowrap;background:${dark ? '#2b2b2b' : '#f9f9f9'};color:${dark ? '#fff' : '#1b1b1b'};border:1px solid ${dark ? '#454545' : '#e0e0e0'};border-radius:6px;padding:6px 10px;font:12px ${FONT};box-shadow:0 6px 18px rgba(0,0,0,.25)">${esc(tray.tooltip)}</span>`;
  return desktop(scheme, taskbar(scheme, tip));
}

function buttons(scheme: 'light' | 'dark', note: Note, radius: number): string {
  const dark = scheme === 'dark';
  return `<div style="display:flex;gap:8px;margin-top:12px">${(note.actions ?? [])
    .map((action) => `<span style="flex:1;text-align:center;padding:7px 8px;border-radius:${radius}px;background:${dark ? '#3a3a3a' : '#ececec'};border:1px solid ${dark ? '#4b4b4b' : '#dcdcdc'}">${esc(action.label)}</span>`)
    .join('')}</div>`;
}

function windowsToast(scheme: 'light' | 'dark', note: Note): string {
  const dark = scheme === 'dark';
  const toast = `<div style="position:absolute;right:12px;bottom:60px;width:364px;background:${dark ? '#2b2b2b' : '#fbfbfb'};color:${dark ? '#fff' : '#1b1b1b'};border:1px solid ${dark ? '#404040' : '#e5e5e5'};border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.28);font:14px ${FONT};padding:12px 14px 14px">
    <div style="display:flex;align-items:center;gap:8px;font-size:12px;opacity:.85"><img src="${APP_ICON}" style="width:16px;height:16px">TimeTrack<span style="margin-left:auto;letter-spacing:2px">···&nbsp;&nbsp;✕</span></div>
    <div style="display:flex;gap:12px;margin-top:12px;align-items:flex-start"><img src="${pose(note.pose)}" style="width:48px;height:48px;flex:none">
      <div><div style="font-weight:600">${esc(note.title)}</div><div style="opacity:.85;margin-top:2px;line-height:1.35">${esc(note.body)}</div></div></div>
    ${buttons(scheme, note, 4)}</div>`;
  return desktop(scheme, toast + taskbar(scheme));
}

function gnomeNotification(scheme: 'light' | 'dark', note: Note): string {
  const dark = scheme === 'dark';
  const bar = `<div style="position:absolute;top:0;left:0;right:0;height:32px;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;font:600 14px Cantarell,${FONT}"><span style="position:absolute;left:14px;font-weight:400">Actividades</span>jue 5 nov 15:50</div>`;
  const card = `<div style="position:absolute;top:44px;left:50%;transform:translateX(-50%);width:440px;background:${dark ? '#303030' : '#fafafa'};color:${dark ? '#fff' : '#242424'};border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.35);padding:14px;font:14px Cantarell,${FONT}">
    <div style="display:flex;gap:12px;align-items:center"><img src="${pose(note.pose)}" style="width:48px;height:48px;flex:none">
      <div style="flex:1"><div style="display:flex;gap:6px;align-items:center;font-size:12px;opacity:.7"><img src="${APP_ICON}" style="width:14px;height:14px">TimeTrack · ahora</div><div style="font-weight:700;margin-top:4px">${esc(note.title)}</div><div style="opacity:.85;line-height:1.35">${esc(note.body)}</div></div></div>
    ${buttons(scheme, note, 8)}</div>`;
  return desktop(scheme, bar + card);
}

test('quick-win review screenshots', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  const data = await capture(page);
  const base = baseURL ?? 'http://127.0.0.1:1420';
  for (const scheme of ['light', 'dark'] as const) {
    await shoot(browser, scheme, 'prompt-three-choices', { width: 1366, height: 768 }, promptDesktop(scheme, String(data.three.windowTitle), base), data.three);
    await shoot(browser, scheme, 'prompt-reassign-picker', { width: 1366, height: 900 }, promptDesktop(scheme, String(data.picker.windowTitle), base, 760), data.picker);
    await shoot(browser, scheme, 'tray-elapsed-macos', { width: 1280, height: 300 }, macTray(scheme, data.tray));
    await shoot(browser, scheme, 'tray-elapsed-windows', { width: 1366, height: 300 }, windowsTray(scheme, data.tray));
    await shoot(browser, scheme, 'nudge-windows-toast', { width: 1366, height: 600 }, windowsToast(scheme, data.nudge));
    await shoot(browser, scheme, 'nudge-gnome', { width: 1366, height: 400 }, gnomeNotification(scheme, data.nudge));
  }
});

test('in-app: the nudge toast, "Continue last" and the Settings additions', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 400, height: 760 });
  await signIn(page);
  await page.locator('[data-task="T-102"] .row-action').click();
  await page.locator('#stop').click();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.evaluate(async () => {
      const { app, hooks } = (window as unknown as Tt).__timeTrack;
      hooks.idleSeconds = 3;
      app.state = { ...app.state, messages: { ...(app.state.messages as object), lastShownAt: null }, nudge: { activeSince: new Date(Date.now() - 11 * 60_000).toISOString(), measured: true, lastAt: null, recent: [] } };
      await app.tick();
    });
    await expect(page.locator('#nudge')).toBeVisible();
    await expect(page.locator('#resume')).toHaveText('Continuar la última');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.screenshot({ path: `${DIR}/in-app-nudge-continue-last-${scheme}.png`, animations: 'disabled', caret: 'hide' });
    await page.locator('#nudge-dismiss').click();
    await page.keyboard.press('Control+,');
    await page.locator('#helpers').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelector('#helpers')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.screenshot({ path: `${DIR}/settings-quick-wins-${scheme}.png`, animations: 'disabled', caret: 'hide' });
    await page.keyboard.press('Escape');
  }
});
