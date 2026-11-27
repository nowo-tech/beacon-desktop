import { expect, test, type Page } from '@playwright/test';

/**
 * App shell at the default 400 × 640 window: the task list scrolls inside its own container (the window never
 * scrolls), and every view has the same content width (--content-max), so switching views never jumps.
 */
const MOCK = 'http://127.0.0.1:8787';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

type Box = { left: number; width: number };
type Tt = { __timeTrack: { app: { refresh(): Promise<void>; checkUpdates(): Promise<void> } } };

/** The content box of the current view (the view's own container). */
const contentBox = (page: Page): Promise<Box> =>
  page.locator('#view > *').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), width: Math.round(r.width) };
  });

const scrolls = (page: Page) =>
  page.evaluate(() => {
    const doc = document.scrollingElement as HTMLElement;
    const list = document.querySelector('#task-scroll') as HTMLElement;
    return { document: doc.scrollHeight - doc.clientHeight, documentTop: doc.scrollTop, list: list.scrollHeight - list.clientHeight, listTop: list.scrollTop };
  });

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

test('with many tasks only the list scrolls: the window, header, timer and search stay put', async ({ page }) => {
  await control('config', { extraTasks: 40 });
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li')).toHaveCount(48, { timeout: 15_000 });
  const before = await scrolls(page);
  expect(before.document).toBe(0);
  expect(before.list).toBeGreaterThan(0);
  const timer = await page.locator('#timer').boundingBox();
  const search = await page.locator('#search').boundingBox();
  // The wheel over the list scrolls the list (and does not chain into the window at its end).
  await page.locator('#tasks').hover();
  await page.mouse.wheel(0, 5000);
  await expect.poll(async () => (await scrolls(page)).listTop).toBeGreaterThan(0);
  const after = await scrolls(page);
  expect(after.documentTop).toBe(0);
  expect(await page.locator('#timer').boundingBox()).toEqual(timer);
  expect(await page.locator('#search').boundingBox()).toEqual(search);
  expect(await page.locator('#task-scroll').evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe('contain');
  // Keyboard: End focuses the last row; the list scrolls it into view (focus ring inside the list), the window does not.
  await page.locator('#task-scroll').evaluate((el) => el.scrollTo(0, 0));
  await page.locator('[data-task="T-101"] .row-action').focus();
  await page.keyboard.press('End');
  const last = page.locator('#tasks li').last().locator('.row-action');
  await expect(last).toBeFocused();
  const visible = await last.evaluate((el) => {
    const list = (document.querySelector('#task-scroll') as HTMLElement).getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top >= list.top && r.bottom <= list.bottom && getComputedStyle(el).outlineStyle !== 'none';
  });
  expect(visible).toBe(true);
  expect((await scrolls(page)).documentTop).toBe(0);
});

test('every view has the same content width at the default window size', async ({ page }) => {
  const widths: Record<string, Box> = {};
  await page.goto('/');
  await expect(page.locator('#login-form')).toBeVisible();
  widths.login = await contentBox(page);
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await expect(page.locator('#user-code')).toBeVisible();
  widths.device = await contentBox(page);
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
  widths.main = await contentBox(page);
  await page.locator('#rail-settings').click();
  widths.settings = await contentBox(page);
  await page.locator('#settings-tab-account').click();
  await page.locator('#open-privacy').click();
  await expect(page.locator('#privacy')).toBeVisible();
  widths.privacy = await contentBox(page);
  // Back from "What we collect" reopens the one Settings (UX batch 6); close it.
  await page.locator('#back').click();
  await page.locator('#settings-close').click();
  await control('config', { update: { version: '99.0.0', notes: '', pub_date: '2026-11-04T10:00:00Z', url: 'u', signature: 's' }, minSupportedVersion: '99.0.0' });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
  await expect(page.locator('#update-required')).toBeVisible();
  widths['update-required'] = await contentBox(page);
  const header = await page.locator('.bar-row').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), width: Math.round(r.width) };
  });
  for (const [view, box] of Object.entries(widths)) expect(box, view).toEqual(widths.login);
  // The header row lines up with the content.
  expect(header).toEqual(widths.login);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--content-max').trim())).toBe('31rem');
});
