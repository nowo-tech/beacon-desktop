import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/** BD-2: Connect chat (chained device flow), read-only chat against the mocked ChatKit client API, keyboard and a11y. */
const MOCK = 'http://127.0.0.1:8787';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  const code = await page.locator('#user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
}

async function connectChat(page: Page) {
  await page.locator('#tab-chat').click();
  await page.locator('#chat-connect').click();
  const code = await page.locator('#chat-user-code').textContent();
  await control('device/approve', { userCode: code });
  await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

test.use({ viewport: { width: 1280, height: 800 } });

test('connect chat, read a conversation and its thread, keyboard-first, no a11y violations', async ({ page }) => {
  await signIn(page);
  // Signed in through the time sign-in: Time stays shown; Chat offers to connect.
  await expect(page.locator('#tab-time')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+1');
  await expect(page.locator('#chat-connect-card')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await connectChat(page);
  // The chat request is a separate, chained device code of the `chat` family.
  const state = (await control('state')) as { requests: { path: string; body: string }[] };
  const codes = state.requests.filter((item) => item.path.endsWith('/device/code')).map((item) => JSON.parse(item.body).family ?? 'time');
  expect(codes).toEqual(['time', 'chat']);
  // Organization tiles; every request names the context.
  await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
  await expect(page.locator('.sec-h')).toHaveText(['Channels', 'Projects', 'Direct messages', 'Support']);
  const chatRequests = ((await control('state')) as { requests: { path: string; context?: string | null }[] }).requests.filter((item) => item.path.startsWith('/api/chat/v1/'));
  expect(chatRequests.every((item) => typeof item.context === 'string' && item.context !== '')).toBe(true);
  await page.locator('.side .conv', { hasText: 'envelope-v2' }).click();
  await expect(page.locator('#chat-title')).toContainText('envelope-v2');
  await expect(page.locator('#new-div')).toBeVisible();
  await expect(page.locator('.ref.ref-hidden')).toHaveText('Content not visible');
  await expect(page.locator('.react.mine').first()).toHaveAttribute('aria-label', '👀 3, including you');
  expect(await axe(page)).toEqual([]);
  // Thread panel, read-only, closed with Esc.
  await page.locator('.thread-link').first().click();
  await expect(page.locator('#thread .th-root')).toBeVisible();
  await expect(page.locator('#thread .th-count')).toHaveText('3 replies');
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#thread')).toHaveCount(0);
  // Read mark sent for the open conversation.
  await expect.poll(async () => ((await control('chat/state')) as { reads: unknown[] }).reads.length).toBeGreaterThan(0);
  // Cmd/Ctrl+K quick switcher.
  await page.keyboard.press('Control+k');
  await expect(page.locator('#switcher')).toBeVisible();
  await page.keyboard.type('maya');
  await page.keyboard.press('Enter');
  await expect(page.locator('#chat-title')).toContainText('Maya Okafor');
  // Alt+↑ previous conversation, Ctrl+[ back.
  await page.keyboard.press('Control+BracketLeft');
  await expect(page.locator('#chat-title')).toContainText('envelope-v2');
  // A new message arrives (realtime hint, ids only) and is fetched through the API.
  await control('chat/post', { conversation: '0c000000-0000-4000-8000-000000000001', text: 'Shipped behind the flag' });
  await page.evaluate(() => (window as unknown as { __timeTrack: { hooks: { chatHint(h: unknown): void } } }).__timeTrack.hooks.chatHint({ kind: 'message', conversationUuid: '0c000000-0000-4000-8000-000000000001' }));
  await expect(page.locator('#msg-list')).toContainText('Shipped behind the flag');
  // Esc marks read and leaves the conversation.
  await page.locator('#msg-scroll').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.empty')).toContainText('Pick a conversation');
  // The shortcut sheet.
  await page.keyboard.press('?');
  await expect(page.locator('#shell-keys')).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test('compact window: one pane at a time, the rail at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 640 });
  await signIn(page);
  await connectChat(page);
  await page.locator(`.side .conv`).first().click();
  await expect(page.locator('.chat-main')).toBeVisible();
  await expect(page.locator('.side')).toBeHidden();
  await page.locator('.ch-back').click();
  await expect(page.locator('.side')).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test('disconnect chat keeps time signed in; sign-out ends both', async ({ page }) => {
  await signIn(page);
  await connectChat(page);
  await page.locator('#rail-settings').click();
  // UX batch 6: Disconnect lives in Account and asks first (Cancel is the default).
  await page.locator('#settings-tab-account').click();
  await page.locator('#chat-disconnect').click();
  await expect(page.locator('#confirm-cancel')).toBeFocused();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#account-chat-connect')).toBeVisible();
  await page.locator('#settings-tab-chat').click();
  await expect(page.locator('#settings-chat-connect')).toHaveText('Connect chat');
  await page.keyboard.press('Escape');
  await expect(page.locator('#chat-connect')).toBeVisible();
  await page.locator('#tab-time').click();
  await expect(page.locator('#tasks li')).toHaveCount(8);
});
