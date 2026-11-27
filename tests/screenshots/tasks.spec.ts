import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * BD-3b tasks core against the mock API, light and dark, for the owner's review (`TASKS_SHOTS` = output folder): the
 * connect card, My tasks, the board (emoji and dot markers), the list, the task panel, quick add, a refused move, the
 * compact window, `module_forbidden`, Settings and the shortcut sheet. Every view is checked with axe (WCAG 2.1 AA).
 */
const MOCK = process.env.TASKS_MOCK ?? 'http://127.0.0.1:8800';
const OUT = process.env.TASKS_SHOTS ?? 'out/tasks-screens';
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

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
  await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
  await page.locator('#tab-tasks').click();
}

async function connect(page: Page) {
  await page.locator('#tasks-connect').click();
  await control('device/approve', { userCode: await page.locator('#tasks-user-code').textContent() });
  await expect(page.locator('#tasks-mine .row').first()).toBeVisible({ timeout: 15_000 });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Tasks screens (${scheme})`, async ({ page }) => {
    await control('reset', {});
    await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await signIn(page);
    await axe(page, '#mod-tasks');
    await shot(page, '01-connect-tasks', scheme);
    await connect(page);
    await axe(page, '#mod-tasks');
    await shot(page, '02-my-tasks', scheme);
    await page.locator('[data-view="board"]').click();
    await expect(page.locator('.col .card').first()).toBeVisible();
    await axe(page, '#mod-tasks');
    await shot(page, '03-board', scheme);
    // 04 a card picked with the keyboard and moved (Alt+→), the timer on another.
    await page.locator('.card[data-task="t-144"] .k-play').click();
    await expect(page.locator('.card.live[data-task="t-144"]')).toBeVisible();
    await page.locator('.card[data-task="t-142"]').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.col[data-col="env-doing"] .card[data-task="t-142"]')).toBeVisible();
    await shot(page, '04-board-moved-timer', scheme);
    // 05 a move the board's policy refuses.
    await control('config', { tasksRefuseMove: true });
    await page.locator('.card[data-task="t-142"]').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('#tasks-banner')).toContainText('Review takes at most 3 tasks.');
    await shot(page, '05-move-refused', scheme);
    await control('config', { tasksRefuseMove: false });
    // 06 the task panel.
    await page.locator('.card[data-task="t-141"]').click();
    await expect(page.locator('#task-detail .comment')).toBeVisible();
    await axe(page, '#task-detail');
    await shot(page, '06-task-detail', scheme);
    await page.locator('#task-close').click();
    // 07 quick add with its preview.
    await page.locator('#qa-input').fill('Write the release notes !high #docs @tomorrow ~2h');
    await expect(page.locator('.qa-preview .pill').first()).toBeVisible();
    await shot(page, '07-quick-add', scheme);
    await page.locator('#qa-input').fill('');
    // 08 the list view.
    await page.locator('[data-view="list"]').click();
    await expect(page.locator('.tbl tbody tr:not(.tbl-group)').first()).toBeVisible();
    await axe(page, '#mod-tasks');
    await shot(page, '08-list', scheme);
    // 09 colour dots instead of emojis (Settings).
    await page.locator('#rail-settings').click();
    await page.locator('#shell-settings [aria-label="Column markers"] [data-value="dots"]').click();
    await shot(page, '09-settings-tasks', scheme);
    await page.keyboard.press('Escape');
    await page.locator('[data-view="board"]').click();
    await expect(page.locator('.col-dot').first()).toBeVisible();
    await shot(page, '10-board-dots', scheme);
    // 11 the compact window: the panel over the board.
    await page.setViewportSize({ width: 400, height: 640 });
    await page.locator('.card[data-task="t-141"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#task-detail')).toBeVisible();
    await shot(page, '11-compact-detail', scheme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('#task-close').click();
    // 12 the shortcut sheet.
    await page.locator('#tasks-body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('?');
    await expect(page.locator('#shell-keys')).toBeVisible();
    await shot(page, '12-shortcut-sheet', scheme);
    await page.keyboard.press('Escape');
  });
}

test('Tasks: My tasks in Spanish, and module_forbidden (light)', async ({ browser }) => {
  await control('reset', {});
  await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
  const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 800 }, colorScheme: 'light', reducedMotion: 'reduce', timezoneId: 'Europe/Madrid' });
  const page = await context.newPage();
  await signIn(page);
  await connect(page);
  await shot(page, '02-my-tasks', 'light-es');
  await control('config', { tasksForbidden: true });
  await page.locator('[data-view="board"]').click();
  await expect(page.locator('#tab-tasks')).toHaveCount(0);
  await shot(page, '13-module-hidden', 'light-es');
  await context.close();
});
