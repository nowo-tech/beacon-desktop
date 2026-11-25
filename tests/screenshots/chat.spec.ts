import { expect, test, type Page } from '@playwright/test';

/**
 * Chat (BD-2) screens against the mock API, light and dark, for the owner's review (`CHAT_SHOTS` = output folder):
 * connect card, device flow, conversation list, conversation, thread, reactions, quick switcher, organization switcher
 * (rail and dropdown), settings.
 */
const MOCK = process.env.CHAT_MOCK ?? 'http://127.0.0.1:8797';
const OUT = process.env.CHAT_SHOTS ?? 'out/chat-screens';

async function control(path: string, body?: unknown): Promise<unknown> {
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

async function shot(page: Page, name: string, scheme: 'light' | 'dark') {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`chat screens (${scheme})`, async ({ page }) => {
    await control('reset', {});
    await control('config', { deviceInterval: 1 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await signIn(page);
    await shot(page, '00-time-module', scheme);
    await page.locator('#tab-chat').click();
    await expect(page.locator('#chat-connect')).toBeVisible();
    await shot(page, '01-connect-chat', scheme);
    await page.locator('#chat-connect').click();
    await expect(page.locator('#chat-user-code')).toBeVisible();
    await shot(page, '01-connect-chat-code', scheme);
    const code = await page.locator('#chat-user-code').textContent();
    await control('device/approve', { userCode: code });
    await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('.ctx-tile[aria-label="Lumen Works"]').click();
    await expect(page.locator('.side .conv', { hasText: 'envelope-v2' })).toBeVisible();
    await shot(page, '02-chat-list', scheme);
    await page.locator('.side .conv', { hasText: 'envelope-v2' }).click();
    await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
    await page.locator('#msg-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await shot(page, '03-conversation', scheme);
    await page.locator('.thread-link').first().click();
    await expect(page.locator('#thread .th-root')).toBeVisible();
    await shot(page, '04-thread-panel', scheme);
    const withReactions = page.locator('#msg-list li.msg', { has: page.locator('.reacts') }).first();
    await withReactions.scrollIntoViewIfNeeded();
    await withReactions.screenshot({ path: `${OUT}/05-reactions-${scheme}.png` });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await expect(page.locator('#switcher')).toBeVisible();
    await page.locator('#sw-input').fill('env');
    await shot(page, '06-cmd-k', scheme);
    await page.keyboard.press('Escape');
    await expect(page.locator('.ctx-tile').first()).toBeVisible();
    await shot(page, '07-context-rail', scheme);
    await page.evaluate(() => {
      const shell = (window as unknown as { __timeTrack: { shell: { prefs: { switcher: string }; renderChrome(): void } } }).__timeTrack.shell;
      shell.prefs.switcher = 'dropdown';
      shell.renderChrome();
    });
    await page.locator('#ctx-dropdown').click();
    await shot(page, '07-context-dropdown', scheme);
    await page.keyboard.press('Escape');
    await page.locator('#rail-settings').click();
    await expect(page.locator('#shell-settings')).toBeVisible();
    await shot(page, '08-settings', scheme);
    // Compact density, rail tiles, title bar + sidebar timer, a running timer and the stop-and-switch prompt (Q4).
    await page.locator('#shell-settings [aria-label="Sidebar density"] [data-value="compact"]').click();
    await page.locator('#shell-settings [aria-label="Organization switcher"] [data-value="tiles"]').click();
    await page.locator('#shell-settings [aria-label="Running timer"] [data-value="title-sidebar"]').click();
    await page.keyboard.press('Escape');
    await page.locator('#tab-time').click();
    await page.locator('[data-task="T-104"] .row-action').click();
    await expect(page.locator('#timer-task')).toBeVisible();
    await page.locator('#tab-chat').click();
    await expect(page.locator('#side-timer')).toBeVisible();
    await shot(page, '09-compact-density-sidebar-timer', scheme);
    await page.locator('.ctx-tile[aria-label="Harbor Studio"]').click();
    await expect(page.locator('#shell-confirm')).toBeVisible();
    await shot(page, '07-stop-and-switch', scheme);
    await page.locator('#confirm-stop-switch').click();
    await expect(page.locator('.side .conv', { hasText: 'studio' })).toBeVisible();
    await page.setViewportSize({ width: 400, height: 640 });
    await shot(page, '10-compact-window-list', scheme);
    await page.locator('.side .conv', { hasText: 'studio' }).click();
    await shot(page, '10-compact-window-conversation', scheme);
  });
}
