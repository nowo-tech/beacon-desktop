import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * BD-3b chat writes against the mock API, light and dark, for the owner's review (`BD3B_SHOTS` = output folder): the
 * message box (empty, with text and the counter), a message being sent, a failed and a refused send, the hover
 * toolbar, the reaction picker, a thread reply, the notes where there is no box (read-only conversation, read-only
 * token), the shortcut sheet and the compact window. Every new surface is checked with axe (WCAG 2.1 AA).
 */
const MOCK = process.env.BD3B_MOCK ?? 'http://127.0.0.1:8799';
const OUT = process.env.BD3B_SHOTS ?? 'out/bd3b-screens';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';

async function control(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function shot(page: Page, name: string, scheme: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
}

async function axe(page: Page, include = 'body') {
  const result = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function connect(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('#tab-chat').click();
  await page.locator('#chat-connect').click();
  await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
  await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
  await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
}

async function open(page: Page, title: string) {
  await page.locator('.side .conv', { hasText: title }).first().click();
  await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
  await page.locator('#msg-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
}

for (const scheme of ['light', 'dark'] as const) {
  test(`BD-3b screens (${scheme})`, async ({ page }) => {
    await control('reset', {});
    await control('config', { deviceInterval: 1 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await connect(page);
    await open(page, 'envelope-v2');
    // 01 the conversation with its message box.
    await axe(page);
    await shot(page, '01-composer', scheme);
    // 02 typing, formatted, near the limit (counter).
    await page.locator('#composer').focus();
    await page.locator('#composer').fill(`Benchmarks are back to normal after the **UTF-8 fix**.\nRunner numbers in \`envelope/parse\`.\n${'Notes '.repeat(590)}`);
    await axe(page, '#chat-foot');
    await shot(page, '02-composer-typing', scheme);
    await page.locator('#composer').fill('Benchmarks are back to normal after the **UTF-8 fix**. Thanks @Sofía!');
    // 03 a message on its way (slow server).
    await control('config', { latencyMs: 4000 });
    await page.keyboard.press('Enter');
    await expect(page.locator('#msg-list li.msg.pending.sending')).toBeVisible();
    await shot(page, '03-message-sending', scheme);
    await expect(page.locator('#msg-list li.msg.pending')).toHaveCount(0, { timeout: 15_000 });
    await control('config', { latencyMs: 0 });
    // 04 a send that could not get through: Retry (same key) and Discard.
    await control('config', { chatFailNext: { status: 503, error: 'server_error' } });
    await page.locator('#composer').fill('Deploy window confirmed for 16:00.');
    await page.keyboard.press('Enter');
    await expect(page.locator('#msg-list li.msg.pending.failed')).toBeVisible();
    await axe(page, '#msg-list');
    await shot(page, '04-message-failed', scheme);
    await page.locator('#msg-list li.msg.pending.failed').getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('#msg-list li.msg.pending')).toHaveCount(0);
    // 05 a refusal: Edit and Discard.
    await control('config', { chatFailNext: { status: 403, error: 'read_only' } });
    await page.locator('#composer').fill('One more thing about the rollback.');
    await page.keyboard.press('Enter');
    await expect(page.locator('#msg-list li.msg.pending.failed')).toBeVisible();
    await shot(page, '05-message-refused', scheme);
    await page.locator('#msg-list li.msg.pending.failed').getByRole('button', { name: 'Discard' }).click();
    // 06 the hover toolbar and the reaction toggles.
    const root = page.locator('#msg-list li.msg', { has: page.locator('.thread-link') }).first();
    await root.scrollIntoViewIfNeeded();
    // The row at the very top: the toolbar goes inside it (never cut off under the header).
    await root.evaluate((el) => {
      const box = el.closest('.msgs') as HTMLElement;
      box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    });
    await page.mouse.move(0, 0);
    await root.hover();
    await expect(root.locator('.m-actions')).toBeVisible();
    await axe(page, '#msg-list');
    await shot(page, '06-message-toolbar', scheme);
    // 07 the reaction picker (E).
    await root.focus();
    await page.keyboard.press('e');
    await expect(page.locator('.emoji-menu')).toBeVisible();
    await axe(page, '.emoji-menu');
    await shot(page, '07-reaction-picker', scheme);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(root.locator('.react[aria-pressed="true"]', { hasText: '✅' })).toBeVisible();
    // 08 replying in the thread (R).
    await root.focus();
    await page.keyboard.press('r');
    await expect(page.locator('#thread-composer')).toBeFocused();
    await page.keyboard.type('Reproduced with the 4-byte fixtures, fix is up.');
    await page.keyboard.press('Enter');
    await expect(page.locator('#thread .msgs li.msg').last()).toContainText('fix is up');
    await page.locator('#thread-composer').fill('Will watch the runner tonight.');
    await axe(page, '#thread');
    await shot(page, '08-thread-reply', scheme);
    await page.locator('#thread-composer').fill('');
    await page.keyboard.press('Escape');
    // 09 a read-only conversation.
    await open(page, 'incidents');
    await expect(page.locator('#chat-foot .readonly-note')).toBeVisible();
    await axe(page, '#chat-foot');
    await shot(page, '09-read-only-conversation', scheme);
    // 10 the shortcut sheet (new keys: R, E, C, Enter / Shift+Enter).
    await page.locator('#msg-scroll').focus();
    await page.keyboard.press('?');
    await expect(page.locator('#shell-keys')).toBeVisible();
    await shot(page, '10-shortcut-sheet', scheme);
    await page.keyboard.press('Escape');
    // 11 the compact window: list ↔ conversation, the box at the bottom.
    await open(page, 'envelope-v2');
    await page.setViewportSize({ width: 400, height: 640 });
    await page.locator('#msg-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await shot(page, '11-compact-composer', scheme);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test(`BD-3b read-only token: Allow sending (${scheme})`, async ({ page }) => {
    await control('reset', {});
    await control('config', { deviceInterval: 1, chatReadOnlyFamily: true });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await connect(page);
    await open(page, 'envelope-v2');
    await expect(page.locator('#chat-allow-sending')).toBeVisible();
    await axe(page, '#chat-foot');
    await shot(page, '12-allow-sending', scheme);
  });
}

test('BD-3b message box in Spanish (light)', async ({ browser }) => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
  const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 800 }, colorScheme: 'light', reducedMotion: 'reduce', timezoneId: 'Europe/Madrid' });
  const page = await context.newPage();
  await connect(page);
  await open(page, 'envelope-v2');
  await page.locator('#composer').fill('Desplegamos a las **16:00**.');
  await shot(page, '01-composer', 'light-es');
  await context.close();
});
