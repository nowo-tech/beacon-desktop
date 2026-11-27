import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * UX batches 2 + 3 for the owner's review (`UXB3_SHOTS` = output folder): copy and i18n (UXA-14, 19, 20, 21, 32, 43)
 * and the shell's keyboard and accessibility (UXA-3, 9, 10, 27, 28, 29; owner item "global shortcuts in every module"):
 * the global Ctrl/⌘+K switcher in Chat, Tasks and Time, the per-module shortcut sheet, F6 areas, roving rows, the 400 px
 * Time list. Light and dark at 1280×800, narrow 900×600 and 400×640 where the layout changes, Spanish for the copy.
 * axe (WCAG 2.2 AA) on every view, plus the Tab sequence of each module in `report-<scheme>.json`.
 *
 * `UXB3_PHASE=before` takes the same pictures of the base branch (no assertions on the new behaviour).
 */
const MOCK = process.env.UXB3_MOCK ?? 'http://127.0.0.1:8803';
const OUT = process.env.UXB3_SHOTS ?? 'out/uxb3-screens';
const AFTER = (process.env.UXB3_PHASE ?? 'after') === 'after';
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 900, height: 600 };

async function control(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? null : res.json();
}

async function shot(page: Page, name: string, scheme: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
}

async function axe(page: Page) {
  if (!AFTER) return;
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/** The first `count` Tab stops from the top of the page: which area and which control. */
async function tabOrder(page: Page, count: number): Promise<string[]> {
  // From the top of the page: a focused element removed at the start of <body> moves the focus starting point there.
  await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.tabIndex = -1;
    document.body.prepend(probe);
    probe.focus();
    probe.remove();
  });
  const stops: string[] = [];
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el === null || el === document.body) return 'body';
        const area = el.closest('#titlebar') ? 'titlebar' : el.closest('#rail') ? 'rail' : el.closest('#chat-side, #sidebar') ? 'sidebar' : el.closest('#task-detail, #thread, #detail') ? 'detail' : 'content';
        const name = el.id !== '' ? `#${el.id}` : `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
        return `${area} ${name} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}`;
      }),
    );
  }
  return stops;
}

const focusedArea = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el === null ? 'none' : el.closest('#titlebar') ? 'titlebar' : el.closest('#rail') ? 'rail' : el.closest('#chat-side, #sidebar') ? 'sidebar' : el.closest('#task-detail, #tasks-drawer, #thread-slot, #detail') ? 'detail' : el.closest('main') ? 'main' : 'other';
  });

async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
}

async function connectChat(page: Page) {
  await page.locator('#tab-chat').click();
  await page.locator('#chat-connect').click();
  await control('device/approve', { userCode: await page.locator('#chat-user-code').textContent() });
  await expect(page.locator('.side .conv').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('#notify-later').click();
  await page.locator(`.ctx-tile[data-context="${ORG}"]`).click();
  await expect(page.locator('.side .conv', { hasText: 'envelope-v2' })).toBeVisible();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`keyboard and copy screens (${scheme})`, async ({ page, context }) => {
    const report: Record<string, unknown> = {};
    await control('reset', {});
    await control('config', { deviceInterval: 1, allocation: { requireActivityType: true }, contextPolicy: { required: false, refuse: [] } });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize(DESKTOP);
    await signIn(page);

    // 09 The 400 px Time view, the list scrolled: no row under the search field.
    await page.setViewportSize({ width: 400, height: 640 });
    await page.locator('#task-scroll').evaluate((node) => node.scrollBy(0, 70));
    await page.waitForTimeout(200);
    const overlap = await page.evaluate(() => {
      const search = document.querySelector('#main .search')?.getBoundingClientRect();
      const scroller = document.querySelector('#task-scroll')?.getBoundingClientRect();
      return search !== undefined && scroller !== undefined ? Math.round(search.bottom - scroller.top) : null;
    });
    report.timeCompactOverlap = overlap;
    report.searchEdge = await page.evaluate(() => {
      const node = document.querySelector('#main .search');
      return node === null ? null : { shadow: getComputedStyle(node).boxShadow, z: getComputedStyle(node).zIndex, main: document.querySelector('#main')?.className };
    });
    // The list starts at the search field's lower edge (never under it); scrolled, that edge gets a soft shadow.
    expect(overlap ?? 0, 'the list starts below the search field').toBeLessThanOrEqual(0);
    if (AFTER) await expect(page.locator('#main')).toHaveClass(/list-scrolled/);
    await shot(page, '09-time-compact-400', scheme);
    await page.setViewportSize(DESKTOP);

    // 05 Ctrl+K in Time: the global switcher, Time's timer actions first.
    await page.locator('#nav-tasks').focus();
    await page.keyboard.press('Control+K');
    if (AFTER) {
      await expect(page.locator('#switcher')).toBeVisible();
      await expect(page.locator('#sw-list .opt').first()).toHaveAttribute('data-module', 'time');
      await page.locator('#sw-input').fill('fix');
      await expect(page.locator('#sw-list .opt[data-module="time"]').first()).toContainText('Fix invoice rounding bug');
      await axe(page);
    }
    await shot(page, '05-switcher-time', scheme);
    await page.keyboard.press('Escape');
    if (!AFTER) await page.keyboard.press('Escape');

    // 06 `?` in Time: the sheet lists Anywhere and Time's own keys.
    await page.locator('#nav-tasks').focus();
    await page.keyboard.press('?');
    if (AFTER) {
      await expect(page.locator('#shell-keys')).toBeVisible();
      await expect(page.locator('#shell-keys h2')).toHaveText(['Anywhere', 'Time']);
      await axe(page);
    }
    await shot(page, '06-keys-time', scheme);
    await page.keyboard.press('Escape');

    // Tab order and F6 in Time.
    report.tabTime = await tabOrder(page, 14);
    if (AFTER) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const areas: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        await page.keyboard.press('F6');
        areas.push(await focusedArea(page));
      }
      expect(areas).toEqual(['sidebar', 'main', 'detail', 'titlebar', 'rail']);
    }

    // 10 Stop with a required activity type: no empty gap under the select (UXA-43), plain hint.
    await page.locator('#tasks li').first().hover();
    await page.locator('#tasks li').first().locator('.row-action').click();
    await expect(page.locator('#timer.running')).toBeVisible();
    await page.locator('#stop').click();
    await expect(page.locator('#alloc-activity')).toBeVisible();
    await expect(page.locator('#alloc-activity')).toBeEnabled();
    if (AFTER) {
      await expect(page.locator('#alloc-activity-row .row-msg')).toBeHidden();
      await expect(page.locator('#alloc-subject-help')).toHaveText('Type to search. Beacon confirms the client when you save.');
      await axe(page);
    }
    await shot(page, '10-stop-dialog', scheme);
    // Submitting without a choice: the error takes the line, nothing else moves.
    await page.locator('#alloc-submit').click();
    await expect(page.locator('#alloc-activity-err')).toBeVisible();
    await shot(page, '10-stop-dialog-error', scheme);
    await page.locator('#alloc-activity').selectOption({ index: 1 });
    await page.locator('#alloc-submit').click();

    // 07 A stop under a minute: plain words, no praise (UXA-20).
    await expect(page.locator('#notice')).toBeVisible();
    if (AFTER) await expect(page.locator('#notice')).toContainText('Saved a short entry (0:00) on');
    await shot(page, '07-time-saved-short', scheme);

    // 08 Offline with one action waiting: a real plural (UXA-21).
    await context.setOffline(true);
    await page.locator('#tasks li').nth(1).hover();
    await page.locator('#tasks li').nth(1).locator('.row-action').click();
    await expect(page.locator('#offline')).toBeVisible();
    if (AFTER) await expect(page.locator('#offline')).toContainText('Offline: 1 action will be sent when the connection returns.');
    await shot(page, '08-time-offline', scheme);
    await context.setOffline(false);
    await page.evaluate(() => (window as unknown as { __timeTrack: { app: { refresh(): Promise<void> } } }).__timeTrack.app.refresh());
    await expect(page.locator('#offline')).toBeHidden();
    await page.locator('#stop').click();
    if (await page.locator('#alloc-activity').isVisible()) {
      await page.locator('#alloc-activity').selectOption({ index: 1 });
      await page.locator('#alloc-submit').click();
    }

    // Chat.
    await connectChat(page);
    await page.locator('.side .conv', { hasText: 'envelope-v2' }).click();
    await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
    // 01 A healthy connection says nothing in the sidebar (UXA-14).
    if (AFTER) {
      await expect(page.locator('#chat-side-foot')).toBeHidden();
      await axe(page);
    }
    await shot(page, '01-chat-sidebar', scheme);
    report.tabChat = await tabOrder(page, 16);
    if (AFTER) {
      // One Tab stop for the whole conversation list (roving), in visual order: title bar, rail, sidebar, content.
      const stops = report.tabChat as string[];
      expect(stops.filter((stop) => stop.includes('button.conv')).length).toBe(1);
      const order = stops.map((stop) => stop.split(' ')[0]).filter((area, index, all) => area !== all[index - 1]);
      expect(order.slice(0, 4)).toEqual(['titlebar', 'rail', 'sidebar', 'content']);
    }
    // F6: sidebar → conversation → title bar → rail → sidebar.
    if (AFTER) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('F6');
      await expect(page.locator('.side .conv[aria-current="true"]')).toBeFocused();
      await shot(page, '11-f6-chat-sidebar', scheme);
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.side .conv[aria-current="true"]')).not.toBeFocused();
      await page.keyboard.press('F6');
      expect(await focusedArea(page)).toBe('main');
      await page.keyboard.press('F6');
      expect(await focusedArea(page)).toBe('titlebar');
      await page.keyboard.press('F6');
      expect(await focusedArea(page)).toBe('rail');
      await page.keyboard.press('Shift+F6');
      expect(await focusedArea(page)).toBe('titlebar');
    }
    // 02 A direct message's first line (UXA-32).
    await page.locator('.side .conv', { hasText: 'Maya Okafor' }).click();
    await expect(page.locator('#msg-list li.msg').first()).toBeVisible();
    await page.locator('#msg-scroll').evaluate((node) => (node.scrollTop = 0));
    if (AFTER) await expect(page.locator('.conv-start')).toContainText('This is the start of your conversation with Maya Okafor.');
    await shot(page, '02-chat-dm-start', scheme);
    // 06 the sheet in Chat.
    await page.locator('.side .conv', { hasText: 'Maya Okafor' }).focus();
    await page.keyboard.press('?');
    if (AFTER) await expect(page.locator('#shell-keys h2')).toHaveText(['Anywhere', 'Chat']);
    await shot(page, '06-keys-chat', scheme);
    await page.keyboard.press('Escape');
    // 03 Settings → Chat: the connection line lives here now.
    await page.keyboard.press('Control+,');
    await page.locator('#settings-tab-chat').click();
    if (AFTER) {
      await expect(page.locator('#settings-chat-status')).toContainText('Checking for new messages every 30 s');
      await axe(page);
    }
    await shot(page, '03-settings-chat', scheme);
    await page.keyboard.press('Escape');

    // Tasks: 13 the connect card, its security detail behind "How this works" (UXA-21).
    await page.locator('#tab-tasks').click();
    await expect(page.locator('#tasks-connect')).toBeVisible();
    if (AFTER) {
      await page.locator('#tasks-connect-how summary').click();
      await expect(page.locator('#tasks-connect-how p')).toBeVisible();
      await axe(page);
    }
    await shot(page, '13-tasks-connect', scheme);
    await page.locator('#tasks-connect').click();
    await control('device/approve', { userCode: await page.locator('#tasks-user-code').textContent() });
    await expect(page.locator('#tasks-mine .row').first()).toBeVisible({ timeout: 15_000 });
    // 04 Ctrl+K in Tasks: tasks and boards, plus matches from the other modules.
    await page.locator('#tasks-mine .r-title').first().focus();
    await page.keyboard.press('Control+K');
    if (AFTER) {
      await expect(page.locator('#switcher')).toBeVisible();
      await expect(page.locator('#sw-list .opt').first()).toHaveAttribute('data-module', 'tasks');
      await axe(page);
    }
    await shot(page, '04-switcher-tasks', scheme);
    if (AFTER) {
      await page.locator('#sw-input').fill('env');
      await expect(page.locator('#sw-list .opt[data-module="chat"]')).toContainText(['envelope-v2']);
      await shot(page, '04-switcher-tasks-query', scheme);
      // A board from the switcher: the board view opens on it.
      await page.locator('#sw-input').fill('');
      await page.locator('#sw-list .opt[data-switch^="b-"]').first().click();
      await expect(page.locator('.col .card').first()).toBeVisible();
      await page.locator('[data-view="mine"]').click();
      await expect(page.locator('#tasks-mine .row').first()).toBeVisible();
    } else {
      await page.keyboard.press('Escape');
    }
    // 06 the sheet in Tasks.
    await page.locator('#tasks-mine .r-title').first().focus();
    await page.keyboard.press('?');
    if (AFTER) await expect(page.locator('#shell-keys h2')).toHaveText(['Anywhere', 'Tasks']);
    await shot(page, '06-keys-tasks', scheme);
    await page.keyboard.press('Escape');
    // 12 My tasks rows: one Tab stop; ↓ to the next row, → to its play button.
    report.tabTasks = await tabOrder(page, 16);
    if (AFTER) {
      const stops = report.tabTasks as string[];
      expect(stops.filter((stop) => stop.includes('r-title')).length).toBe(1);
      expect(stops.filter((stop) => stop.includes('button.chk')).length).toBe(0);
      await page.locator('#tasks-mine .r-title').first().focus();
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('#tasks-mine .r-title').nth(1)).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#tasks-mine .row').nth(1).locator('.k-play')).toBeFocused();
      await axe(page);
    }
    await shot(page, '12-tasks-rows-focus', scheme);

    // 14 The 900 px title bar (UXA-9, UXA-28): names before the search, 24 px targets.
    await page.locator('#tab-chat').click();
    // A running timer (Ctrl/⌘+Shift+S from Chat resumes the last task): its Stop is a title-bar target too.
    await page.locator('#tab-chat').focus();
    await page.keyboard.press('Control+Shift+S');
    if (AFTER) await expect(page.locator('#timer-pill .tp-act')).toBeVisible();
    await page.setViewportSize(NARROW);
    await expect(page.locator('#titlebar')).toBeVisible();
    if (AFTER) {
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('#titlebar button, #titlebar [role="button"]')]
          .filter((node) => node.offsetParent !== null)
          .map((node) => ({ id: node.id || node.className, rect: node.getBoundingClientRect() }))
          .filter((item) => item.rect.width < 24 || item.rect.height < 24)
          .map((item) => `${item.id} ${Math.round(item.rect.width)}×${Math.round(item.rect.height)}`),
      );
      expect(small).toEqual([]);
      await axe(page);
    }
    await shot(page, '14-titlebar-narrow', scheme);
    writeFileSync(`${OUT}/report-${scheme}.json`, JSON.stringify(report, null, 2));
  });
}

test('Spanish copy: one word for the timer, plural rules (light)', async ({ browser }) => {
  const context = await browser.newContext({
    locale: 'es-ES',
    viewport: DESKTOP,
    storageState: { cookies: [], origins: [{ origin: new URL(test.info().project.use.baseURL ?? '').origin, localStorage: [{ name: 'beacon-desktop-shell', value: '{"setup":"done","module":"time"}' }] }] },
  });
  const page = await context.newPage();
  await control('reset', {});
  await control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('#server').fill(MOCK);
  await page.locator('#connect').click();
  await control('device/approve', { userCode: await page.locator('#user-code').textContent() });
  await expect(page.locator('#tasks li').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('#tab-chat').click();
  // 15 the title bar's timer and the chat: "temporizador" (UXA-19).
  if (AFTER) await expect(page.locator('#timer-pill')).toContainText('Sin temporizador');
  await shot(page, '15-chat-es', 'light');
  await page.locator('#tab-chat').focus();
  await page.keyboard.press('?');
  await shot(page, '16-keys-chat-es', 'light');
  await context.close();
});
