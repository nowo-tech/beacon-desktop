import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * UX batch 4 screens for the owner (`UXB4_SHOTS` = output folder), light and dark, desktop 1280 × 800 and narrow
 * 900 × 600: the status strip in Chat, Tasks and Time (offline, a `429` pause, a refused write), the chat's pause note
 * while a conversation loads (UXA-13) and the toast region with Undo (UXA-8). Every screen is checked with axe
 * (WCAG 2.2 AA), and a message appearing in a strip must not move the content (layout shift ≈ 0).
 */
const MOCK = process.env.UXB4_MOCK ?? 'http://127.0.0.1:8804';
const OUT = process.env.UXB4_SHOTS ?? 'out/uxb4-screens';
const NARROW = { width: 900, height: 600 };
const DESKTOP = { width: 1280, height: 800 };
const LEO = '0c000000-0000-4000-8000-000000000007';

async function control(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function shot(page: Page, name: string, scheme: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
}

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/** Layout shift while `action` runs (PerformanceObserver on `layout-shift`). */
async function cls(page: Page, action: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const scope = window as unknown as { __cls: number };
    scope.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!entry.hadRecentInput) scope.__cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: false });
  });
  await action();
  await page.waitForTimeout(400);
  return page.evaluate(() => (window as unknown as { __cls: number }).__cls);
}

/** Calls into the app (the browser build's `window.__timeTrack` hooks). */
const app = (page: Page, work: string) => page.evaluate(`(async () => { const { app, shell } = window.__timeTrack; ${work} })()`);

for (const scheme of ['light', 'dark'] as const) {
  test(`UX batch 4 screens (${scheme})`, async ({ page, context }) => {
    await control('reset', {});
    await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await page.locator('#server').fill(MOCK);
    await page.locator('#connect').click();
    await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
    // The guided first run (UXA-23: the time step names the person and the organization, not the server address).
    await expect(page.locator('#mod-setup')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#setup-step-time .st-text')).not.toContainText('127.0.0.1');
    await shot(page, '01-setup-time-step', scheme);
    await page.locator('#setup-connect').click();
    await control('device/approve', { userCode: await page.locator('#setup-code').textContent() });
    await expect(page.locator('#setup-step-tasks')).toHaveAttribute('aria-current', 'step');
    await page.locator('#setup-connect').click();
    await control('device/approve', { userCode: await page.locator('#setup-code').textContent() });
    await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
    // The organization with the demo conversations.
    await page.locator('.ctx-tile').nth(1).click();
    await page.locator('[data-conv="0c000000-0000-4000-8000-000000000001"]').click();
    await expect(page.locator('#msg-list li.msg').first()).toBeVisible();

    // ---- Chat: offline strip (the timeline does not move), a cancelled message with Undo.
    await context.setOffline(true);
    const chatShift = await cls(page, async () => {
      await page.locator('#composer').focus();
      await page.keyboard.type('Written on the train');
      await page.keyboard.press('Enter');
      await expect(page.locator('#chat-banner')).toContainText('You are offline');
    });
    expect(chatShift, 'chat strip shift').toBeLessThan(0.01);
    await axe(page);
    await shot(page, '02-chat-offline-strip', scheme);
    await page.locator('#msg-list li.msg.pending.queued button', { hasText: 'Cancel' }).click();
    await expect(page.locator('#undo-toasts .ut')).toContainText('Message cancelled');
    await axe(page);
    await shot(page, '03-chat-undo-toast', scheme);
    await page.keyboard.press('Control+z');
    await expect(page.locator('#msg-list li.msg.pending.queued')).toHaveCount(1);
    await expect(page.locator('#composer')).toHaveValue('');
    await context.setOffline(false);
    await expect(page.locator('#msg-list li.msg.pending')).toHaveCount(0, { timeout: 30_000 });
    // ---- Chat: a 429 while a conversation loads (UXA-13) and the strip's countdown (UXA-7).
    await control('config', { chatFailNext: { status: 429, error: 'rate_limited', retryAfter: 30, times: 2 } });
    await page.locator(`[data-conv="${LEO}"]`).click();
    await expect(page.locator('#chat-pause-note')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#chat-pause-retry')).toBeDisabled();
    await expect(page.locator('#chat-banner')).toContainText('Paused for a moment');
    await axe(page);
    await shot(page, '04-chat-pause-note', scheme);

    // ---- Tasks: complete with Undo; a refused move in the strip without a shift.
    await page.locator('#tab-tasks').click();
    await expect(page.locator('#tasks-mine .row').first()).toBeVisible({ timeout: 35_000 });
    await page.locator('#tasks-mine .row .chk').first().click();
    await expect(page.locator('#undo-toasts .ut')).toContainText('completed');
    await axe(page);
    await shot(page, '05-tasks-complete-undo', scheme);
    await page.setViewportSize(NARROW);
    await shot(page, '05-tasks-complete-undo-narrow', scheme);
    await page.setViewportSize(DESKTOP);
    await page.locator('#undo-toasts .ut-undo').click();
    await expect(page.locator('#undo-toasts .ut')).toHaveCount(0);
    await page.locator('[data-view="board"]').click();
    await expect(page.locator('.col .card').first()).toBeVisible();
    await control('config', { tasksRefuseMove: true });
    const tasksShift = await cls(page, async () => {
      await page.locator('.card[data-task="t-142"]').focus();
      await page.keyboard.press('Alt+ArrowRight');
      await expect(page.locator('#tasks-banner')).toContainText('Review takes at most 3 tasks.');
    });
    expect(tasksShift, 'tasks strip shift').toBeLessThan(0.01);
    await control('config', { tasksRefuseMove: false });
    await axe(page);
    await shot(page, '06-tasks-strip-refused', scheme);
    await control('config', { tasksFailNext: { status: 429, error: 'rate_limited', retryAfter: 25 } });
    await page.locator('[data-view="list"]').click();
    await expect(page.locator('#tasks-banner')).toContainText('Paused for a moment');
    await axe(page);
    await shot(page, '07-tasks-strip-paused', scheme);

    // ---- Time: a background 429 is a calm countdown, not a red card; offline is one line.
    await page.locator('#tab-time').click();
    await expect(page.locator('#tasks li').first()).toBeVisible();
    await control('config', { failNext: { status: 429, error: 'rate_limited', retryAfter: 25 } });
    const timeShift = await cls(page, async () => {
      await app(page, 'await app.refresh();');
      await expect(page.locator('#time-strip-text')).toContainText('Paused for a moment');
    });
    expect(timeShift, 'time strip shift').toBeLessThan(0.01);
    await expect(page.locator('#error')).toHaveCount(0);
    await axe(page);
    await shot(page, '08-time-paused', scheme);
    await page.setViewportSize(NARROW);
    await shot(page, '08-time-paused-narrow', scheme);
    await page.setViewportSize(DESKTOP);
    await app(page, 'app.rateLimit = null; app.render();');
    await context.setOffline(true);
    await page.locator('#tasks li').first().hover();
    await page.locator('#tasks li .row-action').first().click();
    await expect(page.locator('#offline')).toContainText('action(s)');
    await expect(page.locator('#offline-card')).toHaveCount(0);
    await axe(page);
    await shot(page, '09-time-offline', scheme);
    await context.setOffline(false);
  });
}

test('reduced motion: toasts and strips do not animate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const names = await page.evaluate(() => {
    const strip = document.createElement('div');
    strip.className = 'status-strip';
    strip.innerHTML = '<div class="ss-box warn">x</div>';
    const toasts = document.createElement('div');
    toasts.className = 'undo-toasts';
    toasts.innerHTML = '<ol class="ut-list"><li class="ut">y</li></ol>';
    document.body.append(strip, toasts);
    return [getComputedStyle(strip.firstElementChild as Element).animationName, getComputedStyle(toasts.querySelector('.ut') as Element).animationName];
  });
  expect(names).toEqual(['none', 'none']);
});
