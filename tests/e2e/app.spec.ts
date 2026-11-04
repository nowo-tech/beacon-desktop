import { expect, test, type Page } from '@playwright/test';

const MOCK = 'http://127.0.0.1:8787';
const SHOTS = process.env.SCREENSHOTS === '1';

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
  if (SHOTS) await page.screenshot({ path: 'docs/images/desktop-device-code.png' });
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
  await page.locator('[data-task="T-104"] button').click();
  await expect(page.locator('#timer-task')).toHaveText('Fix invoice rounding bug');
  await page.locator('[data-task="T-101"] button', { hasText: 'Switch' }).click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
  if (SHOTS) await page.screenshot({ path: 'docs/images/desktop-timer.png' });
  await page.locator('#stop').click();
  await expect(page.locator('#timer')).toHaveText('No timer running.');
  const state = (await control('state')) as { entries: Record<string, { taskId: string; source: string }[]> };
  expect(Object.values(state.entries).flat().map((e) => [e.taskId, e.source])).toEqual([
    ['T-104', 'desktop'],
    ['T-101', 'desktop'],
  ]);
  await page.locator('#open-settings').click();
  await page.locator('#logout').click();
  await expect(page.locator('#login-form')).toBeVisible();
});

test('idle prompt is opt-in and only the decision is sent', async ({ page }) => {
  await signIn(page);
  await page.locator('#open-settings').click();
  await page.locator('#feature-idleDetection').check();
  await expect(page.locator('#consent-idleDetection')).toContainText('Consent given on');
  await page.locator('#back').click();
  await page.locator('[data-task="T-102"] button').click();
  await expect(page.locator('#timer-task')).toHaveText('Review pull request queue');
  await control('timer/backdate', { seconds: 3600 });
  await page.evaluate(() => (window as unknown as { __timeTrack: { app: AppHandle } }).__timeTrack.app.refresh());
  await page.evaluate(async () => {
    const tt = (window as unknown as { __timeTrack: { app: AppHandle; hooks: Hooks } }).__timeTrack;
    tt.hooks.idleSeconds = 1500;
    await tt.app.tick();
    tt.hooks.idleSeconds = 3;
    await tt.app.tick();
  });
  await expect(page.locator('#idle')).toContainText('You were away');
  await page.locator('#idle-split').click();
  await expect(page.locator('#idle')).toHaveCount(0);
  const state = (await control('state')) as { idleDecisions: { action: string }[]; requests: { body: string }[] };
  expect(state.idleDecisions.map((d) => d.action)).toEqual(['split']);
  expect(state.requests.map((r) => r.body).join()).not.toMatch(/isIdle|idleSeconds/);
});

test('offline actions are queued and synced', async ({ page, context }) => {
  await signIn(page);
  await context.setOffline(true);
  await page.locator('[data-task="T-103"] button').click();
  await expect(page.locator('#offline')).toContainText('1 action(s)');
  await context.setOffline(false);
  await page.evaluate(() => (window as unknown as { __timeTrack: { app: AppHandle } }).__timeTrack.app.refresh());
  await expect(page.locator('#notice')).toHaveText('Back online: 1 action(s) sent.');
  await expect(page.locator('#offline')).toHaveCount(0);
  const state = (await control('state')) as { timers: Record<string, { taskId: string }> };
  expect(Object.values(state.timers).map((t) => t.taskId)).toEqual(['T-103']);
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
  await expect(page.getByRole('link', { name: 'Open Beacon' })).toHaveAttribute('href', 'https://beacon.test/dashboard');
  await expect(page.getByRole('link', { name: 'My time' })).toHaveAttribute('href', 'https://beacon.test/dashboard/tasks/time');
  const taskLink = page.getByRole('link', { name: 'Open “Write onboarding guide” in Beacon' });
  await expect(taskLink).toHaveAttribute('href', 'https://beacon.test/dashboard/tasks/T-101');
  await expect(page.locator('[data-task="T-102"] a')).toHaveCount(0);
  await taskLink.focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-task="T-101"] button').click();
  await expect(page.getByRole('link', { name: 'Open “Write onboarding guide” in Beacon' })).toHaveCount(2);
  await page.getByRole('link', { name: 'Open Beacon' }).click();
  const opened = await page.evaluate(() => (window as unknown as { __timeTrack: { hooks: Hooks } }).__timeTrack.hooks.opened);
  expect(opened.slice(1)).toEqual(['https://beacon.test/dashboard/tasks/T-101', 'https://beacon.test/dashboard']);
  expect(page.url()).toBe('http://127.0.0.1:1420/');
});
