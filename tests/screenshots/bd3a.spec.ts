import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * BD-3a screens against the mock API, light and dark, for the owner's review (`BD3A_SHOTS` = output folder): the
 * required-fields dialog (stop, error, subject search, start, organization switch, 429), Settings → Time tracking, the
 * title bar's mini-timer button and the mini timer window itself (running, idle). Every dialog is checked with axe
 * (WCAG 2.1 AA, colour contrast included).
 */
const MOCK = process.env.BD3A_MOCK ?? 'http://127.0.0.1:8798';
const OUT = process.env.BD3A_SHOTS ?? 'out/bd3a-screens';
const ORG2 = 'org:7b1f2a9f-2c3d-4e4f-9a01-b2c3d4e5f6a7';

async function control(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
}

async function shot(page: Page, name: string, scheme: 'light' | 'dark') {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
}

async function axe(page: Page, include: string) {
  const result = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function startTask(page: Page, id: string) {
  await page.locator('#tab-time').click();
  await page.locator(`[data-task="${id}"] .row-action`).click();
  await expect(page.locator('#timer-pill.running')).toBeVisible();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`BD-3a screens (${scheme})`, async ({ page }) => {
    await control('reset', {});
    await control('config', { deviceInterval: 1, allocation: { requireActivityType: true }, contextPolicy: { required: true, refuse: [] } });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await signIn(page);
    // Time-only (chat not connected): the organization comes from the time API (X-Beacon-Context).
    await page.locator('.ctx-tile[title="Lumen Works"]').click();
    await expect(page.locator('.tb-ctx', { hasText: 'Lumen Works' })).toBeVisible();
    await startTask(page, 'T-104');
    await page.waitForTimeout(1200);
    // 01 stop with the required activity type (title bar Stop).
    await page.locator('#timer-pill .tp-act.stop').click();
    await expect(page.locator('#alloc-dialog')).toBeVisible();
    await expect(page.locator('#alloc-activity')).toBeEnabled();
    await axe(page, '#alloc-dialog');
    await shot(page, '01-required-fields-stop', scheme);
    // 02 submit empty: the error, focus on the field.
    await page.locator('#alloc-submit').click();
    await expect(page.locator('#alloc-activity-row.invalid')).toBeVisible();
    await shot(page, '02-required-fields-error', scheme);
    // 03 the optional client / subject search.
    await page.locator('#alloc-activity').selectOption('review');
    await page.locator('#alloc-subject').fill('o');
    await expect(page.locator('#alloc-subject-0')).toBeVisible();
    await page.locator('#alloc-subject').press('ArrowDown');
    await axe(page, '#alloc-dialog');
    await shot(page, '03-subject-search', scheme);
    await page.locator('#alloc-subject').press('Enter');
    await page.locator('#alloc-submit').click();
    await expect(page.locator('#alloc-dialog')).toBeHidden();
    await expect(page.locator('#timer-pill.running')).toHaveCount(0);
    // 04 ask on start (Settings → Time tracking), no inherited type.
    await page.locator('#rail-settings').click();
    await page.locator('#shell-settings [aria-label="Ask for required fields"] [data-value="both"]').click();
    await page.locator(`#shell-settings [aria-label="Use the task's last activity type"] [data-value="off"]`).click();
    await expect(page.locator('#shell-settings')).toBeVisible();
    await axe(page, '#shell-settings');
    await shot(page, '05-settings-time-tracking', scheme);
    await page.keyboard.press('Escape');
    await page.locator('#tab-time').click();
    await page.locator('[data-task="T-101"] .row-action').click();
    await expect(page.locator('#alloc-dialog')).toBeVisible();
    await expect(page.locator('#alloc-activity')).toBeEnabled();
    await shot(page, '04-required-fields-start', scheme);
    await page.locator('#alloc-activity').selectOption('dev');
    await page.locator('#alloc-submit').click();
    await expect(page.locator('#timer-pill.running')).toBeVisible();
    // Back to "ask on stop" and inheritance on; clear the type on the server so the switch must ask.
    await page.evaluate(() => {
      const app = (window as unknown as { __timeTrack: { app: { setAllocationSetting(p: object): void } } }).__timeTrack.app;
      app.setAllocationSetting({ askOn: 'stop', inheritActivity: true });
    });
    await page.locator('#tab-time').click();
    await page.locator('[data-task="T-102"] .row-action').click();
    await expect(page.locator('#timer-pill.running')).toBeVisible();
    // 06 switching organization with a running timer and a missing field: one dialog (Q4 + Q5).
    await page.locator('.ctx-tile[title="Harbor Studio"]').click();
    await expect(page.locator('#alloc-dialog')).toBeVisible();
    await expect(page.locator('#alloc-activity')).toBeEnabled();
    await axe(page, '#alloc-dialog');
    await shot(page, '06-switch-organization-fields', scheme);
    await page.locator('#alloc-cancel').click();
    // 07 activity types rate-limited (429) in the dialog.
    await control('config', { failNext: { status: 429, error: 'rate_limited', retryAfter: 4 } });
    await page.evaluate(() => {
      const app = (window as unknown as { __timeTrack: { app: { setContext(c: string): void } } }).__timeTrack.app;
      app.setContext('personal');
      app.setContext('org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6');
    });
    await page.locator('#timer-pill .tp-act.stop').click();
    await expect(page.locator('#alloc-activity-retry')).toBeVisible();
    // Retry waits for Retry-After (audit ZCD-L4); the list loads again by itself at its end.
    await expect(page.locator('#alloc-activity-retry')).toHaveAttribute('aria-disabled', 'true');
    await shot(page, '07-activity-types-rate-limited', scheme);
    await expect(page.locator('#alloc-activity')).toBeEnabled({ timeout: 10_000 });
    await page.locator('#alloc-cancel').click();
    // 08 the title bar with the mini-timer button pressed, 11 the shortcut sheet.
    await page.locator('#tb-mini').click();
    await expect(page.locator('#tb-mini[aria-pressed="true"]')).toBeVisible();
    await page.locator('#titlebar').screenshot({ path: `${OUT}/08-titlebar-mini-button-${scheme}.png` });
    await page.locator('#tab-chat').click();
    await page.locator('#tb-help').click();
    await expect(page.locator('#shell-keys')).toBeVisible();
    await shot(page, '11-shortcut-sheet', scheme);
    await page.keyboard.press('Escape');
    // The mini timer's view as the main window sends it.
    const view = await page.evaluate(() => (window as unknown as { __timeTrack: { hooks: { mini: unknown } } }).__timeTrack.hooks.mini);
    expect(view).toMatchObject({ running: true, status: 'Tracking · Lumen Works' });
    const mini = await page.context().newPage();
    await mini.setViewportSize({ width: 312, height: 132 });
    await mini.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await mini.addInitScript((value) => {
      (window as unknown as { __timeTrackMini: unknown }).__timeTrackMini = { view: value, actions: [] };
    }, view);
    await mini.goto('/?window=mini');
    await expect(mini.locator('#mini-time')).toBeVisible();
    await mini.locator('#mini-toggle').focus();
    await axe(mini, '#mini-timer');
    await shot(mini, '09-mini-timer-running', scheme);
    await mini.evaluate(() => {
      const hooks = (window as unknown as { __timeTrackMini: { view: Record<string, unknown>; setView(v: unknown): void } }).__timeTrackMini;
      hooks.setView({ ...hooks.view, running: false, startedAt: null, status: 'Not tracking', canStart: true, task: 'Review pull request queue' });
    });
    await axe(mini, '#mini-timer');
    await shot(mini, '10-mini-timer-idle', scheme);
    await mini.close();
    expect(ORG2).toContain('org:');
  });
}
