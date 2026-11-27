import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/**
 * BD-3b tasks core against the mocked TaskBoard client API in a real browser: connect tasks (chained device flow),
 * My tasks, the board (keyboard move with If-Match), the task panel (checklist), quick add, light and dark, axe
 * (WCAG 2.1 AA) on every view.
 */
const MOCK = 'http://127.0.0.1:8787';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

const writes = async () => ((await control('tasks/state')) as { writes: { kind: string; ifMatch?: string }[] }).writes;

async function connectTasks(page: Page) {
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

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
});

test.use({ viewport: { width: 1280, height: 800 } });

for (const scheme of ['light', 'dark'] as const) {
  test(`tasks: My tasks, board, keyboard move, panel, checklist, quick add — axe clean (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await connectTasks(page);
    await expect(page.locator('#tasks-title')).toHaveText('My tasks');
    expect(await axe(page)).toEqual([]);
    // Board view, keyboard move with the card's revision.
    await page.locator('[data-view="board"]').click();
    await expect(page.locator('.col')).toHaveCount(4);
    expect(await axe(page)).toEqual([]);
    const card = page.locator('.card[data-task="t-142"]');
    await card.focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.col[data-col="env-doing"] .card[data-task="t-142"]')).toBeVisible();
    await expect.poll(async () => (await writes()).find((write) => write.kind === 'move')?.ifMatch).toBe('"1"');
    // The task panel; Esc closes it.
    await page.locator('.card[data-task="t-141"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#task-detail .sub-item')).toHaveCount(2);
    expect(await axe(page)).toEqual([]);
    await page.locator('#task-detail .sub-item .chk').nth(1).click();
    await expect(page.locator('#task-detail .sub-item .chk[aria-checked="true"]')).toHaveCount(2);
    await page.locator('#task-detail').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#task-detail')).toHaveCount(0);
    // Quick add: N, the syntax preview, Enter.
    await page.locator('#tasks-body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('n');
    await expect(page.locator('#qa-input')).toBeFocused();
    await page.keyboard.type('Write the release notes !high #docs');
    await expect(page.locator('.qa-preview')).toContainText('High');
    await page.keyboard.press('Enter');
    await expect(page.locator('.col[data-col="env-todo"] .card', { hasText: 'Write the release notes' })).toBeVisible();
    // The list view.
    await page.locator('[data-view="list"]').click();
    await expect(page.locator('.tbl tbody tr:not(.tbl-group)').first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
}

test('module_forbidden hides Tasks and keeps the token', async ({ page }) => {
  await connectTasks(page);
  await control('config', { tasksForbidden: true });
  await page.locator('[data-view="board"]').click();
  await expect(page.locator('#tab-tasks')).toHaveCount(0);
  await expect(page.locator('#tab-chat')).toHaveAttribute('aria-selected', 'true');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`tasks polish (UX batch 1): menus by keyboard, duration field, due shortcuts, breadcrumb, banner, narrow header — axe clean (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await connectTasks(page);
    await page.locator('[data-view="board"]').click();
    await expect(page.locator('.col')).toHaveCount(4);
    // UXA-38: the board switcher is a menu button as tall as the view control; its menu is in the top layer.
    const switcher = page.locator('#tasks-board');
    await expect(switcher).toBeVisible();
    await expect(page.locator('.col .card').first()).toBeVisible();
    expect((await switcher.boundingBox())?.height).toBe((await page.locator('.seg').boundingBox())?.height);
    await switcher.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#tasks-board-menu')).toBeVisible();
    await expect(page.locator('#tasks-board-menu [data-value="b-envelope"]')).toBeFocused();
    expect(await page.locator('#tasks-board-menu').evaluate((menu) => menu.matches(':popover-open'))).toBe(true);
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#tasks-board-menu')).toBeHidden();
    await expect(switcher).toBeFocused();
    // UXA-16: the panel pushes the board (no overlap) and the board scrolls with an edge fade.
    await page.locator('.card[data-task="t-141"]').click();
    await expect(page.locator('#task-detail .sub-item')).toHaveCount(2);
    // The board ends where the panel starts (measured once the panel's slide-in is over).
    await expect
      .poll(() => page.evaluate(() => Math.round(document.getElementById('task-detail')!.getBoundingClientRect().left - document.getElementById('tasks-board-view')!.getBoundingClientRect().right)))
      .toBeGreaterThanOrEqual(0);
    await expect(page.locator('.card[data-task="t-141"]')).toBeInViewport();
    expect(await axe(page)).toEqual([]);
    // UXA-17: priority by keyboard (↓ opens, arrows, Enter picks; focus back on the button).
    const priority = page.locator('[data-key="task-priority"]');
    await priority.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#task-priority-menu [data-value="high"]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(priority).toHaveAccessibleName('Priority: Urgent');
    await expect(page.locator('[data-key="task-priority"]')).toBeFocused();
    // Esc in a menu closes the menu, not the panel.
    await page.locator('[data-key="task-status"]').click();
    await expect(page.locator('#task-status-menu')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#task-status-menu')).toBeHidden();
    await expect(page.locator('#task-detail')).toBeVisible();
    // The estimate reads as on the cards and takes "1h30".
    const estimate = page.locator('[data-key="task-estimate"]');
    await expect(estimate).toHaveValue('4 h');
    await estimate.fill('1h30');
    await estimate.press('Enter');
    await expect(estimate).toHaveValue('1 h 30 min');
    await expect(page.locator('.card[data-task="t-141"]')).toContainText('1 h 30 min');
    await estimate.fill('later');
    await estimate.press('Enter');
    await expect(estimate).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#task-estimate-hint')).toHaveText('Use hours and minutes, like 4h, 90m or 1h30.');
    await estimate.press('Escape');
    await expect(estimate).toHaveValue('1 h 30 min');
    // Due date shortcuts.
    await page.locator('#task-detail .chip', { hasText: 'Tomorrow' }).click();
    await expect(page.locator('#task-detail .chip', { hasText: 'Tomorrow' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.card[data-task="t-141"]')).toContainText('Tomorrow');
    // UXA-40: "Envelope v2 › #141".
    await expect(page.locator('#task-detail .crumb-sep')).toHaveText('›');
    // UXA-16 at 900 × 600: two header rows, the overflow menu holds Only mine.
    await page.setViewportSize({ width: 900, height: 600 });
    await expect(page.locator('#tasks-more')).toBeVisible();
    await expect(page.locator('[data-key="only-mine"]')).toBeHidden();
    const head = await page.locator('#tasks-head').boundingBox();
    expect(head?.height ?? 0).toBeLessThanOrEqual(60);
    await page.locator('#tasks-more').click();
    await page.locator('#tasks-more-menu [data-value="only-mine"]').click();
    await expect(page.locator('#tasks-more')).toHaveClass(/\bon\b/);
    expect(await axe(page)).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('#task-close').click();
    // UXA-15: a refused move, then a move that goes through clears the banner.
    await page.locator('[data-key="only-mine"]').click();
    await expect(page.locator('.card[data-task="t-143"]')).toBeVisible();
    await control('config', { tasksRefuseMove: true });
    await page.locator('.card[data-task="t-142"]').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('#tasks-banner')).toContainText('Review takes at most 3 tasks.');
    expect(await axe(page)).toEqual([]);
    await control('config', { tasksRefuseMove: false });
    await expect(page.locator('.col[data-col="env-todo"] .card[data-task="t-142"]')).toBeVisible();
    await page.locator('.card[data-task="t-143"]').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('.col[data-col="env-doing"] .card[data-task="t-143"]')).toBeVisible();
    await expect(page.locator('#tasks-banner')).toBeHidden();
    // UXA-38: the list's status pills.
    await page.locator('[data-view="list"]').click();
    await expect(page.locator('.tbl tbody tr:not(.tbl-group)').first()).toBeVisible();
    await expect(page.locator('.tbl select')).toHaveCount(0);
    await page.locator('[data-key="status-t-146"]').click();
    await page.locator('#status-t-146-menu [data-value="env-done"]').click();
    await expect(page.locator('[data-key="status-t-146"]')).toContainText('Done');
    expect(await axe(page)).toEqual([]);
  });
}
