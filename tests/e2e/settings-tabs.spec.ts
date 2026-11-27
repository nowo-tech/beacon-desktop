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

/** Each tab of the one Settings (UX batch 6), the control that shows its panel is the right one. */
const TABS = [
  ['General', 'general', '#browser-settings'],
  ['Appearance', 'appearance', '#theme'],
  ['Timer', 'timer', '#idle-settings'],
  ['Shortcuts', 'shortcuts', '#shortcut'],
  ['Schedule', 'schedule', '#schedule-settings'],
  ['Notifications', 'notifications', '#friendly-settings'],
  ['Meetings', 'meetings', '#meeting-settings'],
  ['Chat', 'chat', '#settings-chat-connect'],
  ['Tasks', 'tasks', '#settings-tasks-connect'],
  ['Updates', 'updates', '#check-updates'],
  ['Account', 'account', '#logout'],
] as const;

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

test('every tab opens its own panel, without layout shift, the window never scrolls', async ({ page }) => {
  await signIn(page);
  await page.locator('#rail-settings').click();
  const tablist = page.getByRole('tablist', { name: 'Settings sections' });
  await expect(tablist.getByRole('tab')).toHaveCount(TABS.length);
  // The dialog's opening animation (160 ms) settles before anything is measured.
  await page.locator('#shell-settings .dlg').evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  const place = async () => ({
    tablist: await tablist.boundingBox(),
    panel: await page.locator('#shell-settings [role="tabpanel"]:not([hidden])').evaluate((el) => {
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
    await expect(page.locator('#shell-settings [role="tabpanel"]:not([hidden])')).toHaveCount(1);
    // Same place for the tabs and the panel on every tab; the document never scrolls, only the panel does, and not much.
    expect(await place(), name).toEqual(first);
    const sizes = await page.evaluate(() => {
      const pane = document.querySelector('#shell-settings [role="tabpanel"]:not([hidden])') as HTMLElement;
      return { document: document.scrollingElement?.scrollHeight ?? 0, window: innerHeight, overflow: pane.scrollHeight - pane.clientHeight };
    });
    expect(sizes.document, name).toBeLessThanOrEqual(sizes.window);
    // Never a long scroll: at most part of one more window (Schedule, the longest, is about half a window).
    expect(sizes.overflow, name).toBeLessThan(sizes.window * 0.75);
  }
  expect(await axe(page), 'settings tabs').toEqual([]);
  // The faded edges follow the writing direction (audit L2).
  const fade = () => page.locator('#shell-settings [role="tablist"]').evaluate((el) => getComputedStyle(el).getPropertyValue('--fade-dir').trim());
  expect(await fade()).toBe('right');
  await page.locator('#settings-tabs').evaluate((el) => el.setAttribute('dir', 'rtl'));
  expect(await fade()).toBe('left');
});

test('arrow keys, Home and End move between tabs with a visible focus; the tab is remembered', async ({ page }) => {
  await signIn(page);
  await page.locator('#rail-settings').click();
  const general = page.locator('#settings-tab-general');
  await expect(general).toHaveAttribute('aria-selected', 'true');
  // Opening focuses the selected tab; one Tab stop for the whole tablist: from the dialog's close button, Tab lands on it.
  await expect(general).toBeFocused();
  await page.locator('#settings-close').focus();
  await page.keyboard.press('Tab');
  await expect(general).toBeFocused();
  const outline = await general.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#settings-tab-appearance')).toBeFocused();
  await expect(page.locator('#settings-tab-appearance')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#theme')).toBeVisible();
  await page.keyboard.press('End');
  const updates = page.locator('#settings-tab-account');
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
  // The shell's time rows sit at the top of the Timer tab (UX batch 6).
  await expect(page.locator('#settings-panel-timer #settings-time-tracking')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.closest('[role="tabpanel"]')?.id)).toBe('settings-panel-timer');
  // Back to the tasks and in again: still on Timer.
  await page.locator('#settings-close').click();
  await page.locator('#rail-settings').click();
  await expect(page.locator('#settings-tab-timer')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#settings-panel-timer')).toBeVisible();
});
