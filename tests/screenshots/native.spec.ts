import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { control, reset, signIn } from './helpers';

/**
 * Mock-ups of the native shell for review (`pnpm screenshots:native`, `NATIVE_SCREENS=<dir>`), light and dark:
 * a Windows 11 toast (bottom right), a macOS and a GNOME notification, the "Still there?" window centred over a
 * desktop (fresh, mid-countdown, paused) and the Windows tray menu. The texts, poses and prompt are the real ones
 * (Spanish, from the running app with the browser platform's fake OS); the OS chrome around them is drawn here, as
 * faithfully as CSS allows, since the review cannot run on three desktops. The prompt itself is the real prompt
 * window page (`/?window=prompt`) in an iframe.
 */
const DIR = process.env.NATIVE_SCREENS ?? '';
test.skip(DIR === '', 'set NATIVE_SCREENS=<dir> to write the native mock-ups');
test.use({ locale: 'es-ES', timezoneId: 'Europe/Madrid' });
test.beforeEach(reset);

type View = Record<string, unknown>;
interface Hooks {
  nativePrompt: boolean;
  notificationPermission: string;
  friendly: { title: string; body: string; pose: string }[];
  prompt: View | null;
  trayMenu: { primary: { label: string } | null; switchLabel: string; search: string; open: string; openBeacon: string | null; myTime: string | null; checkUpdates: string | null; pauseFriendly: { label: string } | null; settings: string; quit: string } | null;
  tray: { tooltip: string; status: string };
  wake(reason?: string): void;
}
type App = { state: Record<string, unknown> & { activeTimer: { taskId: string; taskTitle: string; startedAt: string } }; render(): void; refresh(): Promise<void>; updateTray(): Promise<void> };
type Tt = { __timeTrack: { app: App; hooks: Hooks } };

const png = (path: string) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
const APP_ICON = png('src-tauri/icons/128x128.png');
const pose = (id: string) => png(`src-tauri/notification-art/pose-${id}.png`);
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const WALL = {
  light: 'radial-gradient(120% 90% at 70% 110%, #7fb3e6 0%, #b9d6f2 40%, #e9f1fa 75%)',
  dark: 'radial-gradient(120% 90% at 70% 110%, #1d3b66 0%, #12223b 45%, #0a111d 80%)',
};

interface Captured {
  note: { title: string; body: string; pose: string };
  fresh: View;
  mid: View;
  paused: View;
  tray: NonNullable<Hooks['trayMenu']>;
  status: string;
  tooltip: string;
}

/** Real data from the app: a friendly notification, the three prompt states and the tray menu (Spanish). */
async function capture(page: Page): Promise<Captured> {
  await signIn(page);
  await page.evaluate(() => {
    const hooks = (window as unknown as Tt).__timeTrack.hooks;
    hooks.nativePrompt = true;
    hooks.notificationPermission = 'granted';
  });
  await page.locator('[data-task="T-101"] .row-action').click();
  await expect(page.locator('#timer .elapsed')).toBeVisible();
  await control('timer/backdate', { seconds: 125 * 60 });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.wake('tick'));
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly.length)).toBe(1);
  const note = await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly[0] as Captured['note']);
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.updateTray());
  const ask = (askedAgoMs: number) =>
    page.evaluate((ago) => {
      const { app, hooks } = (window as unknown as Tt).__timeTrack;
      const timer = app.state.activeTimer;
      const now = Date.now();
      app.state = { ...app.state, messages: { ...(app.state.messages as object), idleLine: 2 }, idleCheck: { phase: 'asking', taskId: timer.taskId, taskTitle: timer.taskTitle, from: new Date(now - 11 * 60_000).toISOString(), askedAt: new Date(now - ago).toISOString(), returnedAt: null, timerStartedAt: timer.startedAt } };
      app.render();
      return hooks.prompt as View;
    }, askedAgoMs);
  const fresh = await ask(0);
  const mid = await ask(75_000);
  const paused = await page.evaluate(() => {
    const { app, hooks } = (window as unknown as Tt).__timeTrack;
    app.state = { ...app.state, idleCheck: { phase: 'away', taskId: 'T-101', taskTitle: app.state.activeTimer.taskTitle, from: new Date(Date.now() - 13 * 60_000).toISOString() } };
    app.render();
    return hooks.prompt as View;
  });
  const { trayMenu, tray } = await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks);
  return { note, fresh, mid, paused, tray: trayMenu as Captured['tray'], status: tray.status, tooltip: tray.tooltip };
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

const FONT = `'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,'Cantarell','Ubuntu',sans-serif`;

/** Windows 11 taskbar with the notification area (the TimeTrack icon next to the clock, as Docker Desktop's). */
function taskbar(scheme: 'light' | 'dark', clock = '14:52'): string {
  const dark = scheme === 'dark';
  const bar = dark ? 'rgba(32,32,32,.92)' : 'rgba(243,243,243,.92)';
  const ink = dark ? '#fff' : '#1b1b1b';
  return `<div style="position:absolute;left:0;right:0;bottom:0;height:48px;background:${bar};backdrop-filter:blur(30px);border-top:1px solid ${dark ? '#3a3a3a' : '#dcdcdc'};display:flex;align-items:center;justify-content:center;color:${ink};font:12px ${FONT}">
    <div style="display:flex;gap:6px">${['#0078d4', '#ffb900', '#107c10', '#5c2d91'].map((c) => `<span style="width:32px;height:32px;border-radius:6px;background:${c};opacity:.85"></span>`).join('')}</div>
    <div style="position:absolute;right:12px;display:flex;align-items:center;gap:10px">
      <span style="font-size:11px">^</span>
      <span title="Docker Desktop" style="width:18px;height:14px;border-radius:3px;background:#1d63ed"></span>
      <img src="${APP_ICON}" style="width:18px;height:18px;filter:grayscale(${0})">
      <span style="width:16px;height:12px;border:2px solid ${ink};border-radius:2px;opacity:.7"></span>
      <span style="text-align:right;line-height:1.2">${clock}<br>05/11/2026</span>
    </div></div>`;
}

function windowsToast(scheme: 'light' | 'dark', note: Captured['note']): string {
  const dark = scheme === 'dark';
  return `<div style="position:absolute;right:12px;bottom:60px;width:364px;background:${dark ? '#2b2b2b' : '#fbfbfb'};color:${dark ? '#fff' : '#1b1b1b'};border:1px solid ${dark ? '#404040' : '#e5e5e5'};border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.28);font:14px ${FONT};padding:12px 14px 16px">
    <div style="display:flex;align-items:center;gap:8px;font-size:12px;opacity:.85"><img src="${APP_ICON}" style="width:16px;height:16px">TimeTrack<span style="margin-left:auto;letter-spacing:2px">···&nbsp;&nbsp;✕</span></div>
    <div style="display:flex;gap:12px;margin-top:12px;align-items:flex-start">
      <img src="${pose(note.pose)}" style="width:48px;height:48px;flex:none">
      <div><div style="font-weight:600">${esc(note.title)}</div><div style="opacity:.85;margin-top:2px;line-height:1.35">${esc(note.body)}</div></div>
    </div></div>`;
}

function desktop(scheme: 'light' | 'dark', inner: string): string {
  return `<!doctype html><html><body style="margin:0;height:100vh;overflow:hidden;position:relative;background:${WALL[scheme]};font-family:${FONT}">${inner}</body></html>`;
}

function macDesktop(scheme: 'light' | 'dark', note: Captured['note']): string {
  const dark = scheme === 'dark';
  const ink = dark ? '#f5f5f7' : '#1d1d1f';
  const menu = `<div style="position:absolute;top:0;left:0;right:0;height:26px;background:${dark ? 'rgba(30,30,30,.55)' : 'rgba(255,255,255,.55)'};backdrop-filter:blur(20px);display:flex;align-items:center;gap:18px;padding:0 14px;color:${ink};font:13px -apple-system,'SF Pro Text',${FONT}"><b></b><b>TimeTrack</b><span>Archivo</span><span>Ventana</span><span style="margin-left:auto;display:flex;gap:14px;align-items:center"><img src="${APP_ICON}" style="width:16px;height:16px"> 2:05 Escribir guía <span>jue 5 nov 14:52</span></span></div>`;
  const card = `<div style="position:absolute;top:38px;right:14px;width:344px;background:${dark ? 'rgba(48,48,52,.86)' : 'rgba(246,246,248,.86)'};backdrop-filter:blur(24px);color:${ink};border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:12px 14px;display:flex;gap:10px;align-items:center;font:13px -apple-system,'SF Pro Text',${FONT}">
    <img src="${APP_ICON}" style="width:36px;height:36px;border-radius:8px;flex:none">
    <div style="flex:1;min-width:0"><div style="display:flex"><b>${esc(note.title)}</b><span style="margin-left:auto;opacity:.6;font-size:12px">ahora</span></div><div style="opacity:.85;line-height:1.3;margin-top:2px">${esc(note.body)}</div></div>
    <img src="${pose(note.pose)}" style="width:40px;height:40px;flex:none;border-radius:6px">
  </div>`;
  return desktop(scheme, menu + card);
}

function gnomeDesktop(scheme: 'light' | 'dark', note: Captured['note']): string {
  const dark = scheme === 'dark';
  const ink = dark ? '#fff' : '#242424';
  const bar = `<div style="position:absolute;top:0;left:0;right:0;height:32px;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;font:600 14px Cantarell,${FONT}"><span style="position:absolute;left:14px;font-weight:400">Actividades</span>jue 5 nov 14:52<span style="position:absolute;right:14px;display:flex;gap:10px;align-items:center"><img src="${APP_ICON}" style="width:16px;height:16px">◉ ⏻</span></div>`;
  const card = `<div style="position:absolute;top:44px;left:50%;transform:translateX(-50%);width:420px;background:${dark ? '#303030' : '#fafafa'};color:${ink};border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.35);padding:14px;display:flex;gap:12px;align-items:center;font:14px Cantarell,${FONT}">
    <img src="${pose(note.pose)}" style="width:48px;height:48px;flex:none">
    <div style="flex:1"><div style="display:flex;gap:6px;align-items:center;font-size:12px;opacity:.7"><img src="${APP_ICON}" style="width:14px;height:14px">TimeTrack · ahora</div><div style="font-weight:700;margin-top:4px">${esc(note.title)}</div><div style="opacity:.85;line-height:1.35">${esc(note.body)}</div></div>
  </div>`;
  return desktop(scheme, bar + card);
}

/** The prompt window (Windows 11 frame, always on top, close button disabled) centred over a desktop. */
function promptDesktop(scheme: 'light' | 'dark', title: string, base: string): string {
  const dark = scheme === 'dark';
  const frame = dark ? '#202020' : '#f3f3f3';
  const ink = dark ? '#fff' : '#1b1b1b';
  const behind = `<div style="position:absolute;left:80px;top:60px;width:760px;height:520px;background:${dark ? '#1f1f1f' : '#fff'};border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.2);opacity:.9;padding:20px;color:${dark ? '#999' : '#888'};font:13px ${FONT}">Editor de código — la ventana activa</div>`;
  const win = `<div style="position:absolute;left:50%;top:calc(50% - 24px);transform:translate(-50%,-50%);width:440px;height:592px;border-radius:8px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,.45);border:1px solid ${dark ? '#3c3c3c' : '#cfcfcf'};background:${frame}">
    <div style="height:32px;display:flex;align-items:center;gap:8px;padding:0 0 0 12px;color:${ink};font:12px ${FONT}"><img src="${APP_ICON}" style="width:16px;height:16px">${esc(title)}<span style="margin-left:auto;width:46px;text-align:center;opacity:.35">✕</span></div>
    <iframe src="${base}/?window=prompt" style="border:0;width:440px;height:560px;display:block"></iframe></div>`;
  return desktop(scheme, behind + win + taskbar(scheme));
}

function trayDesktop(scheme: 'light' | 'dark', tray: Captured['tray'], status: string, tooltip: string): string {
  const dark = scheme === 'dark';
  const ink = dark ? '#fff' : '#1b1b1b';
  const item = (label: string, disabled = false) => `<div style="padding:6px 12px 6px 32px;border-radius:4px;${disabled ? 'opacity:.55' : ''}">${esc(label)}</div>`;
  const sep = `<div style="height:1px;margin:4px 0;background:${dark ? '#444' : '#e0e0e0'}"></div>`;
  const rows = [
    item(status, true),
    tray.primary !== null ? item(tray.primary.label) : '',
    `<div style="padding:6px 12px 6px 32px;display:flex">${esc(tray.switchLabel)}<span style="margin-left:auto">›</span></div>`,
    item(tray.search),
    sep,
    item(tray.open),
    tray.openBeacon !== null ? item(tray.openBeacon) : '',
    tray.myTime !== null ? item(tray.myTime) : '',
    sep,
    tray.pauseFriendly !== null ? item(tray.pauseFriendly.label) : '',
    tray.checkUpdates !== null ? item(tray.checkUpdates) : '',
    item(tray.settings),
    item(tray.quit),
  ].join('');
  const menu = `<div style="position:absolute;right:120px;bottom:56px;min-width:300px;background:${dark ? '#2c2c2c' : '#f9f9f9'};color:${ink};border:1px solid ${dark ? '#454545' : '#e3e3e3'};border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.3);padding:4px;font:13px ${FONT}">${rows}</div>`;
  const tip = `<div style="position:absolute;right:20px;bottom:300px;display:none">${esc(tooltip)}</div>`;
  return desktop(scheme, menu + tip + taskbar(scheme));
}

test('native mock-ups', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const data = await capture(page);
  const base = baseURL ?? 'http://127.0.0.1:1420';
  for (const scheme of ['light', 'dark'] as const) {
    await shoot(browser, scheme, 'windows-toast', { width: 1366, height: 768 }, desktop(scheme, windowsToast(scheme, data.note) + taskbar(scheme)));
    await shoot(browser, scheme, 'macos-notification', { width: 1440, height: 900 }, macDesktop(scheme, data.note));
    await shoot(browser, scheme, 'gnome-notification', { width: 1366, height: 768 }, gnomeDesktop(scheme, data.note));
    for (const [name, view] of [['prompt-fresh', data.fresh], ['prompt-countdown', data.mid], ['prompt-paused', data.paused]] as const) {
      await shoot(browser, scheme, name, { width: 1366, height: 768 }, promptDesktop(scheme, String(view.windowTitle), base), view);
    }
    await shoot(browser, scheme, 'windows-tray-menu', { width: 1366, height: 768 }, trayDesktop(scheme, data.tray, data.status, data.tooltip));
  }
});
