import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/**
 * Native shell (0.5.0) with the OS mocked by the browser platform's hooks: friendly messages as desktop
 * notifications, the "Still there?" prompt in its own window (the main window only points to it), the prompt window
 * page itself, the tray pause item and the room the in-app toast leaves below the list.
 */
const MOCK = 'http://127.0.0.1:8787';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

interface Hooks {
  idleSeconds: number;
  nativePrompt: boolean;
  notificationPermission: string;
  friendly: { title: string; body: string; pose: string | null }[];
  prompt: { id: string; title: string; blocks: { kind: string }[] } | null;
  promptFocused: number;
  wakePlan: { deadlineAt: number | null; idleAfterSeconds: number | null } | null;
  trayMenu: { pauseFriendly: { id: string; label: string } | null } | null;
  wake(reason?: string): void;
  answerPrompt(answer: { action: string; note?: string }): void;
  trayAction(action: string): void;
}
type Tt = { __timeTrack: { app: { tick(): Promise<void>; refresh(): Promise<void>; updateTray(): Promise<void> }; hooks: Hooks } };

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

async function startLongTimer(page: Page, seconds: number) {
  await page.locator('[data-task="T-101"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
  await control('timer/backdate', { seconds });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
}

/**
 * Friendly messages depend on the time of day (coffee at 15:00, lunch, late work…) and on the working hours: the
 * tests that assert one run on a fixed clock, Tuesday 3 November 2026 14:00 UTC (no moment due in English), with no
 * working hours on the mock. Call before `signIn`.
 */
const QUIET_HOUR = new Date('2026-11-03T14:00:00Z');
async function quietClock(page: Page) {
  await page.clock.setFixedTime(QUIET_HOUR);
}

/** A timer on T-101 that has run `seconds` by the fixed clock (the mock's own clock is the real one). */
async function runningFor(page: Page, seconds: number) {
  await page.locator('[data-task="T-101"] .row-action').click();
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
  await page.evaluate((ago) => {
    const app = (window as unknown as { __timeTrack: { app: { state: { activeTimer: { startedAt: string } | null }; render(): void } } }).__timeTrack.app;
    app.state = { ...app.state, activeTimer: { ...(app.state.activeTimer as { startedAt: string }), startedAt: new Date(Date.now() - ago * 1000).toISOString() } };
    app.render();
  }, seconds);
}

test.use({ timezoneId: 'UTC' });

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

test('a friendly message goes out as a desktop notification, not as a toast; the window explains it once', async ({ page }) => {
  await quietClock(page);
  await signIn(page);
  await page.evaluate(() => void ((window as unknown as Tt).__timeTrack.hooks.notificationPermission = 'granted'));
  await runningFor(page, 2 * 3600 + 60);
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.wake('tick'));
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly.length)).toBe(1);
  const [sent] = await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.friendly);
  expect(sent?.title).toBe('Milestone!');
  // The line is picked at random from the milestone pool; one of its six lines carries no hour count.
  expect(sent?.body).toMatch(/\b2 hours\b|^Another big chunk done\./);
  expect(sent?.pose).toMatch(/^[a-z-]+$/);
  await expect(page.locator('#cheer')).toHaveCount(0);
  const notice = page.getByRole('region', { name: 'Friendly messages now pop up on your desktop' });
  await expect(notice).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.locator('#native-notice-ok').click();
  await expect(notice).toHaveCount(0);
});

test('denied by the OS: the toast stays and Settings says so', async ({ page }) => {
  await quietClock(page);
  await signIn(page);
  await page.evaluate(() => void ((window as unknown as Tt).__timeTrack.hooks.notificationPermission = 'denied'));
  await runningFor(page, 2 * 3600 + 60);
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.tick());
  await expect(page.locator('#cheer')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Desktop notifications are off' })).toBeVisible();
  await page.locator('#rail-settings').click();
  await page.locator('#settings-tab-notifications').click();
  await expect(page.locator('#native-status')).toContainText('turned off for Beacon Desktop');
  await expect(page.getByLabel('Show them as desktop notifications')).toBeChecked();
});

test('"Still there?" opens in its own window: the main window points to it and the answer closes it', async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => void ((window as unknown as Tt).__timeTrack.hooks.nativePrompt = true));
  await startLongTimer(page, 3600);
  const plan = await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.wakePlan);
  expect(plan?.idleAfterSeconds).toBeGreaterThan(0);
  // The host's heartbeat reports the idle threshold (window hidden or not).
  await page.evaluate(() => {
    const tt = (window as unknown as Tt).__timeTrack;
    tt.hooks.idleSeconds = 660;
    tt.hooks.wake('idle');
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.prompt?.id ?? null)).toBe('idle');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#timer')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#prompt-elsewhere-text')).toContainText('its own window');
  expect((await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.wakePlan))?.deadlineAt).toBeGreaterThan(Date.now());
  await page.locator('#prompt-show').click();
  expect(await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.promptFocused)).toBe(1);
  expect(await axe(page)).toEqual([]);
  await page.evaluate(() => {
    const tt = (window as unknown as Tt).__timeTrack;
    tt.hooks.idleSeconds = 0;
    tt.hooks.answerPrompt({ action: 'here' });
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.prompt)).toBeNull();
  await expect(page.locator('#prompt-elsewhere')).toHaveCount(0);
  await expect(page.locator('#timer-task')).toHaveText('Write onboarding guide');
});

test('tray: pause friendly messages for an hour and resume', async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.updateTray());
  const item = () => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.trayMenu?.pauseFriendly ?? null);
  expect(await item()).toEqual({ id: 'pause-friendly', label: 'Pause friendly messages for 1 h' });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.trayAction('pause-friendly'));
  await expect.poll(async () => (await item())?.id).toBe('resume-friendly');
  await page.locator('#rail-settings').click();
  await page.locator('#settings-tab-notifications').click();
  await expect(page.locator('#friendly-paused-text')).toContainText('Paused until');
  await page.locator('#friendly-resume').click();
  await expect.poll(async () => (await item())?.id).toBe('pause-friendly');
});

test('the in-app toast never covers the last task rows nor the footer', async ({ page }) => {
  await quietClock(page);
  await signIn(page);
  await runningFor(page, 2 * 3600 + 60);
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.tick());
  const toast = page.locator('#cheer');
  await expect(toast).toBeVisible();
  await expect(page.locator('#app')).toHaveClass(/with-toasts/);
  // The list scrolls inside its own container; the toast's room is added below its last row.
  await page.locator('#task-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const last = page.locator('#tasks li').last();
  const [row, card] = [await last.boundingBox(), await toast.boundingBox()];
  expect(row !== null && card !== null && row.y + row.height <= card.y).toBe(true);
  // The footer ("Signed in as …") ends above the toast too (audit L3).
  const footer = await page.locator('#main .footer').boundingBox();
  expect(footer !== null && card !== null && footer.y + footer.height <= card.y).toBe(true);
});

const VIEW = {
  id: 'idle',
  moment: 'stillThere',
  pose: 'peek',
  title: 'Still there?',
  windowTitle: 'Still there?',
  lang: 'en',
  theme: null,
  escapeHint: 'This question needs an answer: choose one of the options.',
  openApp: 'Open Beacon Desktop',
  focus: null,
  focusSeq: 0,
  blocks: [
    { kind: 'text', id: 'idle-quip', text: 'Knock knock… still with me?', tone: 'quip', lang: 'en' },
    { kind: 'text', id: 'idle-text', text: 'No activity for 10 min on Write onboarding guide.' },
    { kind: 'text', text: 'Last activity at 10:41.', tone: 'muted' },
    {
      kind: 'choices',
      layout: 'list',
      labelledBy: 'idle-title',
      items: [
        { kind: 'button', id: 'idle-here', label: 'Yes, I was working', style: 'primary', action: 'here' },
        { kind: 'button', id: 'idle-meeting', label: 'I was in a meeting or a call', style: 'secondary', action: 'meeting-open', expanded: false },
        { kind: 'button', id: 'idle-discard', label: 'Discard the 10 min', style: 'secondary', action: 'discard' },
        { kind: 'button', id: 'idle-pause', label: 'Pause at 10:41', style: 'secondary', action: 'pause' },
      ],
    },
    { kind: 'countdown', askedAt: new Date().toISOString(), totalSeconds: 120, template: 'The timer pauses in {time} if there is no answer.' },
  ],
};

for (const scheme of ['light', 'dark'] as const) {
  test(`the prompt window page (${scheme}): accessible, keyboard only, Esc keeps it, answers go to the main window`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.addInitScript((view) => {
      (window as unknown as { __timeTrackPrompt: unknown }).__timeTrackPrompt = { view, answers: [] };
    }, VIEW);
    await page.setViewportSize({ width: 440, height: 560 });
    await page.goto('/?window=prompt');
    const dialog = page.getByRole('dialog', { name: 'Still there?' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('#idle-here')).toBeFocused();
    await expect(page.locator('#idle-countdown-text')).toContainText(/The timer pauses in [0-2]:\d\d/);
    await expect(page).toHaveTitle('Still there?');
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Tab');
    await expect(page.locator('#idle-meeting')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#prompt-escape-hint')).toHaveText(VIEW.escapeHint);
    await expect(page.locator('#idle-here')).toBeFocused();
    await page.keyboard.press('Enter');
    const answers = await page.evaluate(() => (window as unknown as { __timeTrackPrompt: { answers: unknown[] } }).__timeTrackPrompt.answers);
    expect(answers).toEqual([{ action: 'escape' }, { action: 'here' }]);
  });
}
