import { expect, test, type Page } from '@playwright/test';

/**
 * BD-3a, audit ZCD: two organizations and the offline queue. A stop queued while the network is down stays in the
 * organization it was made in (the switch waits for it), keeps the activity type chosen in the dialog and the time of
 * the click, and replays there once back online. The mini timer keeps keyboard focus across Stop / Resume.
 */
const MOCK = 'http://127.0.0.1:8787';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const ORG2 = 'org:7b1f2a9f-2c3d-4e4f-9a01-b2c3d4e5f6a7';

type Tt = { __timeTrack: { app: { refresh(): Promise<void>; pendingSync: number } } };
type Req = { method: string; path: string; body: string; context: string | null };

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', {
    deviceInterval: 1,
    allocation: { requireActivityType: true },
    contextPolicy: { required: true, refuse: [] },
    contextTasks: { personal: ['T-101', 'T-102'], [ORG]: ['T-104', 'T-105'], [ORG2]: ['T-106', 'T-107'] },
  });
});

test('two organizations: a stop queued offline replays in its own organization before the switch', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await page.locator('.ctx-tile[title="Lumen Works"]').click();
  await expect(page.locator('[data-task="T-104"]')).toBeVisible();
  await page.locator('[data-task="T-104"] .row-action').click();
  await expect(page.locator('#timer-pill.running')).toBeVisible();
  // Switching to Harbor Studio asks the required field; the network drops before the stop is sent.
  await page.locator('.ctx-tile[title="Harbor Studio"]').click();
  await expect(page.locator('#alloc-dialog')).toBeVisible();
  await expect(page.locator('#alloc-activity')).toBeEnabled();
  await page.locator('#alloc-activity').selectOption('review');
  const clicked = Date.now();
  await context.setOffline(true);
  await page.locator('#alloc-submit').click();
  await expect(page.locator('#alloc-dialog')).toBeHidden();
  // Queued only: still Lumen Works, the switch waits, and so does a second try.
  await expect(page.locator('#shell-live')).toContainText('offline');
  await expect(page.locator('.tb-ctx', { hasText: 'Lumen Works' })).toBeVisible();
  await page.locator('.ctx-tile[title="Harbor Studio"]').click();
  await expect(page.locator('.tb-ctx', { hasText: 'Lumen Works' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.pendingSync)).toBe(1);
  // Back online: the stop is sent in Lumen Works with the chosen type and the click's time; then the switch works.
  await context.setOffline(false);
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
  expect(await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.pendingSync)).toBe(0);
  const state = (await control('state')) as { requests: Req[]; timers: Record<string, unknown> };
  expect(Object.keys(state.timers)).toEqual([]);
  const stop = state.requests.filter((item) => item.path.endsWith('timer/stop')).at(-1);
  expect(stop?.context).toBe(ORG);
  const body = JSON.parse(stop?.body ?? '{}') as { activityTypeKey?: string; endedAt?: string };
  expect(body.activityTypeKey).toBe('review');
  expect(Math.abs(Date.parse(body.endedAt ?? '') - clicked)).toBeLessThan(3000);
  await page.locator('.ctx-tile[title="Harbor Studio"]').click();
  await expect(page.locator('.tb-ctx', { hasText: 'Harbor Studio' })).toBeVisible();
  await expect(page.locator('[data-task="T-106"]')).toBeVisible();
  // Lumen Works' task is not offered for Resume here.
  await expect(page.locator('[data-task="T-104"]')).toHaveCount(0);
});

test('mini timer keeps keyboard focus across Stop and Resume', async ({ page }) => {
  await page.setViewportSize({ width: 312, height: 132 });
  const view = {
    theme: 'light',
    lang: 'en',
    windowTitle: 'Mini timer',
    running: true,
    task: 'Fix invoice rounding bug',
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    status: 'Tracking · Lumen Works',
    canStart: false,
    busy: false,
    labels: { stop: 'Stop', start: 'Resume', startTask: 'Resume "Fix invoice rounding bug"', expand: 'Open Beacon Desktop', close: 'Close mini timer', noTask: 'Pick a task in Beacon Desktop to start.', elapsed: 'Elapsed' },
  };
  await page.addInitScript((value) => {
    (window as unknown as { __timeTrackMini: unknown }).__timeTrackMini = { view: value, actions: [] };
  }, view);
  await page.goto('/?window=mini');
  const toggle = page.locator('#mini-toggle');
  await toggle.focus();
  await page.keyboard.press('Enter');
  const set = (patch: object) =>
    page.evaluate((p) => {
      const hooks = (window as unknown as { __timeTrackMini: { view: object; setView(v: object): void } }).__timeTrackMini;
      hooks.setView({ ...hooks.view, ...p });
    }, patch);
  await set({ busy: true });
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await set({ busy: false, running: false, startedAt: null, canStart: true });
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveText(/Resume/);
  await page.keyboard.press('Enter');
  const actions = await page.evaluate(() => (window as unknown as { __timeTrackMini: { actions: string[] } }).__timeTrackMini.actions);
  expect(actions).toEqual(['stop', 'start']);
});
