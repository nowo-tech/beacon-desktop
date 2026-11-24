import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/**
 * Wide windows: one responsive --content-max (31rem compact, 40rem full), the detail pane kept on Settings and "What we
 * collect", and the Settings tabs as a vertical list in the full layout (horizontal row with faded edges in compact).
 */
const MOCK = 'http://127.0.0.1:8787';
const SIZES = [400, 720, 900, 1280, 1440] as const;

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
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

/** Width of the current view's own container. */
const viewWidth = (page: Page) => page.locator('#view > *').first().evaluate((el) => Math.round(el.getBoundingClientRect().width));

/** Every tab fully inside the tablist, and the tablist does not scroll sideways. */
const tabsFit = (page: Page) =>
  page.locator('[role="tablist"]').evaluate((list) => {
    const box = list.getBoundingClientRect();
    const cut = [...list.querySelectorAll('[role="tab"]')].filter((tab) => {
      const r = tab.getBoundingClientRect();
      return r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1;
    });
    return { cut: cut.map((tab) => tab.id), sideways: list.scrollWidth > list.clientWidth + 1, orientation: list.getAttribute('aria-orientation') };
  });

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

for (const locale of ['en-US', 'es-ES'] as const) {
  test.describe(locale, () => {
    test.use({ locale });

    test(`main, Settings and What we collect share one width at ${SIZES.join(', ')} px; the tabs fit in the full layout`, async ({ page }) => {
      await page.setViewportSize({ width: 400, height: 800 });
      await signIn(page);
      for (const width of SIZES) {
        await page.setViewportSize({ width, height: 800 });
        const full = width >= 900;
        await expect(page.locator('#app')).toHaveAttribute('data-layout', full ? 'full' : 'compact');
        if (full) await page.locator('#nav-tasks').click();
        const widths: Record<string, number> = { main: await viewWidth(page) };
        if (full) await page.locator('#nav-settings').click();
        else await page.locator('#open-settings').click();
        await expect(page.locator('#settings')).toBeVisible();
        widths.settings = await viewWidth(page);
        const tabs = await tabsFit(page);
        await expect(page.locator('#detail')).toBeVisible({ visible: full });
        if (full) {
          expect(tabs, `${width} px`).toEqual({ cut: [], sideways: false, orientation: 'vertical' });
          expect(await axe(page), `${locale} ${width} settings`).toEqual([]);
        } else {
          expect(tabs.orientation).toBe('horizontal');
        }
        await page.locator('#settings-tab-general').click();
        await page.locator('#open-privacy').click();
        await expect(page.locator('#privacy')).toBeVisible();
        await expect(page.locator('#detail')).toBeVisible({ visible: full });
        widths.privacy = await viewWidth(page);
        // One width for the three; 40rem when the window has room for it, 31rem compact.
        expect(widths.settings, `${width} px`).toBe(widths.main);
        expect(widths.privacy, `${width} px`).toBe(widths.main);
        if (width < 900) expect(widths.main).toBeLessThanOrEqual(31 * 16);
        if (width >= 1280) expect(widths.main).toBe(40 * 16);
        await page.locator('#back').click();
        await page.locator('#back').click();
        await expect(page.locator('#main')).toBeVisible();
      }
      expect(await page.evaluate(() => document.scrollingElement?.scrollHeight ?? 0)).toBeLessThanOrEqual(800);
    });
  });
}

test('full layout: a vertical tablist with ↑/↓ (wrapping), Home, End and a visible focus; compact keeps the faded row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await page.locator('#nav-settings').click();
  const tablist = page.getByRole('tablist', { name: 'Settings sections' });
  await expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
  await page.locator('#settings-tab-general').focus();
  // The selected tab's side bar: a border, not only a colour.
  expect(await page.locator('#settings-tab-general').evaluate((el) => getComputedStyle(el, '::after').borderInlineStartWidth)).toBe('3px');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#settings-tab-shortcuts')).toBeFocused();
  await expect(page.locator('#settings-tab-shortcuts')).toHaveAttribute('aria-selected', 'true');
  // Keyboard focus: the ring drawn inside the tab.
  expect(await page.locator('#settings-tab-shortcuts').evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
  await expect(page.locator('#shortcut')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#settings-tab-shortcuts')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('#settings-tab-updates')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#settings-tab-general')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#settings-tab-updates')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('#settings-tab-general')).toBeFocused();

  // Back to the compact window: the same tablist turns horizontal, scrolls sideways and fades at its edge.
  await page.locator('#settings-tab-timer').click();
  await page.setViewportSize({ width: 400, height: 640 });
  await expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(page.locator('#settings-tab-timer')).toHaveAttribute('aria-selected', 'true');
  const row = await tablist.evaluate((el) => {
    const style = getComputedStyle(el);
    return { scrolls: el.scrollWidth > el.clientWidth, mask: style.maskImage || style.getPropertyValue('-webkit-mask-image'), fadeEnd: parseFloat(style.getPropertyValue('--fade-end')) };
  });
  expect(row.scrolls).toBe(true);
  expect(row.mask).toContain('linear-gradient');
  expect(row.fadeEnd).toBeGreaterThan(0);
  await page.locator('#settings-tab-timer').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#settings-tab-schedule')).toBeFocused();
});
