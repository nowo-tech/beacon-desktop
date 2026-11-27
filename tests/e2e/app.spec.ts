import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const MOCK = 'http://127.0.0.1:8787';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

type Hooks = { idleSeconds: number; opened: string[] };
type AppHandle = { tick(): Promise<void>; refresh(): Promise<void>; checkUpdates(): Promise<void> };

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  const opened = await page.evaluate(() => (window as unknown as { __timeTrack: { hooks: Hooks } }).__timeTrack.hooks.opened);
  expect(opened[0]).toContain(`code=${code}`);
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

test('device sign-in, start, switch, stop, sign out', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-task="T-104"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Fix invoice rounding bug');
  await page.locator('#main [data-task="T-101"] .row-action[aria-label^="Switch to"]').click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
  await page.locator('#stop').click();
  await expect(page.locator('#timer')).toContainText('Not tracking');
  const state = (await control('state')) as { entries: Record<string, { taskId: string; source: string }[]> };
  expect(Object.values(state.entries).flat().map((e) => [e.taskId, e.source])).toEqual([
    ['T-104', 'desktop'],
    ['T-101', 'desktop'],
  ]);
  await page.locator('#rail-settings').click();
  await page.locator('#settings-tab-account').click();
  await page.locator('#logout').click();
  await expect(page.locator('#login-form')).toBeVisible();
});

type Tt = { __timeTrack: { app: AppHandle; hooks: Hooks } };
const idleTick = (page: Page, seconds: number) =>
  page.evaluate(async (value) => {
    const tt = (window as unknown as Tt).__timeTrack;
    tt.hooks.idleSeconds = value;
    await tt.app.tick();
  }, seconds);

test('"Still there?" asks after the threshold and only the decision is sent', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-task="T-102"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Review pull request queue');
  await control('timer/backdate', { seconds: 3600 });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
  await idleTick(page, 617.25);
  await expect(page.locator('#idle')).toContainText('Still there?');
  await expect(page.locator('#idle-text')).toHaveText('No activity for 10 min on Review pull request queue.');
  // A modal: it takes focus and the rest of the window is inert until it is answered.
  await expect(page.locator('#idle-here')).toBeFocused();
  await expect(page.locator('#timer')).toHaveAttribute('inert', '');
  await page.locator('#idle-here').focus();
  // Keep · Discard · Reassign, then "I was in a meeting".
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
  await expect(page.locator('#idle-meeting')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#idle-note')).toBeFocused();
  await page.keyboard.type('Planning call');
  await page.locator('#idle-meeting-save').click();
  await expect(page.locator('#idle')).toHaveCount(0);
  await expect(page.locator('#notice')).toHaveText('Got it, the time is kept.');
  const state = (await control('state')) as { idleDecisions: { action: string }[]; requests: { body: string; query: string }[] };
  expect(state.idleDecisions.map((d) => d.action)).toEqual(['keep']);
  expect(state.requests.map((r) => `${r.query} ${r.body}`).join()).not.toMatch(/617\.25|617250|isIdle|idleSeconds|lastInput/);
  // The meeting note goes on the entry when it stops.
  await page.locator('#stop').click();
  await expect(page.locator('#timer')).toContainText('Not tracking');
  const entries = Object.values(((await control('state')) as { entries: Record<string, { metadata: { note?: string } | null }[]> }).entries).flat();
  expect(entries[0].metadata).toEqual({ note: 'Planning call' });
});

test('no answer: the entry ends at the last input, then the gap question and Resume (fake idle clock)', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-task="T-101"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
  await control('timer/backdate', { seconds: 3600 });
  const start = Date.now() - 10 * 60_000;
  await page.clock.install({ time: start });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
  await idleTick(page, 660);
  await expect(page.locator('#idle')).toBeVisible();
  const lastInput = (await page.evaluate(() => Date.now())) - 660_000;
  await page.clock.fastForward('06:00');
  await idleTick(page, 660 + 360);
  await expect(page.locator('#idle-away')).toContainText('Timer paused');
  await expect(page.locator('#timer')).toContainText('Not tracking');
  const stopped = Object.values(((await control('state')) as { entries: Record<string, { endedAt: string }[]> }).entries).flat();
  expect(Math.abs(Date.parse(stopped[0].endedAt) - lastInput)).toBeLessThan(30_000);
  await idleTick(page, 1);
  await expect(page.locator('#gap')).toContainText('Welcome back');
  await page.locator('#gap-keep').click();
  await expect(page.locator('#gap-resume')).toBeFocused();
  await page.locator('#gap-resume').click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
  const entries = Object.values(((await control('state')) as { entries: Record<string, { startedAt: string; endedAt: string }[]> }).entries).flat();
  expect(entries).toHaveLength(2);
  expect(entries[1].startedAt).toBe(entries[0].endedAt);
});

async function axe(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => `${state}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`axe (${scheme}): Still there?, meeting form, gap, Resume, settings and privacy; keyboard order is the visual order`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page);
    await page.locator('[data-task="T-101"] .row-action').click();
    await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
    await control('timer/backdate', { seconds: 3600 });
    await page.clock.install({ time: Date.now() - 10 * 60_000 });
    await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
    await idleTick(page, 660);
    const card = page.getByRole('dialog', { name: 'Still there?' });
    await expect(card).toBeVisible();
    await expect(page.locator('#live')).toHaveCount(1);
    await expect(page.locator('#live')).toContainText('Still there?');
    await axe(page, 'still-there');
    // Tab order = visual order of the choices.
    await page.locator('#idle-here').focus();
    // Keep · Discard · Reassign, then the finer options.
    for (const id of ['idle-pause', 'idle-reassign', 'idle-meeting', 'idle-discard']) {
      await page.keyboard.press('Tab');
      await expect(page.locator(`#${id}`)).toBeFocused();
    }
    await page.locator('#idle-meeting').click();
    await expect(page.locator('#idle-note')).toBeFocused();
    await axe(page, 'meeting');
    await page.locator('#idle-meeting-cancel').click();
    await page.clock.fastForward('06:00');
    await idleTick(page, 660 + 360);
    await expect(page.locator('#idle-away')).toBeVisible();
    await axe(page, 'away');
    await idleTick(page, 1);
    await expect(page.getByRole('dialog', { name: 'Welcome back' })).toBeVisible();
    await expect(page.locator('#idle-reassign')).toBeVisible();
    await axe(page, 'gap');
    await page.locator('#gap-keep').focus();
    for (const id of ['idle-reassign', 'gap-discard']) {
      await page.keyboard.press('Tab');
      await expect(page.locator(`#${id}`)).toBeFocused();
    }
    await page.locator('#gap-discard').click();
    await expect(page.locator('#gap-resume')).toBeFocused();
    await axe(page, 'resume');
    await page.locator('#gap-dismiss').click();
    await page.locator('#rail-settings').click();
    await axe(page, 'settings');
    await page.locator('#settings-tab-account').click();
    await page.locator('#open-privacy').click();
    await page.locator('#clear-local').click();
    await axe(page, 'privacy');
  });
}

test('offline actions are queued and replayed with their real times', async ({ page, context }) => {
  await signIn(page);
  const startedOffline = Date.now() - 5 * 60_000;
  await page.clock.install({ time: startedOffline });
  await context.setOffline(true);
  await page.locator('[data-task="T-103"] .row-action').click();
  await expect(page.locator('#offline')).toContainText('1 action(s)');
  await context.setOffline(false);
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
  await expect(page.locator('#notice')).toHaveText('Back online: 1 action(s) sent.');
  await expect(page.locator('#offline')).toHaveCount(0);
  const state = (await control('state')) as { timers: Record<string, { taskId: string; startedAt: string }> };
  const [timer] = Object.values(state.timers);
  expect(timer.taskId).toBe('T-103');
  expect(Math.abs(Date.parse(timer.startedAt) - startedOffline)).toBeLessThan(5000);
});

test('privacy screen and clear local data', async ({ page }) => {
  await signIn(page);
  await page.locator('#rail-settings').click();
  await page.locator('#settings-tab-account').click();
  await page.locator('#open-privacy').click();
  await expect(page.locator('#privacy-sent')).toContainText('Never the input counter');
  await expect(page.locator('#privacy-local')).toContainText('never stored, logged or sent');
  await page.locator('#clear-local').click();
  await expect(page.locator('#clear-local-yes')).toBeFocused();
  await page.locator('#clear-local-yes').click();
  await expect(page.locator('#login-form')).toBeVisible();
  await expect(page.locator('#notice')).toContainText('Local data cleared');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('min_supported_version blocks with "update required"', async ({ page }) => {
  await signIn(page);
  await control('config', { update: { version: '99.1.0', notes: '', pub_date: '', url: 'u', signature: 's', min_supported_version: '99.0.0' } });
  await page.evaluate(() => (window as unknown as { __timeTrack: { app: AppHandle } }).__timeTrack.app.checkUpdates());
  await expect(page.locator('#update-required')).toContainText('Version 99.0.0 or later is required.');
  await expect(page.locator('#tasks')).toHaveCount(0);
});

test('Beacon links: Open Beacon, My time and same-origin task links on an https server', async ({ page }) => {
  // Serve https://beacon.test from the mock so the https-only links render in the browser build.
  await page.route('https://beacon.test/**', async (route) => {
    const response = await route.fetch({ url: route.request().url().replace('https://beacon.test', MOCK) });
    await route.fulfill({ response });
  });
  await control('config', {
    deviceInterval: 1,
    verificationUri: 'https://beacon.test/device',
    taskUrls: { 'T-101': 'https://beacon.test/dashboard/tasks/T-101', 'T-102': 'https://evil.test/dashboard/tasks/T-102' },
  });
  await page.goto('/');
  await expect(page.locator('a.beacon-link')).toHaveCount(0);
  await page.locator('#server').fill('https://beacon.test');
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Open Beacon', exact: true })).toHaveAttribute('href', 'https://beacon.test/dashboard');
  await expect(page.getByRole('link', { name: 'My time', exact: true })).toHaveAttribute('href', 'https://beacon.test/dashboard/tasks/time');
  const taskLink = page.getByRole('link', { name: 'Open “Write onboarding guide” in Beacon' });
  await expect(taskLink).toHaveAttribute('href', 'https://beacon.test/dashboard/tasks/T-101');
  await expect(page.locator('[data-task="T-102"] a')).toHaveCount(0);
  await taskLink.focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-task="T-101"] .row-action').click();
  // The running task is shown in the timer card only (not repeated in the list).
  await expect(page.locator('#timer-open-in-beacon')).toHaveAttribute('href', 'https://beacon.test/dashboard/tasks/T-101');
  await expect(page.getByRole('link', { name: 'Open “Write onboarding guide” in Beacon' })).toHaveCount(1);
  await page.getByRole('link', { name: 'Open Beacon', exact: true }).click();
  const opened = await page.evaluate(() => (window as unknown as { __timeTrack: { hooks: Hooks } }).__timeTrack.hooks.opened);
  expect(opened.slice(1)).toEqual(['https://beacon.test/dashboard/tasks/T-101', 'https://beacon.test/dashboard']);
  expect(page.url()).toBe('http://127.0.0.1:1420/');
});

test('typing in search keeps every letter and the focus; Enter on a row keeps focus (R1)', async ({ page }) => {
  await signIn(page);
  await control('config', { latencyMs: 30 });
  await page.keyboard.press('Control+k');
  await expect(page.locator('#search')).toBeFocused();
  await page.locator('#search').pressSequentially('fix', { delay: 50 });
  await expect(page.locator('#tasks li')).toHaveCount(1);
  await expect(page.locator('#search')).toHaveValue('fix');
  await expect(page.locator('#search')).toBeFocused();
  await page.evaluate(() => (window as unknown as { __timeTrack: { app: AppHandle } }).__timeTrack.app.refresh());
  await expect(page.locator('#search')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-task="T-104"] .row-action')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#timer-task')).toHaveText('Fix invoice rounding bug');
  await expect(page.locator('#stop')).toBeFocused();
});

test('connect errors are translated and keep the address (R2)', async ({ page }) => {
  await control('config', { notFound: ['device/code'] });
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await expect(page.locator('#error-title')).toHaveText("This server doesn't support device sign-in yet");
  await expect(page.locator('#server')).toHaveValue(MOCK);
  await control('config', { notFound: [] });
  await page.locator('#error-retry').click();
  await expect(page.locator('#user-code')).toHaveText(/^[A-Z]{4}-[A-Z]{4}$/);
});
