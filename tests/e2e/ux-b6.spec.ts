import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/**
 * UX batch 6 in the real UI on the fake platform: the guided first run (UXA-4) from an empty storage, the one Settings
 * with Account and the disconnect confirmation (UXA-2), and Time in the shell's grammar (UXA-1, UXA-24).
 */
const MOCK = 'http://127.0.0.1:8787';

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
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
});

test.describe('first run', () => {
  // A first launch: nothing stored.
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the setup card chains Chat and Tasks, then lands on Chat — ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page);
      const card = page.locator('#mod-setup');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#mod-time')).toBeHidden();
      await expect(page.locator('#setup-connect')).toBeFocused();
      await expect(page.locator('#setup-step-chat')).toHaveAttribute('aria-current', 'step');
      expect(await axe(page), `${scheme} setup`).toEqual([]);
      await page.locator('#setup-connect').click();
      await expect(page.locator('#setup-code')).toBeVisible();
      expect(await axe(page), `${scheme} setup code`).toEqual([]);
      await control('device/approve', { userCode: await page.locator('#setup-code').textContent() });
      await expect(page.locator('#setup-step-tasks')).toHaveAttribute('aria-current', 'step');
      await expect(page.locator('#setup-step-chat')).toHaveClass(/done/);
      // 0.14.1: the Tasks code is asked for as soon as Chat is approved (no click).
      await expect(page.locator('#setup-step-tasks #setup-code')).toBeVisible();
      await control('device/approve', { userCode: await page.locator('#setup-code').textContent() });
      await expect(card).toBeHidden();
      await expect(page.locator('#mod-chat')).toBeVisible();
      await expect(page.locator('#tab-chat')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.side .conv').first()).toBeVisible();
      // The next launch follows the landing rule: Chat again (the last module), no setup.
      const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('beacon-desktop-shell') ?? '{}'));
      expect(prefs).toMatchObject({ setup: 'done', module: 'chat' });
    });
  }

  // 0.14.2: the Chat approval arrives while the person is in the browser; Rust refuses a connect started then.
  test('the chained Tasks step waits for the window to come back', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#mod-setup')).toBeVisible({ timeout: 15_000 });
    // The tasks offer probe has answered (the mock offers tasks).
    await expect.poll(() => page.evaluate(() => localStorage.getItem('beacon-desktop-tasks-offer') ?? '')).toContain('true');
    await page.locator('#setup-connect').click();
    await expect(page.locator('#setup-code')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __away: boolean }).__away = true;
      document.hasFocus = () => !(window as unknown as { __away: boolean }).__away;
    });
    await control('device/approve', { userCode: await page.locator('#setup-code').textContent() });
    await expect(page.locator('#setup-step-tasks')).toHaveAttribute('aria-current', 'step');
    await page.waitForTimeout(500);
    await expect(page.locator('#setup-code')).toHaveCount(0);
    await expect(page.locator('#setup-step-tasks .cc-error')).toHaveCount(0);
    await page.evaluate(() => {
      (window as unknown as { __away: boolean }).__away = false;
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('#setup-step-tasks #setup-code')).toBeVisible();
  });

  test('nobody at the app: "come back and press Connect", and Connect works again', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#mod-setup')).toBeVisible({ timeout: 15_000 });
    type Tt = { __timeTrack: { hooks: { connectAway: boolean } } };
    await page.evaluate(() => void ((window as unknown as Tt).__timeTrack.hooks.connectAway = true));
    await page.locator('#setup-connect').click();
    await expect(page.locator('#setup-step-chat .cc-error')).toHaveText('Come back to Beacon Desktop and press Connect to continue.');
    await expect(page.locator('#setup-connect')).toBeEnabled();
    await page.evaluate(() => void ((window as unknown as Tt).__timeTrack.hooks.connectAway = false));
    await page.locator('#setup-connect').click();
    await expect(page.locator('#setup-code')).toBeVisible();
  });

  test('skip, finish later, and the rail leaves the setup without a layout shift', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#mod-setup')).toBeVisible({ timeout: 15_000 });
    const card = await page.locator('.setup-card').boundingBox();
    await page.locator('#setup-skip').click();
    await expect(page.locator('#setup-step-chat')).toHaveClass(/skipped/);
    await expect(page.locator('#setup-step-tasks')).toHaveAttribute('aria-current', 'step');
    expect((await page.locator('.setup-card').boundingBox())?.y).toBe(card?.y);
    await page.locator('#setup-later').click();
    await expect(page.locator('#mod-setup')).toBeHidden();
    await expect(page.locator('#mod-chat')).toBeVisible();
    await expect(page.locator('#chat-connect')).toBeVisible();
  });
});

test.describe('one Settings and Time in the shell', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Account: Disconnect asks first; Escape keeps the connection; Time has no header or toggle', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
    await expect(page.locator('#app > .bar')).toBeHidden();
    await expect(page.locator('#layout-toggle')).toHaveCount(0);
    await expect(page.locator('#nav-tasks')).toHaveText('Track');
    // One quiet play icon per row, visible on hover.
    const play = page.locator('#tasks li').first().locator('.row-action');
    expect(await play.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await page.locator('#tasks li').first().hover();
    await expect.poll(() => play.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    // Connect chat, then disconnect it from Account.
    await page.locator('#tab-chat').click();
    await page.locator('#chat-connect').click();
    await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
    await expect(page.locator('.side .conv').first()).toBeVisible();
    await page.keyboard.press('Control+,');
    await expect(page.locator('#shell-settings')).toBeVisible();
    await page.locator('#settings-tab-account').click();
    expect(await axe(page), 'account').toEqual([]);
    await page.locator('#chat-disconnect').click();
    await expect(page.locator('#shell-confirm')).toBeVisible();
    await expect(page.locator('#confirm-cancel')).toBeFocused();
    expect(await axe(page), 'confirm').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#shell-confirm')).toBeHidden();
    await expect(page.locator('#account-chat .conn-state.on')).toBeVisible();
    await page.locator('#chat-disconnect').click();
    await page.locator('#confirm-ok').click();
    await expect(page.locator('#account-chat-connect')).toBeVisible();
    await expect(page.locator('#account-time .conn-state.on')).toBeVisible();
  });
});
