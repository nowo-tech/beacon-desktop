import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * UX batch 7: the custom title bar (UXA-45) with the fake host's chrome (`window.__beaconChrome`, set before the app
 * loads), the update pill (UXA-22) and the title bar at 900 px (UXA-9).
 */
const MOCK = 'http://127.0.0.1:8787';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const UPDATE = { version: '99.0.0', notes: 'Added\n- A pill in the title bar', pub_date: '2026-11-27T10:00:00Z', url: 'u', signature: 's' };

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

type Tt = { __timeTrack: { app: { checkUpdates(): Promise<void> }; hooks: { chrome: { calls: string[]; maximized: boolean } } } };
const calls = (page: Page) => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.chrome.calls);

async function open(page: Page, chrome: 'custom' | 'overlay' | 'native') {
  await page.addInitScript((mode) => void ((window as unknown as { __beaconChrome: string }).__beaconChrome = mode), chrome);
  await page.goto('/');
}

async function signIn(page: Page) {
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

async function axe(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(violations.map((v) => `${state}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`custom title bar (${scheme}): drag region, window buttons at the right edge, keyboard and screen readers`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, 'custom');
    // Signed out: a bare bar (drag region and buttons) above the sign-in.
    const bar = page.locator('#titlebar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-tauri-drag-region', 'deep');
    await expect(page.getByRole('group', { name: 'Window' })).toBeVisible();
    await expect(page.locator('#tb-search')).toHaveCount(0);
    await axe(page, 'signed out');
    await signIn(page);
    const group = page.getByRole('group', { name: 'Window' });
    const buttons = group.getByRole('button');
    await expect(buttons).toHaveText(['', '', '']);
    expect(await buttons.evaluateAll((list) => list.map((b) => b.getAttribute('aria-label')))).toEqual(['Minimize', 'Maximize', 'Close']);
    // The test browser runs on Linux: round 24 px buttons at the right end, centred in the 44 px bar.
    await expect(page.locator('#win-controls')).toHaveAttribute('data-os', 'linux');
    const close = await page.locator('#wc-close').boundingBox();
    expect(close).not.toBeNull();
    expect(Math.round((close?.x ?? 0) + (close?.width ?? 0))).toBe(1280 - 10);
    expect(Math.round(close?.width ?? 0)).toBe(24);
    expect(Math.round((close?.y ?? 0) + (close?.height ?? 0) / 2)).toBe(22);
    // Keyboard: the buttons are the title bar's last Tab stops; Enter maximises, the name becomes "Restore".
    await page.locator('#tb-help').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#wc-minimize')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#wc-maximize')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#wc-maximize')).toHaveAccessibleName('Restore');
    await expect(page.locator('#wc-maximize')).toBeFocused();
    await page.locator('#wc-close').click();
    await page.locator('#wc-minimize').click();
    expect(await calls(page)).toEqual(['toggle-maximize', 'close', 'minimize']);
    await axe(page, 'signed in');
    // Nothing scrolls sideways, and the bar keeps its 44 px.
    expect(await page.evaluate(() => document.scrollingElement?.scrollWidth)).toBe(1280);
    expect(Math.round((await bar.boundingBox())?.height ?? 0)).toBe(44);
  });
}

test('Windows caption buttons: flush top right, full bar height, 46 px; close turns red with white (AA)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 'custom');
  await expect(page.locator('#wc-minimize')).toHaveCSS('border-radius', '50%');
  await page.evaluate(() => void (document.querySelector('#win-controls') as HTMLElement).setAttribute('data-os', 'windows'));
  const close = await page.locator('#wc-close').boundingBox();
  expect(Math.round((close?.x ?? 0) + (close?.width ?? 0))).toBe(1280);
  expect(Math.round(close?.y ?? -1)).toBe(0);
  expect(Math.round(close?.width ?? 0)).toBe(46);
  expect(Math.round(close?.height ?? 0)).toBeGreaterThanOrEqual(43);
  await page.locator('#wc-close').hover();
  await expect(page.locator('#wc-close')).toHaveCSS('background-color', 'rgb(196, 43, 28)');
  await expect(page.locator('#wc-close')).toHaveCSS('color', 'rgb(255, 255, 255)');
});

test('macOS overlay leaves the traffic lights their corner; the system title bar (native) changes nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 'overlay');
  await expect(page.locator('#titlebar')).toHaveAttribute('data-tauri-drag-region', 'deep');
  await expect(page.locator('#win-controls')).toHaveCount(0);
  await expect(page.locator('#titlebar')).toBeVisible();
  await page.goto('about:blank');
  const fresh = await page.context().newPage();
  await fresh.setViewportSize({ width: 1280, height: 800 });
  await open(fresh, 'native');
  await expect(fresh.locator('#win-controls')).toHaveCount(0);
  // Signed out with the system's bar: no app title bar at all (as before).
  await expect(fresh.locator('#titlebar')).toBeHidden();
});

test('update pill: no card above the list, a popover panel with light dismiss, focus back to the pill', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 'custom');
  await signIn(page);
  await control('config', { update: UPDATE });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.checkUpdates());
  const pill = page.locator('#tb-update');
  await expect(pill).toHaveText('Update');
  await expect(page.locator('#update')).toBeHidden();
  // The pill takes no room from the timer: the right group grows to the left only.
  const timer = await page.locator('#timer-pill').boundingBox();
  await pill.click();
  await expect(page.locator('#update-pop')).toBeVisible();
  await expect(page.locator('#update-now')).toBeFocused();
  expect(await page.locator('#timer-pill').boundingBox()).toEqual(timer);
  // Under the pill, inside the window.
  const panel = await page.locator('#update-pop').boundingBox();
  expect((panel?.y ?? 0) >= 44).toBe(true);
  expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(1280);
  await axe(page, 'update panel');
  await page.mouse.click(300, 400);
  await expect(page.locator('#update-pop')).toBeHidden();
  await pill.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#update-pop')).toBeHidden();
  await expect(pill).toBeFocused();
  // A second click on the open pill closes it (the invoker is not a light dismiss).
  await pill.click();
  await expect(page.locator('#update-pop')).toBeVisible();
  await pill.click();
  await expect(page.locator('#update-pop')).toBeHidden();
});

test('title bar at 900 px (UXA-9): search becomes its icon, the organization and the timer keep their names', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await open(page, 'custom');
  await signIn(page);
  // Chat connected: the title bar shows its search.
  await page.locator('#tab-chat').click();
  await page.locator('#chat-connect').click();
  await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
  await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
  await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
  await expect(page.locator('.tb-ctx b')).toHaveText('Lumen Works');
  await page.locator('#tab-time').click();
  await page.locator('[data-task="T-104"] .row-action').click();
  await expect(page.locator('#timer-pill .tp-task')).toHaveText('Fix invoice rounding bug');
  await control('config', { update: UPDATE });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.checkUpdates());
  await expect(page.locator('#tb-update')).toBeVisible();
  // The organization's name is not cut; the search is a 32 px icon button with its name and Ctrl+K.
  expect(await page.locator('.tb-ctx b').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.locator('#tb-search')).toHaveAccessibleName('Search or jump to…');
  await expect(page.locator('#tb-search')).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
  expect(Math.round((await page.locator('#tb-search').boundingBox())?.width ?? 0)).toBe(32);
  // The task keeps at least a few characters before the ellipsis.
  expect((await page.locator('#timer-pill .tp-task').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(40);
  expect(await page.evaluate(() => document.scrollingElement?.scrollWidth)).toBe(900);
  await axe(page, '900 px');
});
