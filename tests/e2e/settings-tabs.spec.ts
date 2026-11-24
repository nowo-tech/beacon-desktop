import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/** Settings in tabs: every tab opens its panel, keyboard navigation, visible focus, no layout shift, remembered tab. */
const MOCK = 'http://127.0.0.1:8787';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

/** Each tab, the control that shows its panel is the right one. */
const TABS = [
  ['General', 'general', '#theme'],
  ['Shortcuts', 'shortcuts', '#shortcut'],
  ['Timer', 'timer', '#idle-settings'],
  ['Schedule', 'schedule', '#schedule-settings'],
  ['Notifications', 'notifications', '#friendly-settings'],
  ['Meetings', 'meetings', '#meeting-settings'],
  ['Updates', 'updates', '#check-updates'],
] as const;

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

test('every tab opens its own panel, without layout shift, the window never scrolls', async ({ page }) => {
  await signIn(page);
  await page.locator('#open-settings').click();
  const tablist = page.getByRole('tablist', { name: 'Settings sections' });
  await expect(tablist.getByRole('tab')).toHaveCount(TABS.length);
  const place = async () => ({
    tablist: await tablist.boundingBox(),
    panel: await page.locator('[role="tabpanel"]:not([hidden])').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width };
    }),
  });
  const first = await place();
  for (const [name, id, control] of TABS) {
    const tab = tablist.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toHaveAttribute('aria-controls', `settings-panel-${id}`);
    await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
    await expect(page.locator(control)).toBeVisible();
    await expect(page.locator('[role="tabpanel"]:not([hidden])')).toHaveCount(1);
    // Same place for the tabs and the panel on every tab; the document never scrolls, only the pane does, and not much.
    expect(await place(), name).toEqual(first);
    const sizes = await page.evaluate(() => {
      const pane = document.querySelector('#main-pane') as HTMLElement;
      return { document: document.scrollingElement?.scrollHeight ?? 0, window: innerHeight, overflow: pane.scrollHeight - pane.clientHeight };
    });
    expect(sizes.document, name).toBeLessThanOrEqual(sizes.window);
    expect(sizes.overflow, name).toBeLessThan(sizes.window / 2);
  }
  expect(await axe(page), 'settings tabs').toEqual([]);
});

test('arrow keys, Home and End move between tabs with a visible focus; the tab is remembered', async ({ page }) => {
  await signIn(page);
  await page.locator('#open-settings').click();
  const general = page.locator('#settings-tab-general');
  await expect(general).toHaveAttribute('aria-selected', 'true');
  // One Tab stop for the whole tablist: from the last header control, Tab lands on the selected tab.
  await page.locator('#layout-toggle').focus();
  await page.keyboard.press('Tab');
  await expect(general).toBeFocused();
  const outline = await general.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#settings-tab-shortcuts')).toBeFocused();
  await expect(page.locator('#settings-tab-shortcuts')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#shortcut')).toBeVisible();
  await page.keyboard.press('End');
  const updates = page.locator('#settings-tab-updates');
  await expect(updates).toBeFocused();
  // The last tab scrolled into view inside the tablist (never the page).
  const inside = await updates.evaluate((el) => {
    const list = (el.parentElement as HTMLElement).getBoundingClientRect();
    const tab = el.getBoundingClientRect();
    return tab.left >= list.left - 1 && tab.right <= list.right + 1;
  });
  expect(inside).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(general).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(updates).toBeFocused();
  await page.keyboard.press('Home');
  await expect(general).toBeFocused();
  // Tab leaves the tablist for the panel.
  await page.locator('#settings-tab-timer').click();
  await page.keyboard.press('Tab');
  await expect(page.locator('#settings-panel-timer')).toContainText('Still there?');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="tabpanel"]')?.id)).toBe('settings-panel-timer');
  // Back to the tasks and in again: still on Timer.
  await page.locator('#back').click();
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-tab-timer')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#settings-panel-timer')).toBeVisible();
});
