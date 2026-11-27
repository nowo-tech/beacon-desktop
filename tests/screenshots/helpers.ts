import { expect, type Page } from '@playwright/test';

/**
 * Shared by the documentation screenshots. The app talks to a placeholder Beacon (https://beacon.example.test); every
 * request to it is answered by the mock server (mock-server/server.mjs) through a Playwright route, and the demo
 * account / data are rewritten to neutral placeholders, so no screenshot shows a local address or a person's name.
 */
export const BEACON = 'https://beacon.example.test';
export const MOCK = 'http://127.0.0.1:8787';
export const OUT = 'docs/images';
export const UPDATE = {
  version: '0.5.0',
  notes: 'Added\n- A calmer update card\n- Check for updates in the tray',
  pub_date: '2026-11-04T10:00:00Z',
  url: 'u',
  signature: 's',
};

/** Demo data of the mock → what the screenshots show. */
const REPLACE: [string, string][] = [
  ['Ada Lovelace', 'Sample User'],
  ['ada@example.com', 'user@example.test'],
  ['Customer call: Acme quarterly review', 'Customer call: quarterly review'],
  [MOCK, BEACON],
  ['http://127.0.0.1:8787', BEACON],
];

export async function control(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${MOCK}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? null : res.json();
}

export async function reset(): Promise<void> {
  await control('reset', {});
  await control('config', {
    deviceInterval: 1,
    verificationUri: `${BEACON}/device`,
    taskUrls: Object.fromEntries(['T-101', 'T-102', 'T-103', 'T-104', 'T-105', 'T-106', 'T-107', 'T-108'].map((id) => [id, `${BEACON}/dashboard/tasks/${id}`])),
  });
}

/** Routes the placeholder Beacon to the mock and rewrites the demo data. */
export async function useFakeBeacon(page: Page): Promise<void> {
  await page.route(`${BEACON}/**`, async (route) => {
    const request = route.request();
    const response = await route.fetch({ url: request.url().replace(BEACON, MOCK) });
    let body = await response.text();
    for (const [from, to] of REPLACE) body = body.split(from).join(to);
    await route.fulfill({ response, body });
  });
}

export type Hooks = { installed: number; installStepMs: number; installSteps: unknown[] };
type Tt = { __timeTrack: { app: { refresh(): Promise<void>; checkUpdates(manual?: boolean): Promise<void> }; hooks: Hooks } };
export const app = (page: Page) => ({
  check: () => page.evaluate(() => (window as unknown as Tt).__timeTrack.app.checkUpdates()),
  refresh: () => page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh()),
  /** Keeps the fake download at 50 % long enough for the progress screenshot. */
  holdProgress: () => page.evaluate(() => void ((window as unknown as Tt).__timeTrack.hooks.installStepMs = 5_000)),
});

/** Connects to the placeholder Beacon; returns once the code is shown (approve with `approve`). */
export async function connect(page: Page): Promise<string> {
  await useFakeBeacon(page);
  await page.goto('/');
  await page.locator('#server').fill(BEACON);
  await page.locator('#connect').click();
  const code = (await page.locator('#user-code').textContent()) ?? '';
  expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  return code;
}

/** Signs in; "You're in" (a line in the status strip since UX batch 4) is dismissed unless `keepWelcome`. */
export async function signIn(page: Page, keepWelcome = false): Promise<void> {
  const code = await connect(page);
  await control('device/approve', { userCode: code });
  await expect(page.locator('#tasks li')).toHaveCount(8, { timeout: 15_000 });
  if (!keepWelcome) await dismissWelcome(page);
}

/** Closes "You're in" in the status strip (UXA-23), when it shows. */
export async function dismissWelcome(page: Page): Promise<void> {
  const dismiss = page.locator('#time-strip-dismiss');
  if (await dismiss.isVisible()) await dismiss.click();
}

/** Viewport screenshot after checking that no local address or demo identity is visible. */
export async function shot(page: Page, name: string): Promise<void> {
  const text = (await page.locator('body').innerText()) + (await page.locator('body').evaluate((el) => el.outerHTML));
  for (const leak of ['127.0.0.1', 'localhost', 'Ada', 'ada@', 'Acme']) expect(text, `${name} shows "${leak}"`).not.toContain(leak);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled', caret: 'hide' });
}
