import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Meeting reminders (contract §23) against the mock's `GET me/meetings` (TimeTrack 1.14): Settings → Meeting reminders,
 * the *Today* list with *Join*, a reminder toast with *Snooze*, and an older server without the feature.
 */
const MOCK = 'http://127.0.0.1:8787';
const T0 = Date.parse('2026-11-03T14:00:00Z');
const MIN = 60_000;
const JOIN = 'https://meet.google.com/abc-defg-hij';
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

interface Hooks {
  opened: string[];
  wake(reason?: string): void;
  trayMenu: { meetingsLabel?: string | null; meetings?: { id: string; label: string }[] } | null;
}
type Tt = { __timeTrack: { hooks: Hooks } };

const axe = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
};

function meeting(id: string, startMin: number, extra: Record<string, unknown> = {}) {
  return {
    id: `mtg_${id.padEnd(16, '0')}`,
    start: iso(T0 + startMin * MIN),
    end: iso(T0 + (startMin + 30) * MIN),
    timeZone: 'UTC',
    allDay: false,
    date: null,
    busy: true,
    private: false,
    title: `Design review ${id}`,
    joinUrl: JOIN,
    joinProvider: 'meet',
    organizerIsMe: false,
    attendees: [{ id: 'u1', name: 'Luis Pérez' }],
    externalCount: 1,
    taskLinks: [],
    updatedAt: iso(T0 - 60 * MIN),
    ...extra,
  };
}

const MEETINGS = {
  status: 'connected',
  refreshAfterSeconds: 300,
  calendarsUrl: `${MOCK}/account/calendars`,
  list: [meeting('a', 30), meeting('p', 90, { private: true, title: null, attendees: [], externalCount: null })],
};

async function signIn(page: Page) {
  await page.clock.setFixedTime(new Date(T0));
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
  const welcome = page.locator('#welcome-dismiss');
  if (await welcome.isVisible()) await welcome.click();
}

test.use({ timezoneId: 'UTC' });

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1, meetings: MEETINGS });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`Settings → Meeting reminders: on with a calendar, lead presets and custom, switches; accessible (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await signIn(page);
    await page.locator('#open-settings').click();
    await page.locator('#settings-tab-meetings').click();
    const section = page.getByRole('region', { name: 'Meeting reminders' });
    await expect(section).toBeVisible();
    const toggle = page.getByLabel('Remind me before my meetings');
    await expect(toggle).toBeChecked();
    await expect(page.locator('#meeting-reminders-privacy')).toContainText('Private meetings show as “Busy”');
    const lead = page.locator('#meeting-lead');
    await expect(lead).toHaveValue('5');
    await lead.selectOption('custom');
    const custom = page.locator('#meeting-lead-custom');
    await custom.fill('130');
    await custom.press('Tab');
    await expect(page.locator('#meeting-lead-error')).toHaveText('Enter a whole number of minutes from 1 to 120.');
    await page.locator('#meeting-lead-custom').fill('45');
    await page.locator('#meeting-lead-custom').press('Tab');
    await expect(page.locator('#meeting-lead-error')).toHaveCount(0);
    await expect(page.locator('#meeting-lead-custom')).toHaveValue('45');
    await page.getByLabel('Remind me outside working hours').check();
    await page.getByLabel('Pause my timer automatically when a meeting starts').check();
    await expect(page.getByLabel('When a meeting starts and a timer is running, ask what to record')).toBeChecked();
    expect(await axe(page)).toEqual([]);
    await toggle.uncheck();
    await expect(page.locator('#meeting-reminders-options')).toHaveCount(0);
    await page.locator('#back').click();
    await expect(page.locator('#meetings-today')).toHaveCount(0);
  });
}

test('Today lists the remaining meetings with Join (private ones as Busy); the reminder toast snoozes', async ({ page }) => {
  // Accessibility is checked once the toast has settled (no entry animation).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page);
  const today = page.getByRole('region', { name: "Today's meetings" });
  await expect(today).toBeVisible();
  await expect(today.locator('li')).toHaveCount(2);
  await expect(today.locator('li').nth(0)).toContainText('Design review a');
  await expect(today.locator('li').nth(1)).toContainText('Busy');
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.trayMenu?.meetings?.length ?? 0)).toBe(2);
  await today.getByRole('button', { name: 'Join Design review a' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.opened.at(-1))).toBe(JOIN);
  expect(await axe(page)).toEqual([]);

  // Five minutes before: the reminder in the window (no desktop notifications in a plain browser).
  await page.clock.setFixedTime(new Date(T0 + 25 * MIN));
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.wake('reminder'));
  const toast = page.getByRole('region', { name: 'Meeting reminder' });
  await expect(toast).toBeVisible();
  await expect(page.locator('#meeting-reminder-title')).toHaveText('Design review a');
  await expect(page.locator('#meeting-reminder-text')).toContainText('in 5 min · Luis · +1 external');
  expect(await axe(page)).toEqual([]);
  await toast.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(toast).toHaveCount(0);
  // Back one minute before the start.
  await page.clock.setFixedTime(new Date(T0 + 29 * MIN));
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.wake('reminder'));
  await expect(page.locator('#meeting-reminder-text')).toContainText('in 1 min');
  await toast.getByRole('button', { name: 'Join' }).click();
  await expect(toast).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as Tt).__timeTrack.hooks.opened.filter((url) => url === 'https://meet.google.com/abc-defg-hij').length)).toBe(2);
});

test('an older server: no reminders, and Settings says why', async ({ page }) => {
  await control('config', { meetings: null, meetingsScope: false });
  await signIn(page);
  await expect(page.locator('#meetings-today')).toHaveCount(0);
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-meetings').click();
  await expect(page.locator('#meeting-reminders-unavailable')).toContainText('TimeTrack 1.14');
  await expect(page.getByLabel('Remind me before my meetings')).toBeDisabled();
  const state = (await control('state')) as { requests: { path: string }[] };
  expect(state.requests.some((request) => request.path.endsWith('me/meetings'))).toBe(false);
});
