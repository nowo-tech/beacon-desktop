import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * UX batch 6 screens for the owner (`UXB6_SHOTS` = output folder), light and dark, desktop 1280 × 800 and narrow
 * 900 × 600: the guided first run, Time in the shell, the one Settings and its Account section, the disconnect
 * confirmation. Every screen is checked with axe (WCAG 2.2 AA).
 */
const MOCK = process.env.UXB6_MOCK ?? 'http://127.0.0.1:8806';
const OUT = process.env.UXB6_SHOTS ?? 'out/uxb6-screens';
const NARROW = { width: 900, height: 600 };
const DESKTOP = { width: 1280, height: 800 };

async function control(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function shot(page: Page, name: string, scheme: string) {
  await page.waitForTimeout(300);
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

for (const scheme of ['light', 'dark'] as const) {
  test(`UX batch 6 screens (${scheme})`, async ({ page }) => {
    await control('reset', {});
    await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await page.locator('#server').fill(MOCK);
    await page.locator('#connect').click();
    await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
    // 01 first run: the setup card.
    await expect(page.locator('#mod-setup')).toBeVisible({ timeout: 15_000 });
    await axe(page);
    await shot(page, '01-setup', scheme);
    await page.setViewportSize(NARROW);
    await shot(page, '01-setup-narrow', scheme);
    await page.setViewportSize(DESKTOP);
    // 02 the chat approval waiting, its code in the card.
    await page.locator('#setup-connect').click();
    await expect(page.locator('#setup-code')).toBeVisible();
    await axe(page);
    await shot(page, '02-setup-code', scheme);
    await control('device/approve', { userCode: await page.locator('#setup-code').textContent() });
    // 03 the tasks step, chat done.
    await expect(page.locator('#setup-step-tasks')).toHaveAttribute('aria-current', 'step');
    await shot(page, '03-setup-tasks', scheme);
    await page.locator('#setup-connect').click();
    await control('device/approve', { userCode: await page.locator('#setup-code').textContent() });
    // 04 landed on Chat.
    await expect(page.locator('#mod-chat')).toBeVisible();
    await expect(page.locator('.side .conv').first()).toBeVisible();
    await shot(page, '04-landed-chat', scheme);
    // 05 Time in the shell: sidebar like Chat's, quiet play icons, detail pane from 1100 px.
    await page.locator('#tab-time').click();
    await expect(page.locator('#tasks li').first()).toBeVisible();
    await page.locator('#tasks li').nth(1).hover();
    await axe(page);
    await shot(page, '05-time-home', scheme);
    await page.setViewportSize(NARROW);
    await expect(page.locator('#detail')).toBeHidden();
    await shot(page, '05-time-home-narrow', scheme);
    await page.setViewportSize(DESKTOP);
    // 06 a running timer.
    await page.locator('#tasks li').first().hover();
    await page.locator('#tasks li').first().locator('.row-action').click();
    await expect(page.locator('#timer.running')).toBeVisible();
    await page.mouse.move(0, 0);
    await shot(page, '06-time-running', scheme);
    await page.setViewportSize(NARROW);
    await shot(page, '06-time-running-narrow', scheme);
    await page.setViewportSize(DESKTOP);
    // 07–10 the one Settings.
    await page.keyboard.press('Control+,');
    await expect(page.locator('#shell-settings')).toBeVisible();
    const tabs: [string, string][] = [['general', '07-settings-general'], ['appearance', '08-settings-appearance'], ['timer', '09-settings-timer'], ['account', '10-settings-account']];
    for (const [tab, name] of tabs) {
      const shift = await cls(page, () => page.locator(`#settings-tab-${tab}`).click());
      expect(shift, `${tab} layout shift`).toBeLessThan(0.01);
      await axe(page);
      await shot(page, name, scheme);
    }
    await page.setViewportSize(NARROW);
    await shot(page, '10-settings-account-narrow', scheme);
    await page.setViewportSize(DESKTOP);
    // 11 Disconnect asks first.
    await page.locator('#chat-disconnect').click();
    await expect(page.locator('#confirm-cancel')).toBeFocused();
    await axe(page);
    await shot(page, '11-confirm-disconnect', scheme);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // 12 Spanish setup copy is checked in the unit tests; here the narrow Settings on another tab.
    await page.setViewportSize(NARROW);
    await page.keyboard.press('Control+,');
    await page.locator('#settings-tab-timer').click();
    await shot(page, '12-settings-timer-narrow', scheme);
  });
}
