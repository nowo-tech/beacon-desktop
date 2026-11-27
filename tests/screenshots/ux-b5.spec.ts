import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * UX batch 5, chat polish, for the owner's review (`UXB5_SHOTS` = output folder): the chat home view, the offline send
 * queue, the reaction picker in the toolbar's place, "(edited)" inline, neutral skeletons, the composer's scroll shadow,
 * person-based DM avatars and the connect card copy. Light and dark at 1280×800, narrow 900×600 where the layout
 * changes, Spanish for the home view. axe (WCAG 2.1 AA) on every view.
 */
const MOCK = process.env.UXB5_MOCK ?? 'http://127.0.0.1:8805';
const OUT = process.env.UXB5_SHOTS ?? 'out/uxb5-screens';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const ORG2 = 'org:7b1f2a9f-2c3d-4e4f-9a01-b2c3d4e5f6a7';

async function control(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function shot(page: Page, name: string, scheme: string, narrow = false) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}${narrow ? '-narrow' : ''}-${scheme}.png` });
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
  await page.locator('#tab-chat').click();
}

async function connect(page: Page) {
  await page.locator('#chat-connect').click();
  await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
  await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('#notify-later').click();
  await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
  await expect(page.locator('.side .conv', { hasText: 'envelope-v2' })).toBeVisible();
}

for (const scheme of ['light', 'dark'] as const) {
  for (const narrow of [false, true]) {
    test(`chat polish screens (${scheme}${narrow ? ', narrow' : ''})`, async ({ page, context }) => {
      await control('reset', {});
      await control('config', { deviceInterval: 1 });
      if (narrow) await page.setViewportSize({ width: 900, height: 600 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await signIn(page);
      await expect(page.locator('#chat-connect-card')).toBeVisible();
      await axe(page);
      await shot(page, '10-chat-connect', scheme, narrow);
      await connect(page);
      // Home: the newest pages of unread conversations load once, then mentions show.
      await expect(page.locator('#chat-home h1')).toHaveText('Home');
      await page.locator('.side .conv', { hasText: 'envelope-v2' }).click();
      await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
      await page.locator('#chat-home-link').click();
      await expect(page.locator('#chat-home .hm-row.mention')).toBeVisible();
      await axe(page);
      await shot(page, '12-chat-home', scheme, narrow);
      // A direct message: the sidebar avatar and the messages use the person's initials and colour.
      await page.locator('.side .conv', { hasText: 'Maya Okafor' }).click();
      await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
      await shot(page, '14-chat-dm', scheme, narrow);
      // Thread with an edited reply: "(edited)" inline.
      await page.locator('.side .conv', { hasText: 'envelope-v2' }).click();
      await page.locator('.thread-link').first().click();
      await expect(page.locator('#thread .edited')).toBeVisible();
      await shot(page, '15-chat-thread', scheme, narrow);
      await page.keyboard.press('Escape');
      // The reaction picker in the toolbar's place.
      const root = page.locator('#msg-list li.msg', { has: page.locator('.thread-link') }).first();
      await root.scrollIntoViewIfNeeded();
      await root.hover();
      await root.locator('.m-actions [aria-haspopup="menu"]').first().click();
      await expect(page.locator('.emoji-menu')).toBeVisible();
      await axe(page);
      await shot(page, '17-chat-reaction-picker', scheme, narrow);
      await page.keyboard.press('Escape');
      // The composer scrolled: a shadow under its toolbar.
      await page.locator('#composer').fill(`Benchmarks are back to normal after the **UTF-8 fix**.\nRunner numbers in \`envelope/parse\`.\n${'Notes '.repeat(600)}`);
      await page.locator('#composer').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });
      await shot(page, '18-chat-composer-long', scheme, narrow);
      await page.locator('#composer').fill('');
      // Offline: two messages wait in order.
      await context.setOffline(true);
      await page.locator('#composer').fill('Written on the train');
      await page.locator('#composer').press('Enter');
      await page.locator('#composer').fill('And a second thought');
      await page.locator('#composer').press('Enter');
      await expect(page.locator('#msg-list li.msg.pending.queued')).toHaveCount(2);
      await page.locator('#composer').blur();
      await axe(page);
      await shot(page, '25-chat-offline-send', scheme, narrow);
      await context.setOffline(false);
      await expect(page.locator('#msg-list li.msg.pending')).toHaveCount(0, { timeout: 20_000 });
      // Skeletons while a conversation loads (rate limited for a moment): neutral blocks.
      await control('config', { chatFailNext: { status: 429, error: 'rate_limited', retryAfter: 30 } });
      await page.locator('.side .conv', { hasText: 'Leo Brandt' }).first().click();
      await page.waitForTimeout(800);
      await shot(page, '26-chat-skeleton', scheme, narrow);
    });
  }
}

test.describe('Spanish', () => {
  test.use({ locale: 'es-ES' });
  test('chat home in Spanish: with unread, then all caught up (light and dark)', async ({ page }) => {
    await control('reset', {});
    await control('config', { deviceInterval: 1 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await signIn(page);
    await connect(page);
    await expect(page.locator('#chat-home h1')).toHaveText('Inicio');
    await shot(page, '12-chat-home-es', 'light');
    await page.locator(`.ctx-tile[data-context="${ORG2}"]`).click();
    await page.locator('.side .conv').first().click();
    await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
    await page.locator('#chat-home-link').click();
    await expect(page.locator('.hm-calm')).toBeVisible();
    await axe(page);
    await shot(page, '12-chat-home-caught-up-es', 'light');
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await shot(page, '12-chat-home-caught-up-es', 'dark');
  });
});
