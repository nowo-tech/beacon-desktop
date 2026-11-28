import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/**
 * 0.12.1: both device-code screens show the approval page as selectable text with "Copy link" next to the code and the
 * "browser where you are signed in" hint under it; Connect chat says why it could not start (401, 429).
 * Screenshots for review: `DEVICE_LINK_SHOTS=<dir>` (light and dark, the copy button and the copied state).
 */
const MOCK = 'http://127.0.0.1:8787';
const SHOTS = process.env.DEVICE_LINK_SHOTS ?? '';
type Tt = { __timeTrack: { hooks: { copied: string[] } } };

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function shot(page: Page, name: string) {
  if (SHOTS === '') return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled', caret: 'hide' });
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.copied);

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`time and chat device screens: page, Copy link, hint (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.goto('/');
    await page.locator('#server').fill(MOCK);
    await page.locator('#connect').click();
    await expect(page.locator('#user-code')).toBeVisible();
    const url = (await page.locator('#device-url').textContent()) ?? '';
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/device/);
    await expect(page.locator('#device-browser-hint')).toHaveText('Open it in the browser where you are signed in to Beacon.');
    // Selectable: a triple click selects the address.
    await page.locator('#device-url').click({ clickCount: 3 });
    expect(await page.evaluate(() => getSelection()?.toString().trim())).toBe(url);
    await page.evaluate(() => getSelection()?.removeAllRanges());
    expect(await axe(page)).toEqual([]);
    await shot(page, `time-device-link-${scheme}`);
    await page.locator('#copy-device-link').click();
    await expect(page.locator('#status')).toContainText('Link copied.');
    expect((await copied(page)).at(-1)).toBe(url);
    await shot(page, `time-device-link-copied-${scheme}`);
    await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
    await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });

    await page.setViewportSize({ width: 1024, height: 700 });
    await page.locator('#tab-chat').click();
    await page.locator('#chat-connect').click();
    await expect(page.locator('#chat-user-code')).toBeVisible();
    const chatUrl = (await page.locator('#chat-url').textContent()) ?? '';
    expect(chatUrl).toMatch(/^http:\/\/127\.0\.0\.1:8787\/device/);
    await expect(page.locator('#chat-browser-hint')).toHaveText('Open it in the browser where you are signed in to Beacon.');
    expect(await axe(page)).toEqual([]);
    await shot(page, `chat-device-link-${scheme}`);
    await page.locator('#chat-copy-link').click();
    await expect(page.locator('#chat-link-copied')).toHaveText('Link copied');
    await expect(page.locator('#chat-link-copied')).toHaveAttribute('aria-live', 'polite');
    expect((await copied(page)).at(-1)).toBe(chatUrl);
    expect(await axe(page)).toEqual([]);
    await shot(page, `chat-device-link-copied-${scheme}`);
  });
}

test('Connect chat: 429 with the wait, 401 with "Connect time tracking again"', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
  await page.locator('#tab-chat').click();
  await control('config', { failNext: { status: 429, error: 'rate_limited', retryAfter: 30 } });
  await page.locator('#chat-connect').click();
  await expect(page.locator('.cc-error')).toHaveText('Too many attempts. Wait 30 s and try again.');
  await control('config', { failNext: { status: 401, error: 'invalid_token' } });
  await page.locator('#chat-connect').click();
  await expect(page.locator('.cc-error')).toHaveText('Your time tracking session expired. Connect it again, then connect chat.');
  await expect(page.locator('#chat-connect')).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
  await shot(page, 'chat-connect-session-expired-light');
  await page.locator('#chat-reconnect-time').click();
  await expect(page.locator('#server')).toBeVisible();
});

test('Spanish: the hint and Copiar enlace', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 400, height: 640 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await expect(page.locator('#device-browser-hint')).toHaveText('Ábrelo en el navegador donde tienes la sesión de Beacon.');
  await expect(page.locator('#copy-device-link')).toContainText('Copiar enlace');
  await shot(page, 'time-device-link-light-es');
  await context.close();
});
