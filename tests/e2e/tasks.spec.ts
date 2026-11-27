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
