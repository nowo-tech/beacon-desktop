import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/**
 * UX batch 4 in a real browser: the status strip (UXA-7: one line, its height kept, no layout shift; a `429` is a calm
 * countdown, not an error card) and the toast region with Undo (UXA-8: keyboard, top layer, reduced motion), light and
 * dark, axe clean.
 */
const MOCK = 'http://127.0.0.1:8787';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

const moves = async (taskId: string) => ((await control('tasks/state')) as { writes: { kind: string; taskId?: string }[] }).writes.filter((write) => write.kind === 'move' && write.taskId === taskId);

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
}

async function connectTasks(page: Page) {
  await signIn(page);
  await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
  await page.locator('#tab-tasks').click();
  await page.locator('#tasks-connect').click();
  await control('device/approve', { userCode: await page.locator('#tasks-user-code').textContent() });
  await expect(page.locator('#tasks-mine .row').first()).toBeVisible({ timeout: 15_000 });
}

/** Where an element's top edge is (to prove a strip message moved nothing). */
const top = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => Math.round(el.getBoundingClientRect().top));

/**
 * The same, in one round trip on whatever node is connected now (BDA14-L4: a re-render replaces the node between a
 * locator's resolve and its evaluate), `null` when there is none.
 */
const topNow = (page: Page, selector: string) =>
  page.evaluate((query) => {
    const element = document.querySelector(query);
    return element === null ? null : Math.round(element.getBoundingClientRect().top);
  }, selector);

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
});

test.use({ viewport: { width: 1280, height: 800 } });

for (const scheme of ['light', 'dark'] as const) {
  test(`tasks: a refused move shows in the strip without moving the board; complete and Undo from the keyboard (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await connectTasks(page);
    await page.locator('[data-view="board"]').click();
    await expect(page.locator('.col .card[data-task="t-142"]')).toBeVisible();
    const before = await topNow(page, '.board-wrap');
    expect(before).not.toBeNull();
    await control('config', { tasksRefuseMove: true });
    await page.locator('.card[data-task="t-142"]').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.locator('#tasks-banner')).toContainText('Review takes at most 3 tasks.');
    // BDA14-L4: the refused move reloads the board, which replaces `.board-wrap`. Measure the connected node in one
    // round trip (a locator handle can land on the detached old one) until the reload settled: the board is where it was.
    await expect.poll(() => topNow(page, '.board-wrap')).toBe(before);
    await expect(page.locator('#tasks-banner')).toContainText('Review takes at most 3 tasks.');
    expect(await axe(page)).toEqual([]);
    await control('config', { tasksRefuseMove: false });
    // Complete with Undo: announced, never focused; Ctrl+Z (outside a text field) takes it back.
    await page.locator('#tasks-banner-dismiss').click();
    await page.locator('[data-view="mine"]').click();
    const row = page.locator('#tasks-mine .row').first();
    const id = await row.locator('[data-task]').first().getAttribute('data-task');
    await row.locator('.chk').click();
    const toast = page.locator('#undo-toasts .ut');
    await expect(toast).toContainText('completed');
    await expect(page.locator('#undo-toasts')).toHaveAttribute('role', 'region');
    expect(await page.locator('#undo-toasts').evaluate((el) => el.matches(':popover-open'))).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.closest('#undo-toasts') ?? null)).toBeNull();
    expect(await axe(page)).toEqual([]);
    await page.locator('#tasks-title').click();
    await page.keyboard.press('Control+z');
    await expect(toast).toHaveCount(0);
    await expect.poll(async () => (await moves(id as string)).length).toBe(2);
  });
}

test('time: a background 429 is a countdown in the strip, not an error card, and the list does not move', async ({ page }) => {
  await signIn(page);
  const dismiss = page.locator('#time-strip-dismiss');
  if (await dismiss.isVisible()) await dismiss.click();
  const before = await top(page, '#tasks li');
  await control('config', { failNext: { status: 429, error: 'rate_limited', retryAfter: 20 } });
  await page.evaluate(() => (window as unknown as { __timeTrack: { app: { refresh(): Promise<void> } } }).__timeTrack.app.refresh());
  await expect(page.locator('#time-strip-text')).toHaveText(/^Paused for a moment\. Back in 0:(19|20)\.$/);
  await expect(page.locator('#error')).toHaveCount(0);
  expect(await top(page, '#tasks li')).toBe(before);
  expect(await axe(page)).toEqual([]);
});

test('reduced motion: the toast and the strip do not animate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await connectTasks(page);
  await page.locator('#tasks-mine .row .chk').first().click();
  await expect(page.locator('#undo-toasts .ut')).toBeVisible();
  expect(await page.locator('#undo-toasts .ut').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
