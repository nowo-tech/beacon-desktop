import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/**
 * 0.14.1 in a real browser: the Tasks module hidden up front on a chat-only Beacon (v1.181: scope families `time` and
 * `chat`), the tasks server logout, the chat strip reserved only in tall windows (900×600 overlays above the message
 * box, 1200×780 keeps the band; nothing moves when it shows), the compact window's reduced chat home and the
 * "Finish setup" chip. Light and dark where it draws something new; axe clean.
 */
const MOCK = 'http://127.0.0.1:8787';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
}

async function connectChat(page: Page) {
  await page.locator('#tab-chat').click();
  await page.locator('#chat-connect').click();
  await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
  await expect(page.locator('.side .conv').first()).toBeAttached({ timeout: 15_000 });
}

/** One round trip: an element's box now (`null` when it is not there). */
const box = (page: Page, selector: string) =>
  page.evaluate((query) => {
    const element = document.querySelector(query);
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
  }, selector);

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
});

test.describe('a Beacon without tasks (chat-only)', () => {
  test.use({ viewport: { width: 900, height: 600 } });

  test('no Tasks tab, Ctrl+2 is Time, Settings says why; the explanation stays a fallback', async ({ page }) => {
    await control('config', { chatOnly: true });
    await signIn(page);
    await expect(page.locator('.rail-tab[role="tab"]')).toHaveCount(2);
    await expect(page.locator('#tab-tasks')).toHaveCount(0);
    await page.locator('#tab-chat').click();
    await page.keyboard.press('Control+2');
    await expect(page.locator('#mod-time')).toBeVisible();
    await expect(page.locator('#tab-time')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+,');
    await page.locator('#settings-tab-account').click();
    await expect(page.locator('#account-tasks')).toContainText('Not available on this Beacon server yet.');
    await expect(page.locator('#account-tasks-connect')).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('tasks server logout (TaskBoard 3.7.0)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Disconnect tasks revokes the token on the server first', async ({ page }) => {
    await signIn(page);
    await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
    await page.locator('#tab-tasks').click();
    await page.locator('#tasks-connect').click();
    await control('device/approve', { userCode: await page.locator('#tasks-user-code').textContent() });
    await expect(page.locator('#tasks-mine .row').first()).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Control+,');
    await page.locator('#settings-tab-account').click();
    await page.locator('#tasks-disconnect').click();
    await page.locator('#confirm-ok').click();
    await expect(page.locator('#account-tasks-connect')).toBeVisible();
    expect(((await control('tasks/state')) as { logouts: unknown[] }).logouts).toEqual([{ mode: 'ok', known: true }]);
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`chat strip: overlays above the message box at 900×600, reserved at 1200×780, nothing moves (${scheme})`, async ({ page, context }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await signIn(page);
    await connectChat(page);
    await page.locator('#notify-later').click();
    await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
    await page.locator('.side .conv', { hasText: 'envelope-v2' }).click();
    await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
    // 900×600: no band under the header.
    await expect(page.locator('#chat-banner-strip')).toHaveAttribute('data-mode', 'overlay');
    const scrollerBefore = await box(page, '#msg-scroll');
    const headBottom = (await box(page, '.ch-head'))?.bottom ?? 0;
    expect((scrollerBefore?.top ?? 0) - headBottom).toBeLessThanOrEqual(1);
    // A message (offline, one waiting): over the timeline, above the message box; the timeline did not move or shrink.
    await context.setOffline(true);
    await page.locator('#composer').fill('Written on the train');
    await page.locator('#composer').press('Enter');
    await expect(page.locator('#chat-banner')).toBeVisible({ timeout: 20_000 });
    const strip = await box(page, '#chat-banner-strip');
    const foot = await box(page, '#chat-foot');
    expect(await box(page, '#msg-scroll')).toEqual(scrollerBefore);
    expect(strip?.bottom ?? 0).toBeLessThanOrEqual((foot?.top ?? 0) + 1);
    // The newest message scrolls fully above the strip.
    await page.locator('#msg-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    const last = await box(page, '#msg-list li.msg:last-of-type');
    expect(last?.bottom ?? 0).toBeLessThanOrEqual((strip?.top ?? 0) + 1);
    expect(await axe(page)).toEqual([]);
    // Resized past the threshold while it shows: no jump (the mode waits).
    await page.setViewportSize({ width: 1200, height: 780 });
    await expect(page.locator('#chat-banner-strip')).toHaveAttribute('data-mode', 'overlay');
    await context.setOffline(false);
    await expect(page.locator('#msg-list li.msg.pending')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('#chat-banner')).toBeHidden({ timeout: 20_000 });
    // Gone: the tall window's band now, reserved before anything shows.
    await expect(page.locator('#chat-banner-strip')).toHaveAttribute('data-mode', 'reserved');
    const tallBefore = await box(page, '#msg-scroll');
    expect((await box(page, '#chat-banner-strip'))?.height).toBe(36);
    await context.setOffline(true);
    await page.locator('#composer').fill('Again offline');
    await page.locator('#composer').press('Enter');
    await expect(page.locator('#chat-banner')).toBeVisible({ timeout: 20_000 });
    expect(await box(page, '#msg-scroll')).toEqual(tallBefore);
    await context.setOffline(false);
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`compact window: the reduced chat home, keyboard first; All conversations opens the list (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 900, height: 600 });
    await signIn(page);
    await connectChat(page);
    await page.locator('#notify-later').click();
    await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
    await expect(page.locator('.side .conv', { hasText: 'envelope-v2' })).toBeVisible();
    await page.setViewportSize({ width: 400, height: 640 });
    await expect(page.locator('#chat-home')).toBeVisible();
    await expect(page.locator('#chat-home')).toHaveAttribute('data-compact', 'true');
    await expect(page.locator('.side')).toBeHidden();
    await expect(page.locator('#chat-home .hm-sec > h2').first()).toHaveId('hm-unread');
    expect(await axe(page)).toEqual([]);
    // Keyboard: the rows are one Tab stop; Enter opens; Esc comes back home.
    await page.locator('#chat-home .hm-row[tabindex="0"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#chat-home')).toBeVisible();
    await page.locator('#chat-home-all').click();
    await expect(page.locator('.side')).toBeVisible();
    await expect(page.locator('#chat-home')).toBeHidden();
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`"Finish setup" chip in the title bar: opens the pending step, × hides it (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1200, height: 780 });
    await signIn(page);
    const chip = page.locator('#setup-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('Finish setup');
    expect(await axe(page)).toEqual([]);
    // Nothing in the title bar moves when it goes: it sits after the organization, the search stays centred.
    const search = await box(page, '#tb-search');
    await chip.click();
    await expect(page.locator('#mod-setup')).toBeVisible();
    await expect(page.locator('#setup-step-chat')).toHaveAttribute('aria-current', 'step');
    await page.locator('#setup-later').click();
    await page.locator('#setup-chip-dismiss').click();
    await expect(chip).toHaveCount(0);
    expect(await box(page, '#tb-search')).toEqual(search);
    await expect(page.locator('#tb-search')).toBeFocused();
  });
}
