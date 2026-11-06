import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** 0.4.0 updater UX against the mock Beacon updater route and the browser platform's mocked Tauri updater. */
const MOCK = 'http://127.0.0.1:8787';
const UPDATE = { version: '0.7.0', notes: 'Added\n- A calmer update card\n- Check for updates in the tray', pub_date: '2026-11-04T10:00:00Z', url: 'u', signature: 's' };

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

type Hooks = { installed: number; installStepMs: number; installError: string | null };
type Tt = { __timeTrack: { app: { refresh(): Promise<void>; checkUpdates(manual?: boolean): Promise<void> }; hooks: Hooks } };
const app = (page: Page) => ({
  check: () => page.evaluate(() => (window as unknown as Tt).__timeTrack.app.checkUpdates()),
  refresh: () => page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh()),
  installed: () => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.installed),
  slowInstall: () => page.evaluate(() => void ((window as unknown as Tt).__timeTrack.hooks.installStepMs = 400)),
});

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

async function axe(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => `${state}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`update card (${scheme}): What's new, progress, install; calm and accessible`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page);
    await control('config', { update: UPDATE });
    await app(page).check();
    const card = page.locator('#update');
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Version 0.7.0 is available' })).toBeVisible();
    await expect(card.locator('img.mascot')).toBeVisible();
    // Non-blocking: the task list stays usable.
    await expect(page.locator('#search')).toBeEnabled();
    await axe(page, 'update card');
    await page.locator('#update-notes-toggle').click();
    await expect(page.locator('#update-notes-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#update-notes')).toContainText('A calmer update card');
    await axe(page, 'update notes');
    await app(page).slowInstall();
    await page.locator('#update-now').click();
    await expect(page.locator('#update-progress-label')).toContainText('Downloading version 0.7.0…');
    await expect(page.locator('#update-progress')).toBeVisible();
    await axe(page, 'update progress');
    await expect(page.locator('#update-progress-label')).toHaveText('Installing version 0.7.0. TimeTrack will restart.', { timeout: 5_000 });
    await expect.poll(() => app(page).installed()).toBe(1);
  });
}

test('a running timer is never interrupted without asking: "After I stop"', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-task="T-104"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Fix invoice rounding bug');
  await control('config', { update: UPDATE });
  await app(page).check();
  await page.locator('#update-now').click();
  await expect(page.locator('#update-running')).toContainText('A timer is running on Fix invoice rounding bug.');
  await expect(page.locator('#update-after-stop')).toBeFocused();
  await axe(page, 'update while running');
  await page.keyboard.press('Enter');
  await expect(page.locator('#update-waiting')).toHaveText('TimeTrack will update when you stop the timer.');
  expect(await app(page).installed()).toBe(0);
  await page.locator('#stop').click();
  await expect(page.locator('#timer')).toContainText('Not tracking');
  await expect.poll(() => app(page).installed()).toBe(1);
  const entries = Object.values(((await control('state')) as { entries: Record<string, { taskId: string }[]> }).entries).flat();
  expect(entries.map((e) => e.taskId)).toEqual(['T-104']);
});

test('forced update (GET me minSupportedVersion): blocking screen with a way out; stop, then update', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-task="T-101"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
  await control('config', { update: UPDATE, minSupportedVersion: '0.7.0' });
  await app(page).refresh();
  const dialog = page.getByRole('alertdialog', { name: 'Update required' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#update-required-text')).toContainText('Version 0.7.0 or later is required.');
  await expect(page.locator('#update-required-running')).toContainText('A timer is running on Write onboarding guide.');
  await expect(page.locator('#remind-later')).toBeVisible();
  await axe(page, 'update required');
  await page.locator('#stop-then-update').click();
  await expect.poll(() => app(page).installed()).toBe(1);
  const entries = Object.values(((await control('state')) as { entries: Record<string, { taskId: string; endedAt: string | null }[]> }).entries).flat();
  expect(entries).toHaveLength(1);
  expect(entries[0].endedAt).not.toBeNull();
});

test('tray "Check for updates…" and a failed install stay non-blocking', async ({ page }) => {
  await signIn(page);
  await control('config', { update: UPDATE });
  await page.evaluate(() => (window as unknown as { __timeTrack: { hooks: { trayAction(a: string): void } } }).__timeTrack.hooks.trayAction('check-updates'));
  await expect(page.locator('#notice')).toHaveText('Version 0.7.0 is available.');
  await page.evaluate(() => void ((window as unknown as Tt).__timeTrack.hooks.installError = 'signature verification failed'));
  await page.locator('#update-now').click();
  await expect(page.locator('#update-message')).toContainText('The automatic update failed: signature verification failed.');
  await expect(page.locator('#download-beacon')).toBeVisible();
  await expect(page.locator('#search')).toBeEnabled();
});
