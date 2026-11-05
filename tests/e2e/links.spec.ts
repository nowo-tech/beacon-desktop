import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** 0.5.0: Settings → Open Beacon in, Copy link and the empty states, in the real UI on the fake platform. */
const MOCK = 'http://127.0.0.1:8787';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

type Choice = { kind: string; id?: string; path?: string; name?: string };
type Hooks = { browsers: { id: string; name: string }[]; opened: string[]; openedWith: Choice[]; copied: string[]; pickResult: Choice | null };
type Tt = { __timeTrack: { app: { tasks: unknown[]; entries: unknown[] | null; state: { pinned: unknown[]; lastTask: unknown }; render(): void }; hooks: Hooks } };

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

test('Settings → Open Beacon in: detected browsers, Custom…, used for every link', async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => {
    const hooks = (window as unknown as Tt).__timeTrack.hooks;
    hooks.browsers = [
      { id: 'win:brave', name: 'Brave' },
      { id: 'win:firefox.exe', name: 'Mozilla Firefox' },
    ];
    hooks.pickResult = { kind: 'custom', path: 'C:\\Tools\\Brave\\brave.exe', name: 'brave' };
  });
  await page.locator('#open-settings').click();
  const select = page.getByLabel('Open Beacon in');
  await expect(select).toHaveValue('system');
  await expect(select.locator('option')).toHaveText(['System default browser', 'Brave', 'Mozilla Firefox', 'Custom…']);
  await select.selectOption({ label: 'Brave' });
  await expect(select).toHaveValue('detected:win:brave');
  const { violations } = await new AxeBuilder({ page }).include('#browser-settings').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);

  // The device flow opened the sign-in page with the system default; later links use Brave.
  await page.locator('#back').click();
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.render());
  const opened = await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.openedWith);
  expect(opened).toEqual([{ kind: 'system' }]);

  // Custom… opens the file picker and keeps its result (stored on this computer, survives a reload).
  await page.locator('#open-settings').click();
  await select.selectOption('custom');
  await expect(page.locator('#browser-path')).toHaveText('C:\\Tools\\Brave\\brave.exe');
  await expect(select).toHaveValue('custom-current');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('time-track-desktop') ?? '{}').settings.browser);
  expect(stored).toEqual({ kind: 'custom', path: 'C:\\Tools\\Brave\\brave.exe', name: 'brave' });
});

test('empty states: one slot, one action each', async ({ page }) => {
  await signIn(page);
  const set = (kind: string) =>
    page.evaluate((state) => {
      const app = (window as unknown as Tt).__timeTrack.app;
      app.entries = [];
      app.state.pinned = [];
      app.state.lastTask = state === 'pinned' ? { id: 'T-101', title: 'Old task' } : null;
      if (state === 'tasks') app.tasks = [];
      app.render();
    }, kind);
  await set('recent');
  const recent = page.locator('#quick-empty');
  await expect(recent).toHaveAttribute('data-empty', 'recent');
  // Picture box relative to its slot, and the slot's height: the same in every state.
  const place = () =>
    recent.evaluate((slot) => {
      const outer = slot.getBoundingClientRect();
      const image = slot.querySelector('.empty-art')!.getBoundingClientRect();
      return { dx: image.left - outer.left, dy: image.top - outer.top, width: image.width, height: image.height, slot: outer.height };
    });
  const recentBox = await place();
  await page.locator('#quick-empty-action').click();
  await expect(page.locator('#search')).toBeFocused();
  await set('pinned');
  await expect(recent).toHaveAttribute('data-empty', 'pinned');
  const pinnedBox = await place();
  // Same size and place.
  expect(pinnedBox).toEqual(recentBox);
  expect(pinnedBox?.width).toBe(72);
  await page.locator('#quick-empty-action').click();
  await expect(page.locator('#notice')).toContainText('pin');
  await set('tasks');
  await expect(page.locator('#tasks-empty')).toHaveAttribute('data-empty', 'tasks');
  await expect(page.locator('#tasks-empty img.theme-light')).toHaveAttribute('alt', /robot/);
  await expect(page.locator('#tasks-empty img.theme-light')).toBeVisible();
  await expect(page.locator('#tasks-empty img.theme-dark')).toBeHidden();
  const { violations } = await new AxeBuilder({ page }).include('#tasks-empty').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
});
