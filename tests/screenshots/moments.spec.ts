import { expect, test, type Page } from '@playwright/test';
import { BEACON, app, connect, control, reset, shot, signIn, useFakeBeacon } from './helpers';

/**
 * 0.5.0 screenshots: the key screens and the mascot moments in the light and the dark theme (`pnpm screenshots`).
 * The theme comes from the emulated system preference (Settings → Theme = System, the default).
 */
test.beforeEach(reset);

const tick = (page: Page) => page.evaluate(() => (window as unknown as { __timeTrack: { app: { tick(): Promise<void> } } }).__timeTrack.app.tick());

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.beforeEach(({ page }) => page.emulateMedia({ colorScheme: scheme }));

    test(`desktop-first-run-${scheme}`, async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('#login-form .mascot')).toBeVisible();
      await page.locator('#server').fill(BEACON);
      await shot(page, `desktop-first-run-${scheme}`);
    });

    test(`desktop-device-code-${scheme}`, async ({ page }) => {
      await connect(page);
      await shot(page, `desktop-device-code-${scheme}`);
    });

    test(`desktop-welcome-${scheme}`, async ({ page }) => {
      await signIn(page, true);
      await expect(page.getByRole('region', { name: "You're in!" })).toBeVisible();
      await shot(page, `desktop-welcome-${scheme}`);
    });

    test(`desktop-timer-${scheme} and saved`, async ({ page }) => {
      await signIn(page);
      await page.locator('[data-task="T-104"] .row-action').click();
      await control('timer/backdate', { seconds: 85 * 60 });
      await app(page).refresh();
      await expect(page.locator('#timer-task')).toHaveText('Fix invoice rounding bug');
      await shot(page, `desktop-timer-${scheme}`);
      await page.locator('#stop').click();
      await expect(page.locator('#notice')).toContainText('Saved 1:25 on Fix invoice rounding bug. Nice work.');
      await shot(page, `desktop-saved-${scheme}`);
    });

    test(`desktop-long-running-${scheme}`, async ({ page }) => {
      await signIn(page);
      await page.locator('[data-task="T-102"] .row-action').click();
      await control('timer/backdate', { seconds: 9 * 3600 + 120 });
      await app(page).refresh();
      await tick(page);
      await expect(page.getByRole('region', { name: 'Still going strong?' })).toBeVisible();
      await shot(page, `desktop-long-running-${scheme}`);
    });

    test(`desktop-no-results-${scheme}`, async ({ page }) => {
      await signIn(page);
      await page.locator('#search').fill('quarterly roadmap');
      await expect(page.locator('#tasks-empty')).toContainText('the robot read the list twice');
      await shot(page, `desktop-no-results-${scheme}`);
    });

    test(`desktop-offline-${scheme}`, async ({ page }) => {
      await signIn(page);
      // Later routes win: Beacon is now unreachable; the start is queued.
      await page.route(`${BEACON}/**`, (route) => route.abort('internetdisconnected'));
      await page.locator('[data-task="T-101"] .row-action').click();
      await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
      await expect(page.getByRole('region', { name: 'Working offline' })).toBeVisible();
      await expect(page.locator('#offline')).toContainText('1 action(s)');
      await shot(page, `desktop-offline-${scheme}`);
    });

    test(`desktop-settings-theme-${scheme}`, async ({ page }) => {
      await signIn(page);
      await page.locator('#open-settings').click();
      await expect(page.getByRole('group', { name: 'Theme' })).toBeVisible();
      await shot(page, `desktop-settings-theme-${scheme}`);
    });
  });
}

test('desktop-device-expired', async ({ page }) => {
  await control('config', { deviceExpiresIn: 0 });
  await useFakeBeacon(page);
  await page.goto('/');
  await page.locator('#server').fill(BEACON);
  await page.locator('#connect').click();
  await expect(page.locator('#device-state')).toHaveText('The code expired');
  await shot(page, 'desktop-device-expired');
});
