import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Meeting detection with the microphone mocked: the browser platform's `hooks.mic` stands for the Rust heartbeat's
 * `mic` events (src-tauri/src/meeting). Off by default; turned on in Settings; a Teams call asks after 2 minutes, a
 * task is chosen from the question, and the end of the call offers to stop.
 */
const MOCK = 'http://127.0.0.1:8787';
const T0 = Date.parse('2026-11-03T14:00:00Z');
const MIN = 60_000;

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

interface Hooks {
  notificationPermission: string;
  friendly: { title: string; body: string; pose: string | null; action?: { id: string; label: string } | null }[];
  wakePlan: { micEverySeconds?: number } | null;
  mic(signal: unknown): void;
  notificationAction(id: string): void;
}
type Tt = { __timeTrack: { hooks: Hooks } };

const axe = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
};

async function signIn(page: Page) {
  await page.clock.setFixedTime(new Date(T0));
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

/** Microphone reports every 20 s from `from` to `to` minutes after T0 (the page clock follows). */
async function call(page: Page, from: number, to: number, apps: string[]) {
  for (let at = from * MIN; at <= to * MIN; at += 20_000) {
    await page.clock.setFixedTime(new Date(T0 + at));
    await page.evaluate(([now, list]) => (window as unknown as Tt).__timeTrack.hooks.mic({ at: now, inUse: list.length > 0, apps: list, source: 'process' }), [T0 + at, apps] as [number, string[]]);
  }
}

test.use({ timezoneId: 'UTC' });

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`off by default; once on, a Teams call asks which meeting it is, and its end offers to stop (${scheme})`, async ({ page }) => {
    // Accessibility is checked once the toast has settled (no entry animation).
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await signIn(page);
    expect((await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.wakePlan))?.micEverySeconds).toBeUndefined();
    await call(page, 0, 3, ['teams']);
    await expect(page.locator('#meeting')).toHaveCount(0);

    await page.locator('#open-settings').click();
    const toggle = page.getByLabel("Notice when I'm in a call and ask what to record it as");
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('#meeting-privacy')).toContainText('never reads window titles, web addresses, chats or audio');
    await toggle.check();
    await expect(page.locator('#meeting-status')).toHaveText('Checking the microphone…');
    expect(await axe(page)).toEqual([]);
    expect((await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.wakePlan))?.micEverySeconds).toBe(20);
    await page.locator('#back').click();

    await call(page, 10, 11.9, ['teams']);
    await expect(page.locator('#meeting')).toHaveCount(0);
    await call(page, 12, 12, ['teams']);
    const question = page.getByRole('region', { name: 'Meeting' });
    await expect(question).toBeVisible();
    await expect(page.locator('#meeting-text')).toHaveText("Looks like you're in a meeting (Teams). Which meeting is it?");
    await expect(page.locator('#meeting img')).toHaveAttribute('data-pose', 'teamwork');
    expect(await axe(page)).toEqual([]);

    await page.getByRole('button', { name: 'Choose task' }).click();
    await page.getByRole('searchbox', { name: 'Search a task for this meeting' }).fill('acme');
    await expect(page.locator('#meeting-tasks li')).toHaveCount(1);
    await page.locator('#meeting-task-T-103').click();
    await expect(page.locator('#timer-task')).toHaveText('Customer call: Acme quarterly review');
    await expect(page.locator('#meeting')).toHaveCount(0);

    await call(page, 40, 41.5, []);
    await expect(page.locator('#meeting-text')).toHaveText('Meeting over (30 min). Stop the timer?');
    await page.locator('#meeting-stop').click();
    await expect(page.locator('#timer-task')).toHaveCount(0);
    await expect(page.locator('#meeting')).toHaveCount(0);
  });
}

test('a running task and a generic meeting: the notification switches, and "Back" returns to the task', async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => void ((window as unknown as Tt).__timeTrack.hooks.notificationPermission = 'granted'));
  await page.locator('#open-settings').click();
  await page.getByLabel("Notice when I'm in a call and ask what to record it as").check();
  await page.locator('#meeting-generic').selectOption('T-103');
  await page.locator('#back').click();
  await page.locator('[data-task="T-101"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');

  await call(page, 0, 2, ['browser']);
  await expect(page.locator('#meeting-text')).toHaveText("Looks like you're in a meeting (browser call) and the clock is still on Write onboarding guide. Switch to the meeting?");
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly.at(-1)?.action?.id ?? null)).toBe('meeting-switch');
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.notificationAction('meeting-switch'));
  await expect(page.locator('#timer-task')).toHaveText('Customer call: Acme quarterly review');

  await call(page, 3, 25, ['browser']);
  await call(page, 25 + 1 / 3, 26.5, []);
  await expect(page.locator('#meeting-text')).toHaveText('Meeting over (25 min). Back to Write onboarding guide?');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
});
