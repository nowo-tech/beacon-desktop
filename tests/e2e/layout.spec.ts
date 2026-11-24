import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** 0.5.0: compact and full window layouts, the view toggle, panes and keyboard, in both themes. */
const MOCK = 'http://127.0.0.1:8787';
const COMPACT = { width: 400, height: 640 };
const MIDDLE = { width: 720, height: 640 };
const FULL = { width: 1280, height: 800 };

test.use({ timezoneId: 'UTC' });

/** Two finished entries earlier today (UTC), never before midnight nor zero-length, whatever the time of day. */
function todayEntries(now = Date.now()) {
  const midnight = now - (now % 86_400_000);
  const at = (minutesAgo: number) => Math.max(now - minutesAgo * 60_000, midnight + (180 - minutesAgo) * 1000);
  const span = (taskId: string, from: number, to: number) => ({ taskId, startedAt: new Date(at(from)).toISOString(), endedAt: new Date(at(to)).toISOString() });
  return [span('T-102', 180, 120), span('T-101', 120, 60)];
}

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

type Rect = { x: number; y: number; width: number; height: number };
type Tt = { __timeTrack: { hooks: { window: { set: Rect[] } } } };

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  // The seeded entries make two tasks "recent": they move from the list to Pinned & recent.
  await expect(page.locator('#main li[data-task]')).toHaveCount(8, { timeout: 15_000 });
}

/** No horizontal scrolling anywhere: the page and every pane fit their width. */
async function noHorizontalScroll(page: Page, state: string) {
  const overflowing = await page.evaluate(() => {
    const scrollers = [document.scrollingElement, ...document.querySelectorAll('.pane, #app')].filter((el): el is Element => el !== null);
    return scrollers.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.id || el.tagName} ${el.scrollWidth}>${el.clientWidth}`);
  });
  expect(overflowing, state).toEqual([]);
}

/** The visible panes and the header never overlap, and every one is inside the window. */
async function noOverlap(page: Page, state: string) {
  const boxes = await page.evaluate(() =>
    ['.bar', '#sidebar', '#main-pane', '#detail']
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .filter((el): el is HTMLElement => el !== null && !el.hidden)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.id || el.className, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }),
  );
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  for (const box of boxes) {
    expect(box.left, `${state}: ${box.id} left`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${state}: ${box.id} right`).toBeLessThanOrEqual(viewport.width + 0.5);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      expect(overlap, `${state}: ${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
}

async function axe(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => `${state}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
  await control('entries/seed', { entries: todayEntries() });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`compact (400 × 640) and full (1280 × 800) layouts fit, never overlap and pass axe — ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(COMPACT);
    await signIn(page);
    await expect(page.locator('#app')).toHaveAttribute('data-layout', 'compact');
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(page.locator('#detail')).toBeHidden();
    await noHorizontalScroll(page, `${scheme} compact`);
    await noOverlap(page, `${scheme} compact`);
    await axe(page, `${scheme} compact`);

    // Between the compact column and the breakpoint: still one centred column, never stretched.
    await page.setViewportSize(MIDDLE);
    await expect(page.locator('#app')).toHaveAttribute('data-layout', 'compact');
    const column = await page.locator('#app').boundingBox();
    expect(column?.width).toBeLessThanOrEqual(33 * 16 + 1);
    expect(Math.abs((column?.x ?? 0) * 2 + (column?.width ?? 0) - MIDDLE.width)).toBeLessThanOrEqual(2);
    await noHorizontalScroll(page, `${scheme} middle`);

    await page.setViewportSize(FULL);
    await expect(page.locator('#app')).toHaveAttribute('data-layout', 'full');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#detail')).toBeVisible();
    await page.locator('[data-task="T-104"] .row-action').focus();
    await expect(page.locator('#detail-title')).toHaveText('Fix invoice rounding bug');
    await noHorizontalScroll(page, `${scheme} full`);
    await noOverlap(page, `${scheme} full`);
    await axe(page, `${scheme} full`);

    // The running timer stays in view while the task list scrolls (inside its own container).
    await page.locator('#detail-start').click();
    await expect(page.locator('#timer-task')).toHaveText('Fix invoice rounding bug');
    await page.setViewportSize({ width: FULL.width, height: 560 });
    await page.locator('#task-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const timer = await page.locator('#timer').boundingBox();
    const header = await page.locator('.bar').boundingBox();
    expect(timer?.y).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0) - 1);
    expect((timer?.y ?? 0) + (timer?.height ?? 0)).toBeLessThanOrEqual(560);
    await noOverlap(page, `${scheme} full, scrolled`);

    // Settings: a page in the main pane next to the sidebar.
    await page.setViewportSize(FULL);
    await page.locator('#nav-settings').click();
    await expect(page.locator('#main-pane #settings')).toBeVisible();
    await expect(page.locator('#detail')).toBeHidden();
    await noHorizontalScroll(page, `${scheme} settings`);
    await noOverlap(page, `${scheme} settings`);
    await axe(page, `${scheme} settings`);

    // My time.
    await page.locator('#nav-time').click();
    await expect(page.locator('#time-today li')).toHaveCount(3);
    await noHorizontalScroll(page, `${scheme} my time`);
    await axe(page, `${scheme} my time`);
  });
}

test('the view toggle and Ctrl+Shift+L resize the window; F6 walks the panes', async ({ page }) => {
  await page.setViewportSize(COMPACT);
  await signIn(page);
  const sets = () => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.window.set);
  await page.locator('#layout-toggle').click();
  await expect.poll(async () => (await sets()).at(-1)?.width).toBe(1200);
  // The (fake) OS applies the new size.
  await page.setViewportSize(FULL);
  await expect(page.locator('#layout-toggle')).toHaveText('Compact view');
  await page.keyboard.press('F6');
  await expect(page.locator('#nav-tasks')).toBeFocused();
  await page.keyboard.press('F6');
  await expect(page.locator('#search')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#detail-title')).not.toHaveText('Task details');
  await page.keyboard.press('F6');
  await expect(page.locator('#detail-start')).toBeFocused();
  await page.keyboard.press('Shift+F6');
  await expect(page.locator('#search')).toBeFocused();
  await page.keyboard.press('Control+Shift+L');
  await expect.poll(async () => (await sets()).at(-1)?.width).toBe(400);
  await page.setViewportSize(COMPACT);
  await expect(page.locator('#app')).toHaveAttribute('data-layout', 'compact');
  await expect(page.locator('#layout-toggle')).toHaveAttribute('aria-label', 'Switch to the full view');
});
