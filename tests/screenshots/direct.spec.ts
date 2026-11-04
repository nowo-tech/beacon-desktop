import { expect, test } from '@playwright/test';
import { app, connect, control, reset, shot, signIn, UPDATE } from './helpers';

/** Screenshots of the default (direct download) build: `pnpm screenshots`. */
test.beforeEach(reset);

test('desktop-device-code', async ({ page }) => {
  await connect(page);
  await expect(page.locator('body')).toContainText('beacon.example.test/device');
  await shot(page, 'desktop-device-code');
});

test('desktop-timer', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-task="T-104"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Fix invoice rounding bug');
  await page.locator('#main [data-task="T-101"] .row-action', { hasText: 'Switch' }).click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
  await shot(page, 'desktop-timer');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`desktop-update-card-${scheme} and progress`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page);
    await control('config', { update: UPDATE });
    await app(page).check();
    await expect(page.locator('#update')).toBeVisible();
    await page.locator('#update-notes-toggle').click();
    await expect(page.locator('#update-notes')).toContainText('A calmer update card');
    await shot(page, `desktop-update-card-${scheme}`);
    await app(page).holdProgress();
    await page.locator('#update-now').click();
    await expect(page.locator('#update-progress-label')).toContainText('Downloading version 0.5.0…');
    await expect.poll(() => page.locator('#update-progress').evaluate((el) => (el as HTMLProgressElement).value), { timeout: 15_000 }).toBe(50);
    await shot(page, `desktop-update-progress-${scheme}`);
  });
}

test('desktop-update-running', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-task="T-104"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Fix invoice rounding bug');
  await control('config', { update: UPDATE });
  await app(page).check();
  await page.locator('#update-now').click();
  await expect(page.locator('#update-running')).toContainText('A timer is running on Fix invoice rounding bug.');
  await shot(page, 'desktop-update-running');
});

test('desktop-update-required', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-task="T-101"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
  await control('config', { update: UPDATE, minSupportedVersion: '0.5.0' });
  await app(page).refresh();
  await expect(page.getByRole('alertdialog', { name: 'Update required' })).toBeVisible();
  await shot(page, 'desktop-update-required');
});
