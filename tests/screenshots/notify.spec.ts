import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * BD-3b chat notifications (level None), for the owner's review (`NOTIFY_SHOTS` = output folder): the opt-in card on
 * the first Chat visit, Settings → Chat with notifications on and paused, and the tray menu's chat items (as data: the
 * tray is native). The notification itself is the OS's: its text is checked, not pictured. axe on every view.
 */
const MOCK = process.env.NOTIFY_MOCK ?? 'http://127.0.0.1:8801';
const OUT = process.env.NOTIFY_SHOTS ?? 'out/notify-screens';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const MAYA = '0c000000-0000-4000-8000-000000000006';

type Hooks = { notificationPermission: string; friendly: unknown[]; trayMenu: { chat?: { id: string; label: string }[] } | null };

async function control(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function shot(page: Page, name: string, scheme: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
}

async function axe(page: Page, include: string) {
  const result = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function connect(page: Page) {
  await page.goto('/');
  await page.evaluate(() => ((window as unknown as { __timeTrack: { hooks: Hooks } }).__timeTrack.hooks.notificationPermission = 'prompt'));
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('#tab-chat').click();
  await page.locator('#chat-connect').click();
  await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
  await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
  await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
  await page.locator('.side .conv', { hasText: 'envelope-v2' }).click();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`notification screens (${scheme})`, async ({ page }) => {
    await control('reset', {});
    await control('config', { deviceInterval: 1 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await connect(page);
    await expect(page.locator('#chat-ask .notif-ask')).toBeVisible();
    await axe(page, '#chat-ask');
    await shot(page, '01-notify-opt-in', scheme);
    await page.locator('#notify-on').click();
    await expect(page.locator('#chat-ask')).toBeHidden();
    // A message elsewhere: one notification, level None.
    await control('chat/post', { conversation: MAYA, author: 'maya', text: 'Pairing at 11:30?' });
    await page.evaluate((maya) => (window as unknown as { __timeTrack: { hooks: { chatHint(hint: unknown): void } } }).__timeTrack.hooks.chatHint({ kind: 'message', conversationUuid: maya, messageId: 99999 }), MAYA);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __timeTrack: { hooks: Hooks } }).__timeTrack.hooks.friendly)).toEqual([{ title: 'Beacon Desktop', body: 'New message in Beacon', pose: null, click: `chat-open:${MAYA}` }]);
    await page.locator('#rail-settings').click();
    await expect(page.locator('#notify-level')).toBeVisible();
    await axe(page, '#shell-settings');
    await shot(page, '02-settings-notifications', scheme);
    await page.locator('#notify-pause-hour').click();
    await expect(page.locator('#notify-resume')).toBeVisible();
    await shot(page, '03-settings-paused', scheme);
    const tray = await page.evaluate(() => (window as unknown as { __timeTrack: { hooks: Hooks } }).__timeTrack.hooks.trayMenu?.chat);
    expect(tray?.map((item) => item.id)).toEqual(['open-chat', 'resume-chat']);
  });
}

test('notification opt-in in Spanish (light)', async ({ browser }) => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
  const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 800 }, colorScheme: 'light', reducedMotion: 'reduce', timezoneId: 'Europe/Madrid' });
  const page = await context.newPage();
  await connect(page);
  await expect(page.locator('#chat-ask .notif-ask')).toBeVisible();
  await shot(page, '01-notify-opt-in', 'light-es');
  await context.close();
});
