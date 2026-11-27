import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * UX batch 1 "Tasks polish" (UX audit 2026-11-27: UXA-15, 16, 17, 18, 38, 40) for the owner's review, light and dark,
 * 1280×800 and 900×600 (`UXB1_SHOTS` = output folder, `UXB1_PHASE` = `before` | `after` in the file names): the task
 * panel over the board, the board header at 900 px, the list, the banner after a refused then a successful move, the
 * banner with offline + 429, and Spanish quick-add tokens. `after` also opens the new pickers and checks axe.
 */
const MOCK = process.env.UXB1_MOCK ?? 'http://127.0.0.1:8806';
const OUT = process.env.UXB1_SHOTS ?? 'out/uxb1-screens';
const PHASE = process.env.UXB1_PHASE ?? 'after';
const AFTER = PHASE === 'after';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const NARROW = { width: 900, height: 600 };
const WIDE = { width: 1280, height: 800 };

async function control(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function shot(page: Page, name: string, scheme: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-${PHASE}-${scheme}.png` });
}

async function axe(page: Page, include = '#mod-tasks') {
  if (!AFTER) return;
  const result = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function open(page: Page) {
  await control('reset', {});
  await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
  await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
  await page.locator('#tab-tasks').click();
  await page.locator('#tasks-connect').click();
  await control('device/approve', { userCode: await page.locator('#tasks-user-code').textContent() });
  await expect(page.locator('#tasks-mine .row').first()).toBeVisible({ timeout: 15_000 });
}

async function board(page: Page) {
  await page.locator('[data-view="board"]').click();
  await expect(page.locator('.col .card').first()).toBeVisible();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`tasks polish (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await open(page);
    await board(page);
    // 01 the board header and toolbar (UXA-16, UXA-38), wide and narrow.
    await axe(page);
    await shot(page, '01-board-header', scheme);
    await page.setViewportSize(NARROW);
    await shot(page, '01-board-header-narrow', scheme);
    await page.setViewportSize(WIDE);
    if (AFTER) {
      await page.locator('#tasks-board').click();
      await expect(page.locator('#tasks-board-menu')).toBeVisible();
      await axe(page, 'body');
      await shot(page, '03-board-switcher', scheme);
      await page.keyboard.press('Escape');
    }
    // 04 the task panel (UXA-16 push, UXA-17 fields, UXA-40 breadcrumb), wide and narrow.
    await page.locator('.card[data-task="t-141"]').click();
    await expect(page.locator('#task-detail .comment')).toBeVisible();
    await axe(page);
    await shot(page, '04-task-detail', scheme);
    await page.setViewportSize(NARROW);
    await shot(page, '04-task-detail-narrow', scheme);
    if (AFTER) {
      // 02 the overflow menu of a narrow page (the panel open at 900 px).
      await page.locator('#tasks-more').click();
      await expect(page.locator('#tasks-more-menu')).toBeVisible();
      await axe(page, 'body');
      await shot(page, '02-board-overflow-menu-narrow', scheme);
      await page.keyboard.press('Escape');
      await expect(page.locator('#tasks-more')).toBeFocused();
    }
    await page.setViewportSize(WIDE);
    if (AFTER) {
      await page.locator('[data-key="task-status"]').click();
      await expect(page.locator('#task-status-menu')).toBeVisible();
      await axe(page, 'body');
      await shot(page, '05-task-status-menu', scheme);
      await page.keyboard.press('Escape');
      await page.locator('[data-key="task-estimate"]').fill('1h30');
      await page.locator('[data-key="task-estimate"]').press('Enter');
      await expect(page.locator('[data-key="task-estimate"]')).toHaveValue('1 h 30 min');
      await page.locator('[data-key="task-assignee"]').click();
      await expect(page.locator('#task-assignee-menu')).toBeVisible();
      await shot(page, '06-task-assignee-menu', scheme);
      await page.keyboard.press('Escape');
    }
    await page.locator('#task-close').click();
    // 07 banner: a refused move, then a successful one (UXA-15).
    await control('config', { tasksRefuseMove: true });
    await page.locator('.card[data-task="t-142"]').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('#tasks-banner')).toContainText('Review takes at most 3 tasks.');
    await shot(page, '07-banner-refused', scheme);
    await control('config', { tasksRefuseMove: false });
    await page.waitForTimeout(500);
    await page.locator('.card[data-task="t-143"]').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.col[data-col="env-doing"] .card[data-task="t-143"]')).toBeVisible();
    if (AFTER) await expect(page.locator('#tasks-banner')).toBeHidden();
    await shot(page, '08-banner-after-success', scheme);
    // 09 banner: a 429, then offline (one message at a time).
    await control('config', { tasksFailNext: { status: 429, error: 'rate_limited', retryAfter: 30 } });
    await page.locator('[data-view="list"]').click();
    await expect(page.locator('#tasks-banner')).toBeVisible();
    await page.context().setOffline(true);
    await page.locator('[data-view="board"]').click();
    await page.waitForTimeout(800);
    await shot(page, '09-banner-offline-429', scheme);
    await page.context().setOffline(false);
    await page.locator('[data-view="list"]').click();
    await expect(page.locator('.tbl tbody tr:not(.tbl-group)').first()).toBeVisible();
    if (AFTER) await expect(page.locator('#tasks-banner')).toBeHidden();
    // 10 the list (UXA-38).
    await axe(page);
    await shot(page, '10-list', scheme);
    if (AFTER) {
      await page.locator('[data-key="status-t-141"]').click();
      await expect(page.locator('#status-t-141-menu')).toBeVisible();
      await axe(page, 'body');
      await shot(page, '11-list-status-menu', scheme);
      await page.keyboard.press('Escape');
    }
  });

  test(`tasks polish, Spanish quick add (${scheme})`, async ({ browser }) => {
    const context = await browser.newContext({ locale: 'es-ES', viewport: WIDE, colorScheme: scheme, reducedMotion: 'reduce', timezoneId: 'Europe/Madrid' });
    const page = await context.newPage();
    await open(page);
    // 12 Spanish tokens (UXA-18).
    await page.locator('#qa-input').fill('Preparar demo !alta #demo @mañana ~1h30');
    await page.waitForTimeout(200);
    await shot(page, '12-quick-add-es', scheme);
    await page.locator('#qa-input').fill('');
    await shot(page, '13-quick-add-placeholder-es', scheme);
    await context.close();
  });
}
