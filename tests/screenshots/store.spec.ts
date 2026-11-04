import { expect, test } from '@playwright/test';
import { app, control, reset, shot, signIn } from './helpers';

/** Screenshots of the Microsoft Store build (`TIMETRACK_CHANNEL=store`, no in-app updater): `pnpm screenshots`. */
test.beforeEach(reset);

test('desktop-store-about', async ({ page }) => {
  await signIn(page);
  await page.locator('#open-settings').click();
  await expect(page.locator('#update-status')).toHaveText('Updates come from the Microsoft Store.');
  await page.locator('#about').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot(page, 'desktop-store-about');
});

test('desktop-store-update-required', async ({ page }) => {
  await signIn(page);
  await control('config', { minSupportedVersion: '0.5.0' });
  await app(page).refresh();
  await expect(page.getByRole('alertdialog', { name: 'Update required' })).toBeVisible();
  await expect(page.locator('#open-store-required')).toBeVisible();
  await shot(page, 'desktop-store-update-required');
});
