import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** Friendly messages (0.5.0): the cheer card after a long stretch, in the real UI, both themes. */
const MOCK = 'http://127.0.0.1:8787';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

type Tt = { __timeTrack: { app: { tick(): Promise<void>; refresh(): Promise<void> }; hooks: { idleSeconds: number } } };

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`cheer card (${scheme}): non-blocking, never takes focus, accessible, dismissible, follows Settings`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await signIn(page);
    await page.locator('[data-task="T-101"] .row-action').click();
    await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
    await control('timer/backdate', { seconds: 2 * 3600 + 60 });
    await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
    await page.locator('#search').focus();
    await page.keyboard.type('onb');
    await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.tick());
    const card = page.getByRole('region', { name: 'A note from the robot' });
    await expect(card).toBeVisible();
    await expect(card.locator('img')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#search')).toBeFocused();
    await expect(page.locator('#search')).toHaveValue('onb');
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    await page.locator('#cheer-dismiss').click();
    await expect(card).toHaveCount(0);
    await page.locator('#open-settings').click();
    await expect(page.getByLabel('Fun messages from the robot')).toBeChecked();
    await expect(page.getByLabel('Wellbeing reminders')).toBeChecked();
    await page.getByLabel('Fun messages from the robot').uncheck();
    await expect(page.getByLabel('Fun messages from the robot')).not.toBeChecked();
  });
}

for (const motion of ['reduce', 'no-preference'] as const) {
  test(`"Still there?" modal with countdown (${motion} motion): takes focus, the rest is inert, axe clean`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: motion });
    await signIn(page);
    await page.locator('[data-task="T-101"] .row-action').click();
    await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
    await control('timer/backdate', { seconds: 3600 });
    await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
    await page.evaluate(async () => {
      const tt = (window as unknown as Tt).__timeTrack;
      tt.hooks.idleSeconds = 660;
      await tt.app.tick();
    });
    const dialog = page.getByRole('dialog', { name: 'Still there?' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('#idle-here')).toBeFocused();
    await expect(page.locator('#idle-countdown-text')).toContainText(/The timer pauses in [0-2]:\d\d/);
    await expect(page.locator('#timer')).toHaveAttribute('inert', '');
    const duration = await page.locator('#idle-countdown-fill').evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(duration === '0s').toBe(motion === 'reduce');
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    await page.locator('#idle-here').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#timer')).not.toHaveAttribute('inert', '');
  });
}
