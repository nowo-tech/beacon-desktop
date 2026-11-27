import { expect, test, type Page } from '@playwright/test';
import { app, control, OUT, reset, shot, signIn } from './helpers';

/**
 * Manual screenshots for 0.11 / 0.12 (`pnpm screenshots`): chat (conversation list, message box, thread, reactions),
 * the organization switcher and the switch with a running timer, the required-fields dialog and the mini timer, in
 * the light and the dark theme. Full-view window (1024 × 640); the placeholder Beacon and data of `helpers.ts`.
 */
test.use({ viewport: { width: 1024, height: 640 } });
test.beforeEach(reset);

const LUMEN = '.ctx-tile[title="Lumen Works"]';
const HARBOR = '.ctx-tile[title="Harbor Studio"]';

/** Like `shot`, without blurring first: a menu or picker that closes when it loses focus stays open. */
async function shotOpen(page: Page, name: string): Promise<void> {
  const text = (await page.locator('body').innerText()) + (await page.locator('body').evaluate((el) => el.outerHTML));
  for (const leak of ['127.0.0.1', 'localhost', 'Ada', 'ada@', 'Acme']) expect(text, `${name} shows "${leak}"`).not.toContain(leak);
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled', caret: 'hide' });
}

async function connectChat(page: Page): Promise<void> {
  await page.locator('#tab-chat').click();
  await page.locator('#chat-connect').click();
  await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
  await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
  await page.locator(LUMEN).click();
  await expect(page.locator('.side .conv', { hasText: 'envelope-v2' })).toBeVisible();
}

async function openConversation(page: Page, title: string): Promise<void> {
  await page.locator('.side .conv', { hasText: title }).first().click();
  await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
  await page.locator('#msg-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
}

async function startTask(page: Page, id: string): Promise<void> {
  await page.locator('#tab-time').click();
  await page.locator(`[data-task="${id}"] .row-action`).click();
  await expect(page.locator('#timer-pill.running')).toBeVisible();
  // A timer that has run for a while (1:25), as in the other screenshots.
  await control('timer/backdate', { seconds: 85 * 60 });
  await app(page).refresh();
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.beforeEach(({ page }) => page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' }));

    test(`desktop-chat-*-${scheme}`, async ({ page }) => {
      test.setTimeout(120_000);
      await signIn(page);
      await connectChat(page);
      await shot(page, `desktop-chat-list-${scheme}`);
      await openConversation(page, 'envelope-v2');
      await page.locator('#composer').fill('Deploy window confirmed for **16:00**. Benchmarks are in `envelope/parse`.');
      await shot(page, `desktop-chat-composer-${scheme}`);
      await page.locator('#composer').fill('');
      await page.locator('.thread-link').first().click();
      await expect(page.locator('#thread .th-root')).toBeVisible();
      await page.locator('#thread-composer').fill('Reproduced with the 4-byte fixtures, the fix is up.');
      await shot(page, `desktop-chat-thread-${scheme}`);
      await page.locator('#thread-composer').fill('');
      await page.keyboard.press('Escape');
      await expect(page.locator('#thread .th-root')).toBeHidden();
      const withReactions = page.locator('#msg-list li.msg', { has: page.locator('.reacts') }).first();
      await withReactions.scrollIntoViewIfNeeded();
      await withReactions.focus();
      await page.keyboard.press('e');
      await expect(page.locator('.emoji-menu')).toBeVisible();
      await shotOpen(page, `desktop-chat-reactions-${scheme}`);
      await page.keyboard.press('Escape');
      // The organization switcher as a title-bar dropdown (Settings → Organization switcher).
      await page.locator('#rail-settings').click();
      await page.locator('#shell-settings [aria-label="Organization switcher"] [data-value="dropdown"]').click();
      await page.keyboard.press('Escape');
      await page.locator('#ctx-dropdown').click();
      await expect(page.locator('[role="menu"]').first()).toBeVisible();
      await page.waitForTimeout(250);
      await shotOpen(page, `desktop-org-switcher-${scheme}`);
    });

    test(`desktop-org-switch-timer-${scheme}`, async ({ page }) => {
      // Organizations from the time API (TimeTrackBundle 2.2 contexts), no field required.
      await control('config', { contextPolicy: { required: false, refuse: [] } });
      await signIn(page);
      await page.locator(LUMEN).click();
      await expect(page.locator('.tb-ctx', { hasText: 'Lumen Works' })).toBeVisible();
      await startTask(page, 'T-104');
      await page.locator(HARBOR).click();
      await expect(page.locator('#shell-confirm')).toBeVisible();
      await shot(page, `desktop-org-switch-timer-${scheme}`);
    });

    test(`desktop-required-fields-${scheme}`, async ({ page }) => {
      await control('config', { allocation: { requireActivityType: true }, contextPolicy: { required: true, refuse: [] } });
      await signIn(page);
      await page.locator(LUMEN).click();
      await expect(page.locator('.tb-ctx', { hasText: 'Lumen Works' })).toBeVisible();
      await startTask(page, 'T-104');
      await page.locator('#timer-pill .tp-act.stop').click();
      await expect(page.locator('#alloc-dialog')).toBeVisible();
      await expect(page.locator('#alloc-activity')).toBeEnabled();
      await page.locator('#alloc-activity').selectOption('review');
      await shot(page, `desktop-required-fields-${scheme}`);
    });

    test(`desktop-mini-timer-${scheme}`, async ({ page }) => {
      await control('config', { contextPolicy: { required: false, refuse: [] } });
      await signIn(page);
      await page.locator(LUMEN).click();
      await startTask(page, 'T-104');
      await page.locator('#tb-mini').click();
      await expect(page.locator('#tb-mini[aria-pressed="true"]')).toBeVisible();
      const view = await page.evaluate(() => (window as unknown as { __timeTrack: { hooks: { mini: unknown } } }).__timeTrack.hooks.mini);
      expect(view).toMatchObject({ running: true });
      const mini = await page.context().newPage();
      await mini.setViewportSize({ width: 312, height: 132 });
      await mini.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await mini.addInitScript((value) => {
        (window as unknown as { __timeTrackMini: unknown }).__timeTrackMini = { view: value, actions: [] };
      }, view);
      await mini.goto('/?window=mini');
      await expect(mini.locator('#mini-time')).toBeVisible();
      await shot(mini, `desktop-mini-timer-${scheme}`);
      await mini.close();
    });
  });
}
