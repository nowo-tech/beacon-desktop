import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** 0.5.0: Settings → Theme (System / Light / Dark) and the mascot moments, in both themes. */
const MOCK = 'http://127.0.0.1:8787';
const LIGHT_PAPER = 'rgb(243, 246, 244)';
const DARK_PAPER = 'rgb(12, 18, 16)';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

type Tt = { __timeTrack: { app: { tick(): Promise<void>; refresh(): Promise<void> }; hooks: { windowTheme: string | null | undefined } } };
const tt = (page: Page) => ({
  refresh: () => page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh()),
  tick: () => page.evaluate(() => (window as unknown as Tt).__timeTrack.app.tick()),
  windowTheme: () => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.windowTheme),
});

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

const paper = (page: Page) => page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);

async function axe(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => `${state}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

test('theme follows the system by default; Dark / Light override it, persist and reach the native window', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  expect(await paper(page)).toBe(LIGHT_PAPER);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await paper(page)).toBe(DARK_PAPER);

  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page);
  await page.locator('#rail-settings').click();
  // One Theme, in Settings → Appearance (UX batch 6, UXA-2).
  await page.locator('#settings-tab-appearance').click();
  const group = page.getByRole('group', { name: 'Theme' });
  await expect(group.getByRole('radio', { name: 'System' })).toBeChecked();
  await group.getByRole('radio', { name: 'Dark' }).check();
  await expect(group.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await paper(page)).toBe(DARK_PAPER);
  expect(await tt(page).windowTheme()).toBe('dark');
  await axe(page, 'settings forced dark');
  // Arrow keys move inside the radio group (native radios).
  await group.getByRole('radio', { name: 'Dark' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(group.getByRole('radio', { name: 'Light' })).toBeChecked();
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await paper(page)).toBe(LIGHT_PAPER);
  await axe(page, 'settings forced light');

  await group.getByRole('radio', { name: 'System' }).check();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  expect(await paper(page)).toBe(DARK_PAPER);
  expect(await tt(page).windowTheme()).toBeNull();

  // Persisted: a forced theme is applied before the first screen of the next start (the browser fallback forgets the
  // token on reload, so that is the sign-in screen here).
  await group.getByRole('radio', { name: 'Light' }).check();
  await page.reload();
  await expect(page.locator('#login-form')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await paper(page)).toBe(LIGHT_PAPER);
  expect(await tt(page).windowTheme()).toBe('light');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`mascot moments (${scheme}): no results, saved, long-running — decorative art; welcome and offline in the status strip — axe clean`, async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page);
    // UX batch 4 (UXA-23, UXA-7): "You're in" is a line in the status strip, without art; the strip keeps its height.
    const welcome = page.locator('#time-strip-text');
    await expect(welcome).toContainText("You're in");
    await expect(page.locator('#time-strip-strip')).toHaveCSS('height', '36px');
    await axe(page, 'welcome');

    await page.locator('#search').fill('zzz');
    await expect(page.locator('#tasks-empty')).toContainText('the robot read the list twice');
    await expect(page.locator('#tasks-empty img')).toHaveAttribute('data-pose', 'pose-reading');
    await axe(page, 'no results');
    await page.locator('#search').fill('');

    await page.locator('[data-task="T-104"] .row-action').click();
    await expect(page.locator('#timer-task')).toHaveText('Fix invoice rounding bug');
    await expect(welcome).toHaveCount(0);
    await control('timer/backdate', { seconds: 9 * 3600 });
    await tt(page).refresh();
    await tt(page).tick();
    const nudge = page.getByRole('region', { name: 'Still going strong?' });
    await expect(nudge).toBeVisible();
    await axe(page, 'long-running');
    await nudge.getByRole('button', { name: 'Stop now' }).click();
    await expect(page.locator('#notice')).toContainText('Saved 9:00 on Fix invoice rounding bug. Nice work.');
    await expect(page.locator('#notice img')).toHaveAttribute('aria-hidden', 'true');
    await expect(nudge).toHaveCount(0);
    await axe(page, 'saved');

    await context.setOffline(true);
    await tt(page).refresh();
    const offline = page.locator('#offline');
    await expect(offline).toContainText('action(s)');
    await expect(page.locator('#offline-card')).toHaveCount(0);
    await axe(page, 'offline');
    await context.setOffline(false);
  });
}

test('reduced motion: the device-code arcs stand still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const arcs = page.locator('.mascot-wait .arcs');
  await expect(arcs).toBeVisible();
  expect(await arcs.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await expect(page.locator('.mascot-wait')).toHaveAttribute('aria-hidden', 'true');
  await page.locator('#cancel-device').click();
});
