import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * 0.14.1 polish, for the owner's review (`P0141_SHOTS` = output folder), light and dark at 900×600 and 400 px wide:
 * the Tasks module on a server without the `tasks` scope family (Beacon before 1.183), the end of a conversation above
 * the status strip, and "You're in" in the Time strip. axe (WCAG 2.2 AA) on every view.
 */
const MOCK = process.env.P0141_MOCK ?? 'http://127.0.0.1:8814';
const OUT = process.env.P0141_SHOTS ?? 'out/p0141-screens';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const SIZES = [
  { name: '900', width: 900, height: 600 },
  { name: '400', width: 400, height: 640 },
] as const;

async function control(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function shot(page: Page, name: string, scheme: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
}

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
}

for (const scheme of ['light', 'dark'] as const) {
  for (const size of SIZES) {
    test(`0.14.1 polish screens (${scheme}, ${size.name})`, async ({ page, context }) => {
      await control('reset', {});
      // A Beacon v1.181 server: scope families `time` and `chat` only (`invalid_scope` for `tasks`).
      await control('config', { deviceInterval: 1, chatOnly: true });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await signIn(page);
      await page.setViewportSize({ width: size.width, height: size.height });
      // Item 3: "You're in" in the Time strip.
      await expect(page.locator('#time-strip-strip')).toBeVisible();
      await axe(page);
      await shot(page, `03-time-welcome-${size.name}`, scheme);
      // Item 1: the rail on a chat-only server (connected at 900 px, where the organization tiles show).
      await page.setViewportSize({ width: 900, height: 600 });
      await page.locator('#tab-chat').click();
      await page.locator('#chat-connect').click();
      await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
      await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
      await page.locator('#notify-later').click();
      await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
      await expect(page.locator('.side .conv', { hasText: 'envelope-v2' })).toBeVisible();
      await page.setViewportSize({ width: size.width, height: size.height });
      await shot(page, `01-chatonly-rail-${size.name}`, scheme);
      // Item 8: the compact window's reduced chat home (400 px).
      if (size.name === '400' && (await page.locator('#chat-home[data-compact="true"]').count()) > 0) {
        await axe(page);
        await shot(page, '08-chat-home-compact-400', scheme);
      }
      // Item 2: the end of a conversation, above the reserved status strip (the compact window opens the list first).
      if ((await page.locator('#chat-home-all').count()) > 0) await page.locator('#chat-home-all').click();
      await page.locator('.side .conv', { hasText: 'envelope-v2' }).click();
      await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
      await page.waitForTimeout(500);
      await axe(page);
      await shot(page, `02-chat-end-${size.name}`, scheme);
      if (size.name === '900') {
        // Item 11: a strip message (offline, one message waiting) at 900×600 and in a tall 1200×780 window.
        await context.setOffline(true);
        await page.locator('#composer').fill('Written on the train');
        await page.locator('#composer').press('Enter');
        await expect(page.locator('#chat-banner')).toBeVisible({ timeout: 20_000 });
        await shot(page, '11-chat-strip-900', scheme);
        await page.setViewportSize({ width: 1200, height: 780 });
        await shot(page, '11-chat-strip-1200', scheme);
        await page.setViewportSize({ width: 900, height: 600 });
        await context.setOffline(false);
        await expect(page.locator('#msg-list li.msg.pending')).toHaveCount(0, { timeout: 20_000 });
      }
      // Item 1 (before): the Tasks tab, then its connect card.
      const tab = page.locator('#tab-tasks');
      if ((await tab.count()) > 0) {
        await tab.click();
        await page.locator('#tasks-connect').click();
        await page.waitForTimeout(800);
        await shot(page, `01-chatonly-tasks-${size.name}`, scheme);
      }
    });
  }
}

test.describe('first run and the setup chip', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  for (const scheme of ['light', 'dark'] as const) {
    for (const size of [{ name: '900', width: 900, height: 600 }, { name: '400', width: 400, height: 640 }] as const) {
      test(`items 9 and 10 (${scheme}, ${size.name})`, async ({ page }) => {
        await control('reset', {});
        await control('config', { deviceInterval: 1 });
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.goto('/');
        await page.locator('#server').fill(MOCK);
        await page.locator('#connect').click();
        await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
        await expect(page.locator('#mod-setup')).toBeVisible({ timeout: 15_000 });
        await page.locator('#setup-connect').click();
        await control('device/approve', { userCode: await page.locator('#setup-code').textContent() });
        // Item 9: Chat approved, the Tasks code is already there (no click).
        await expect(page.locator('#setup-step-tasks #setup-code')).toBeVisible({ timeout: 15_000 });
        await axe(page);
        await shot(page, `09-setup-tasks-auto-${size.name}`, scheme);
        // Item 10: "Later", and the chip in the title bar.
        await page.locator('#setup-later').click();
        // The title bar's chip; the bottom rail's in the compact window.
        await expect(page.locator(size.name === '400' ? '#setup-chip-rail' : '#setup-chip')).toBeVisible();
        await axe(page);
        await shot(page, `10-setup-chip-${size.name}`, scheme);
        if (size.name === '900') {
          await page.setViewportSize({ width: 1200, height: 780 });
          await shot(page, '10-setup-chip-1200', scheme);
        }
      });
    }
  }
});
