import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/**
 * UX batches 2 + 3 in the real UI on the fake platform: the app-wide keys in every module (owner approval "global
 * shortcuts in every module", UXA-3), F6 areas and one Tab stop per long list (UXA-10), and the shortcut sheet per
 * module. axe (WCAG 2.2 AA) on the switcher and the sheet, light and dark.
 */
const MOCK = 'http://127.0.0.1:8787';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
}

const area = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el === null ? 'none' : el.closest('#titlebar') ? 'titlebar' : el.closest('#rail') ? 'rail' : el.closest('#chat-side, #sidebar') ? 'sidebar' : el.closest('#tasks-drawer, #thread-slot, #detail') ? 'detail' : el.closest('main') ? 'main' : 'other';
  });

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`Ctrl+K, ? and F6 in Time, Chat and Tasks — ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page);
    // Time: the global switcher (not the Time search), its timer actions.
    await page.locator('#nav-tasks').focus();
    await page.keyboard.press('Control+K');
    await expect(page.locator('#switcher')).toBeVisible();
    await page.locator('#sw-input').fill('plan');
    await expect(page.locator('#sw-list .opt').first()).toContainText('Plan sprint 42');
    await expect(page.locator('#sw-list .opt').first()).toContainText('Start timer');
    expect(await axe(page), `${scheme} switcher`).toEqual([]);
    await page.keyboard.press('Enter');
    await expect(page.locator('#timer.running')).toBeVisible();
    await expect(page.locator('#timer')).toContainText('Plan sprint 42');
    // `/` is the Time search.
    await page.locator('#nav-tasks').focus();
    await page.keyboard.press('/');
    await expect(page.locator('#search')).toBeFocused();
    await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search tasks… (/)');
    // `?`: Anywhere + Time.
    await page.locator('#nav-tasks').focus();
    await page.keyboard.press('?');
    await expect(page.locator('#shell-keys h2')).toHaveText(['Anywhere', 'Time']);
    expect(await axe(page), `${scheme} sheet`).toEqual([]);
    await page.keyboard.press('Escape');
    // F6 from nowhere: sidebar, list, details, title bar, rail.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press('F6');
      seen.push(await area(page));
    }
    expect(seen).toEqual(['sidebar', 'main', 'detail', 'titlebar', 'rail']);
    // Ctrl+Shift+S from Time stops it; Ctrl+Shift+L is the theme here too.
    await page.keyboard.press('Control+Shift+S');
    await expect(page.locator('#timer.running')).toHaveCount(0);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.keyboard.press('Control+Shift+L');
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).not.toBe(theme);

    // Chat: one Tab stop for the conversation list, ↓ moves, `?` lists Chat.
    await page.locator('#tab-chat').click();
    await page.locator('#chat-connect').click();
    await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
    await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('#notify-later').click();
    await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
    await expect(page.locator('.side .conv', { hasText: 'envelope-v2' })).toBeVisible();
    expect(await page.locator('.side-scroll [tabindex="0"]').count()).toBe(1);
    await page.locator('.side .conv', { hasText: 'envelope-v2' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.side .conv', { hasText: 'random' })).toBeFocused();
    await page.keyboard.press('?');
    await expect(page.locator('#shell-keys h2')).toHaveText(['Anywhere', 'Chat']);
    await page.keyboard.press('Escape');

    // Tasks: Ctrl+K leads with boards and tasks; rows are one stop, → reaches the play button.
    await page.locator('#tab-tasks').click();
    await page.locator('#tasks-connect').click();
    await control('device/approve', { userCode: await page.locator('#tasks-user-code').textContent() });
    await expect(page.locator('#tasks-mine .row').first()).toBeVisible({ timeout: 15_000 });
    expect(await page.locator('#tasks-mine [tabindex="0"]').count()).toBe(1);
    await page.locator('#tasks-mine .r-title').first().focus();
    await page.keyboard.press('Control+K');
    await expect(page.locator('#sw-list .opt').first()).toHaveAttribute('data-module', 'tasks');
    await page.keyboard.press('Escape');
    await page.locator('#tasks-mine .r-title').first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tasks-mine .row').first().locator('.k-play')).toBeFocused();
    await page.keyboard.press('F6');
    expect(await area(page)).toBe('titlebar');
  });
}
