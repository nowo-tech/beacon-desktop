import { expect, test, type Page } from '@playwright/test';
import { BEACON, connect, control, dismissWelcome, reset } from './helpers';

/**
 * Review screenshots of the window layouts (`pnpm screenshots:layout`, Spanish): compact (400 × 640), the width between
 * the compact column and the breakpoint (720 × 640) and full (1280 × 800), light and dark. Written to $LAYOUT_SCREENS
 * (default out/layout-screens), not to the documentation images.
 */
const OUT = process.env.LAYOUT_SCREENS ?? 'out/layout-screens';
const SIZES = { compact: { width: 400, height: 640 }, middle: { width: 720, height: 640 }, full: { width: 1280, height: 800 } };

test.use({ locale: 'es-ES', timezoneId: 'UTC' });

/** A plausible week: entries on Monday … yesterday and earlier today (UTC), all before now. */
function weekEntries(now = Date.now()) {
  const midnight = now - (now % 86_400_000);
  const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
  const tasks = ['T-101', 'T-102', 'T-104', 'T-105', 'T-108'];
  const result: { taskId: string; startedAt: string; endedAt: string }[] = [];
  for (let day = weekday; day >= 1; day--) {
    const start = midnight - day * 86_400_000 + 8 * 3600_000;
    const blocks = [[0, 95], [110, 200], [260, 380], [395, 470]].slice(0, 2 + (day % 3));
    blocks.forEach(([from, to], index) => {
      result.push({ taskId: tasks[(day + index) % tasks.length], startedAt: new Date(start + from * 60_000).toISOString(), endedAt: new Date(start + to * 60_000).toISOString() });
    });
  }
  const today = Math.max(midnight, now - 4 * 3600_000);
  for (const [taskId, from, to] of [['T-102', 0, 55], ['T-101', 60, 150]] as const) {
    if (today + to * 60_000 < now) result.push({ taskId, startedAt: new Date(today + from * 60_000).toISOString(), endedAt: new Date(today + to * 60_000).toISOString() });
  }
  return result;
}

async function shot(page: Page, name: string) {
  const text = await page.locator('body').innerText();
  for (const leak of ['127.0.0.1', 'localhost', 'Ada', 'Acme']) expect(text, `${name} shows "${leak}"`).not.toContain(leak);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled', caret: 'hide' });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`window layouts — ${scheme}`, async ({ page }) => {
    await reset();
    await control('entries/seed', { entries: weekEntries() });
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(SIZES.compact);
    await control('device/approve', { userCode: await connect(page) });
    await expect(page.locator('#main li[data-task]')).toHaveCount(8, { timeout: 15_000 });
    await dismissWelcome(page);
    // A running timer, two pinned tasks.
    await page.locator('[data-task="T-104"] .row-action').click();
    await expect(page.locator('#timer-task')).toHaveText('Fix invoice rounding bug');
    await control('timer/backdate', { seconds: 47 * 60 });
    await page.evaluate(() => (window as unknown as { __timeTrack: { app: { refresh(): Promise<void> } } }).__timeTrack.app.refresh());
    for (const id of ['T-101', 'T-108']) await page.locator(`[data-task="${id}"] .pin`).click();
    await expect(page.locator('#quick .pin.pinned')).toHaveCount(2);
    await shot(page, `compact-${scheme}`);

    await page.setViewportSize(SIZES.middle);
    await expect(page.locator('#app')).toHaveAttribute('data-layout', 'compact');
    await shot(page, `middle-${scheme}`);

    await page.setViewportSize(SIZES.full);
    await expect(page.locator('#app')).toHaveAttribute('data-layout', 'full');
    await page.locator('[data-task="T-101"] .task').click();
    await expect(page.locator('#detail-title')).toHaveText('Write onboarding guide');
    await shot(page, `full-${scheme}`);

    await page.locator('#nav-time').click();
    await expect(page.locator('#time-week li')).toHaveCount(7);
    await shot(page, `full-my-time-${scheme}`);

    // UX batch 6 (UXA-2): the one Settings dialog opens from the rail's gear (the Time sidebar has no Settings entry).
    await page.locator('#rail-settings').click();
    await expect(page.locator('#shell-settings')).toBeVisible();
    await shot(page, `full-settings-${scheme}`);
    expect(BEACON).toContain('example.test');
  });
}
