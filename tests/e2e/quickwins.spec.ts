import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Quick wins (desktop 0.5): "Continue last" (button and global shortcut), the three answers on return from idle with
 * the task picker, the screen lock / sleep pause and "Working without a timer?". The OS is mocked by the browser
 * platform's hooks (shortcut, lock events, idle counter, notifications); the API is the mock Beacon.
 */
const MOCK = 'http://127.0.0.1:8787';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

interface Hooks {
  idleSeconds: number;
  resumeShortcut: string | null;
  resumeShortcutPressed(): void;
  sessionEvent(event: string): void;
}
interface App {
  tick(): Promise<void>;
  refresh(): Promise<void>;
  lockedAt: Date | null;
  state: { nudge: { activeSince: string | null; measured: boolean; lastAt: string | null; recent: number[] } };
}
type Tt = { __timeTrack: { app: App; hooks: Hooks } };

const axe = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
};

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

/** A timer on T-101 that started an hour ago (mock and app use the real clock). */
async function hourOnT101(page: Page) {
  await page.locator('[data-task="T-101"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
  await control('timer/backdate', { seconds: 3600 });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
}

const entries = async () =>
  Object.values(((await control('state')) as { entries: Record<string, { taskId: string; startedAt: string }[]> }).entries)
    .flat()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((entry) => entry.taskId);

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`Still there?: Keep · Discard · Reassign, then the picker reassigns the idle time to a found task (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page);
    await hourOnT101(page);
    await page.evaluate(async () => {
      const tt = (window as unknown as Tt).__timeTrack;
      tt.hooks.idleSeconds = 700;
      await tt.app.tick();
    });
    const prompt = page.locator('#idle');
    await expect(prompt).toBeVisible();
    await expect(prompt.locator('.choice-list > button')).toHaveText(['Keep: yes, it was work', /^Discard: stop the timer at /, 'Reassign to another task…', 'I was in a meeting or call', /^Drop those \d+ min and keep going$/]);
    expect(await axe(page)).toEqual([]);
    await page.evaluate(() => void ((window as unknown as Tt).__timeTrack.hooks.idleSeconds = 1));
    await page.locator('#idle-reassign').click();
    await expect(page.locator('#reassign-search')).toBeFocused();
    await expect(page.locator('#reassign-meeting')).toHaveText('Meeting: Customer call: Acme quarterly review');
    await page.locator('#reassign-search').fill('invoice');
    await page.keyboard.press('Enter');
    await expect(page.locator('#reassign-status')).toHaveText('1 tasks found.');
    await expect(page.locator('#reassign-options input:checked')).toHaveValue('T-104');
    expect(await axe(page)).toEqual([]);
    await page.locator('#reassign-save').click();
    await expect(page.locator('#idle')).toHaveCount(0);
    await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
    await expect.poll(entries).toEqual(['T-101', 'T-104']);
  });
}

test('a screen lock counts as idle: on unlock, the three-choice question without a countdown', async ({ page }) => {
  await signIn(page);
  await hourOnT101(page);
  await page.evaluate(async () => {
    const tt = (window as unknown as Tt).__timeTrack;
    tt.hooks.sessionEvent('lock');
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Locked six minutes ago.
    tt.app.lockedAt = new Date(Date.now() - 6 * 60_000);
    tt.hooks.sessionEvent('unlock');
  });
  await expect(page.locator('#idle')).toBeVisible();
  await expect(page.locator('#idle-countdown')).toHaveCount(0);
  await page.locator('#idle-here').click();
  await expect(page.locator('#idle')).toHaveCount(0);
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
});

test('"Continue last": the timer card button and the global shortcut start the last task as a new entry', async ({ page }) => {
  await signIn(page);
  await page.locator('[data-task="T-102"] .row-action').click();
  await page.locator('#stop').click();
  await expect(page.locator('#resume')).toHaveText('Continue last');
  await expect(page.locator('#resume')).toHaveAttribute('aria-label', 'Continue last: “Review pull request queue” (new entry)');
  await expect(page.locator('#continue-shortcut')).toHaveText(/^Shortcut: /);
  expect(await axe(page)).toEqual([]);
  await page.locator('#resume').click();
  await expect(page.locator('#timer-task')).toHaveText('Review pull request queue');
  await page.locator('#stop').click();
  await expect(page.locator('#resume')).toBeVisible();
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.resumeShortcutPressed());
  await expect(page.locator('#timer-task')).toHaveText('Review pull request queue');
  await expect.poll(entries).toEqual(['T-102', 'T-102']);
});

test('"Working without a timer?" in working hours: a toast with Start and Choose task (no desktop notifications)', async ({ page }) => {
  // Tuesday 3 November 2026, 14:45 in Madrid, inside 09:00–18:00.
  await control('config', { workingHours: { timezone: 'Europe/Madrid', slots: [{ day: 2, from: '09:00', to: '18:00' }] } });
  await page.clock.setFixedTime(new Date('2026-11-03T13:45:00Z'));
  await signIn(page);
  await page.locator('[data-task="T-102"] .row-action').click();
  await page.locator('#stop').click();
  await expect(page.locator('#resume')).toBeVisible();
  await page.evaluate(async () => {
    const tt = (window as unknown as Tt).__timeTrack;
    tt.hooks.idleSeconds = 4;
    // Typing for eleven minutes already.
    tt.app.state = { ...tt.app.state, nudge: { activeSince: new Date(Date.now() - 11 * 60_000).toISOString(), measured: true, lastAt: null, recent: [] } };
    await tt.app.tick();
  });
  const toast = page.locator('#nudge');
  await expect(toast).toBeVisible();
  await expect(page.locator('#nudge-text')).toHaveText(/ Last task: Review pull request queue\.$/);
  await expect(page.locator('#nudge-resume')).toHaveText('Start Review pull request queue');
  expect(await axe(page)).toEqual([]);
  await page.locator('#nudge-choose').click();
  await expect(page.locator('#search')).toBeFocused();
  await expect(toast).toHaveCount(0);
});

test('Settings: the "Continue last" shortcut, the nudge and the lock switches are labelled and accessible', async ({ page }) => {
  await signIn(page);
  await page.keyboard.press('Control+,');
  await expect(page.locator('#helpers-title')).toHaveText('Continue, reminders and lock');
  await expect(page.locator('#resume-shortcut')).toHaveValue('CommandOrControl+Alt+Space');
  await expect(page.getByLabel('Remind me when I work without a timer during my working hours')).toBeChecked();
  await expect(page.getByLabel('Pause on screen lock or sleep')).toBeChecked();
  expect(await axe(page)).toEqual([]);
  await page.locator('#resume-shortcut').fill('Alt+F9');
  await page.locator('#resume-shortcut-save').click();
  await expect(page.locator('#resume-shortcut-message')).toHaveText('Shortcut set: Alt+F9');
  expect(await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.resumeShortcut)).toBe('Alt+F9');
});
