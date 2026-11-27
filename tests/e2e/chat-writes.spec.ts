import { expect, test, type Page } from '@playwright/test';
import { axe } from './axe';

/**
 * BD-3b: chat writes against the mocked ChatKit 2.5 client API in a real browser: the message box (keyboard only),
 * sending with an Idempotency-Key, Retry after a failure with the same key, a thread reply, reactions with the picker,
 * light and dark, axe (WCAG 2.1 AA) on every new surface.
 */
const MOCK = 'http://127.0.0.1:8787';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';

type Write = { key: string; replayed: boolean; kind?: string; method?: string };

async function control(path: string, body?: unknown) {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

const writes = async () => ((await control('chat/state')) as { writes: Write[] }).writes;

async function openEnvelope(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('#tab-chat').click();
  await page.locator('#chat-connect').click();
  await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
  await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
  await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
  await page.locator('.side .conv', { hasText: 'envelope-v2' }).click();
  await expect(page.locator('#composer')).toBeVisible();
}

test.beforeEach(async () => {
  await control('reset', {});
  await control('config', { deviceInterval: 1 });
});

test.use({ viewport: { width: 1280, height: 800 } });

for (const scheme of ['light', 'dark'] as const) {
  test(`send, retry with the same key, reply in a thread, react — keyboard only, axe clean (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openEnvelope(page);
    // The chat token asked for sending as well.
    const requests = ((await control('state')) as { requests: { path: string; body: string }[] }).requests.filter((item) => item.path.endsWith('/device/code'));
    expect(JSON.parse(requests.at(-1)?.body ?? '{}').scopes).toEqual(['chat:read', 'chat:write']);
    expect(await axe(page)).toEqual([]);
    // C focuses the box; Shift+Enter adds a line; Enter sends.
    await page.locator('#msg-scroll').focus();
    await page.keyboard.press('c');
    await expect(page.locator('#composer')).toBeFocused();
    await page.keyboard.type('Rollback plan looks good.');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Shipping after lunch.');
    await expect(page.locator('#composer')).toHaveValue('Rollback plan looks good.\nShipping after lunch.');
    await page.keyboard.press('Enter');
    await expect(page.locator('#composer')).toHaveValue('');
    await expect(page.locator('#msg-list li.msg').last()).toContainText('Shipping after lunch.');
    // Markdown comes back rendered (bold), never as raw markers.
    await page.keyboard.type('Bold **works**');
    await page.keyboard.press('Enter');
    await expect(page.locator('#msg-list li.msg').last().locator('.m-body strong')).toHaveText('works');
    await expect(page.locator('#msg-list li.msg').last()).not.toContainText('**');
    await expect(page.locator('#msg-list li.msg.pending')).toHaveCount(0);
    expect((await writes()).filter((write) => write.kind === 'send')).toHaveLength(2);
    // A send the server could not take waits in the queue (UXA-6) and keeps its key: Try now is written once.
    // The server keeps refusing writes for a while (the queue's own probe gets 503s too), then recovers.
    await control('config', { chatFailNext: { status: 503, error: 'server_error', writesOnly: true, times: 1000 } });
    await page.keyboard.type('Second try');
    await page.keyboard.press('Enter');
    await expect(page.locator('#msg-list li.msg.pending.queued')).toContainText('Waiting for connection');
    expect(await axe(page)).toEqual([]);
    const waiting = page.locator('#msg-list li.msg.pending.queued');
    // Waiting, not failed: no flicker to "Sending…" while the queue probes, Try now and Cancel stay.
    await expect(waiting.getByRole('button', { name: 'Try now' })).toBeVisible();
    await expect(waiting.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(page.locator('#msg-list li.msg.pending.failed')).toHaveCount(0);
    // The server takes writes again: Try now sends it (unless the queue's own probe got there first).
    await control('config', { chatFailNext: null });
    await expect(async () => {
      if ((await waiting.count()) > 0) await waiting.getByRole('button', { name: 'Try now' }).click({ timeout: 1000 });
      await expect(page.locator('#msg-list li.msg.pending')).toHaveCount(0, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    expect((await writes()).filter((write) => write.kind === 'send' && !write.replayed)).toHaveLength(3);
    // ↑ from the empty box to the last message, then up to the thread root; R replies in its thread.
    await page.locator('#composer').focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#msg-list li.msg').last()).toBeFocused();
    const root = page.locator('#msg-list li.msg', { has: page.locator('.thread-link') }).first();
    await root.focus();
    await page.keyboard.press('r');
    await expect(page.locator('#thread-composer')).toBeFocused();
    await page.keyboard.type('Taking the 4-byte case.');
    await page.keyboard.press('Enter');
    await expect(page.locator('#thread .msgs li.msg').last()).toContainText('Taking the 4-byte case.');
    await expect(root.locator('.thread-link')).toContainText('4 replies');
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#thread')).toHaveCount(0);
    // E on a message: the picker; arrows and Enter react; the chip is a toggle.
    await root.focus();
    await page.keyboard.press('e');
    await expect(page.locator('.emoji-menu')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page.locator('.emoji-menu')).toHaveCount(0);
    await expect(root.locator('.react[aria-pressed="true"]', { hasText: '✅' })).toBeVisible();
    await expect.poll(async () => (await writes()).filter((write) => write.kind === 'reaction').length).toBe(1);
    // The hover toolbar on a message.
    await root.hover();
    await expect(root.locator('.m-actions')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    // The first visible row under the header: its toolbar moves inside the row instead of being cut off.
    const scroller = page.locator('#msg-scroll');
    await root.evaluate((el) => {
      const box = el.closest('.msgs') as HTMLElement;
      box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    });
    await page.mouse.move(0, 0);
    await root.hover();
    const bar = await root.locator('.m-actions').boundingBox();
    const top = await scroller.boundingBox();
    expect(bar !== null && top !== null && bar.y >= top.y).toBe(true);
  });
}

test('a read-only conversation says why there is no message box', async ({ page }) => {
  await openEnvelope(page);
  await page.locator('.side .conv', { hasText: 'incidents' }).click();
  await expect(page.locator('#chat-foot')).toHaveText('You cannot post in this conversation.');
  await expect(page.locator('#composer')).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
});

test('offline: messages wait, keep their order, survive a module switch and go out once when the connection is back', async ({ page, context }) => {
  await openEnvelope(page);
  await context.setOffline(true);
  await page.locator('#composer').focus();
  await page.keyboard.type('Written on the train');
  await page.keyboard.press('Enter');
  await page.keyboard.type('And a second thought');
  await page.keyboard.press('Enter');
  const queued = page.locator('#msg-list li.msg.pending.queued');
  await expect(queued).toHaveCount(2);
  await expect(queued.first()).toContainText('Waiting for connection. It sends when you are back online.');
  await expect(page.locator('#chat-banner')).toContainText('messages will send when the connection is back');
  expect(await axe(page)).toEqual([]);
  // Time and back: the queue lives in the chat module.
  await page.keyboard.press('Control+2');
  await page.keyboard.press('Control+1');
  await expect(queued).toHaveCount(2);
  await context.setOffline(false);
  await expect(page.locator('#msg-list li.msg.pending')).toHaveCount(0, { timeout: 20_000 });
  const bodies = await page.locator('#msg-list li.msg .m-body').allTextContents();
  expect(bodies.slice(-2)).toEqual(['Written on the train', 'And a second thought']);
  const sends = (await writes()).filter((write) => write.kind === 'send');
  expect(sends).toHaveLength(2);
  expect(new Set(sends.map((write) => write.key)).size).toBe(2);
});

test('the reaction picker takes the toolbar\'s place in the top layer; the home view is keyboard reachable', async ({ page }) => {
  await openEnvelope(page);
  const root = page.locator('#msg-list li.msg', { has: page.locator('.thread-link') }).first();
  await root.hover();
  await root.locator('.m-actions [aria-haspopup="menu"]').first().click();
  const menu = page.locator('.emoji-menu');
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => el.matches(':popover-open'))).toBe(true);
  // One floating bar: the toolbar is hidden while the picker sits where it is laid out (same top, right edges aligned).
  await expect(root.locator('.m-actions')).toHaveCSS('opacity', '0');
  const offset = async () => {
    const [bar, picker] = [await root.locator('.m-actions').boundingBox(), await menu.boundingBox()];
    if (bar === null || picker === null) return Infinity;
    return Math.max(Math.abs(picker.y - bar.y), Math.abs(picker.x + picker.width - (bar.x + bar.width)));
  };
  await expect.poll(offset).toBeLessThanOrEqual(2);
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // Esc leaves the conversation; Tab reaches the home view's rows, ↓ moves between them, Enter opens.
  await page.locator('#msg-scroll').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#chat-home')).toBeVisible();
  await page.locator('#chat-home-link').focus();
  await expect(page.locator('#chat-home-link')).toHaveAttribute('aria-current', 'page');
  const rows = page.locator('#chat-home .hm-row');
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  const name = (await rows.nth(1).locator('.hm-name').textContent()) ?? '';
  await page.keyboard.press('Enter');
  await expect(page.locator('#chat-title')).toContainText(name.split(' in ').at(-1) ?? name);
});
