import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { control, reset, signIn } from './helpers';

/**
 * Friendly messages for review (`pnpm screenshots:friendly`, `FRIENDLY_SCREENS=<dir>`): every situation in the real UI,
 * in Spanish, light and dark, plus one overview sheet per theme. Skipped by `pnpm screenshots` (not documentation).
 */
const DIR = process.env.FRIENDLY_SCREENS ?? '';
test.skip(DIR === '', 'set FRIENDLY_SCREENS=<dir> to write the review screenshots');
test.use({ locale: 'es-ES', timezoneId: 'Europe/Madrid' });
test.beforeEach(reset);

type App = {
  state: Record<string, unknown> & { activeTimer: { taskId: string; startedAt: string } | null; messages: Record<string, unknown> };
  render(): void;
  saved(timer: unknown, queued: boolean): void;
};
type Tt = { __timeTrack: { app: App & { refresh(): Promise<void> } } };

/** Card situations: pool, line index, minutes on the clock. */
const CARDS: [string, string, number, number][] = [
  ['cheer-2h', 'milestone', 5, 125],
  ['achievement-4h', 'milestone', 0, 245],
  ['overtime', 'overtime', 0, 390],
  ['early-bird', 'earlyBird', 1, 20],
  ['coffee', 'coffee', 0, 70],
  ['lunch', 'lunch', 0, 70],
  ['late-work', 'lateWork', 1, 70],
  ['friday', 'friday', 3, 70],
  ['holiday', 'friday', 1, 70],
  ['weekend-start', 'weekend', 0, 10],
  ['weekend-rest', 'weekendRest', 0, 100],
  ['water', 'cheer', 12, 125],
  ['stretch', 'cheer', 11, 125],
  ['eyes', 'cheer', 13, 125],
  ['mindfulness', 'cheer', 15, 125],
  ['after-meeting', 'meetingAfter', 0, 20],
  ['day-finished', 'lateWork', 3, 70],
];

const NAMES = ['idle', 'idle-countdown', 'idle-paused', 'meeting-idle', ...CARDS.map(([name]) => name), 'daily-done'];

async function running(page: Page, task: string, minutes: number): Promise<void> {
  await signIn(page);
  await page.locator(`[data-task="${task}"] .row-action`).click();
  await expect(page.locator('#timer .elapsed')).toBeVisible();
  await control('timer/backdate', { seconds: minutes * 60 });
  await page.evaluate(() => (window as unknown as Tt).__timeTrack.app.refresh());
}

async function save(page: Page, scheme: string, name: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  const path = `${DIR}/${name}-${scheme}.png`;
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
}

const idle = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate((extra) => {
    const app = (window as unknown as Tt).__timeTrack.app;
    const timer = app.state.activeTimer as { taskId: string; startedAt: string; taskTitle?: string };
    const now = Date.now();
    app.state = {
      ...app.state,
      messages: { ...app.state.messages, idleLine: 0 },
      idleCheck: { phase: 'asking', taskId: timer.taskId, taskTitle: (timer as { taskTitle: string }).taskTitle, from: new Date(now - 11 * 60_000).toISOString(), askedAt: new Date(now).toISOString(), returnedAt: null, timerStartedAt: timer.startedAt, ...extra },
    };
    app.render();
  }, patch);

for (const scheme of ['light', 'dark'] as const) {
  test.describe.serial(scheme, () => {
    test.beforeEach(({ page }) => page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' }));

    for (const [name, kind, line, minutes] of CARDS) {
      test(`${name}-${scheme}`, async ({ page }) => {
        await running(page, 'T-101', minutes);
        await page.evaluate(
          ([cardKind, index]) => {
            const app = (window as unknown as Tt).__timeTrack.app;
            const timer = app.state.activeTimer as { taskId: string; startedAt: string };
            app.state = { ...app.state, messages: { ...app.state.messages, card: { kind: cardKind, line: index, locale: 'es', entry: `${timer.taskId}@${timer.startedAt}`, shownAt: new Date().toISOString(), dismissed: false } } };
            app.render();
          },
          [kind, line] as const,
        );
        await expect(page.locator('#cheer')).toBeVisible();
        await save(page, scheme, name);
      });
    }

    test(`idle-${scheme}`, async ({ page }) => {
      await running(page, 'T-101', 60);
      await idle(page, {});
      await expect(page.locator('#idle-quip')).toBeVisible();
      await save(page, scheme, 'idle');
    });

    test(`idle-countdown-${scheme}`, async ({ page }) => {
      await running(page, 'T-101', 60);
      await idle(page, { askedAt: new Date(Date.now() - 75_000).toISOString() });
      await expect(page.locator('#idle-countdown-text')).toContainText('0:4');
      await save(page, scheme, 'idle-countdown');
    });

    test(`idle-paused-${scheme}`, async ({ page }) => {
      await running(page, 'T-101', 60);
      await page.locator('#stop').click();
      await expect(page.locator('#stop')).toHaveCount(0);
      await page.evaluate(() => {
        const app = (window as unknown as Tt).__timeTrack.app;
        app.state = { ...app.state, idleCheck: { phase: 'away', taskId: 'T-101', taskTitle: 'Write onboarding guide', from: new Date(Date.now() - 13 * 60_000).toISOString() } };
        app.render();
      });
      await expect(page.locator('#idle-resume-now')).toBeVisible();
      await save(page, scheme, 'idle-paused');
    });

    test(`meeting-idle-${scheme}`, async ({ page }) => {
      await running(page, 'T-103', 40);
      await idle(page, {});
      await expect(page.locator('#idle-title')).toHaveText('¿Sigues en la reunión?');
      await save(page, scheme, 'meeting-idle');
    });

    test(`daily-done-${scheme}`, async ({ page }) => {
      await running(page, 'T-101', 15);
      await page.evaluate(() => {
        const app = (window as unknown as Tt).__timeTrack.app;
        app.saved({ id: 'E-9', taskId: 'T-9', taskTitle: 'Daily del equipo', startedAt: new Date(Date.now() - 15 * 60_000).toISOString() }, false);
      });
      await expect(page.locator('#daily-toast')).toBeVisible();
      await save(page, scheme, 'daily-done');
    });

    test(`overview-${scheme}`, async ({ page }) => {
      const tiles = NAMES
        .map((name) => `<figure><img src="data:image/png;base64,${readFileSync(`${DIR}/${name}-${scheme}.png`).toString('base64')}"><figcaption>${name}</figcaption></figure>`)
        .join('');
      const paper = scheme === 'dark' ? '#0c1210' : '#f3f6f4';
      const ink = scheme === 'dark' ? '#e6eee9' : '#0f1c18';
      await page.setViewportSize({ width: 1700, height: 900 });
      await page.setContent(
        `<style>body{margin:16px;background:${paper};color:${ink};font:14px system-ui}main{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}figure{margin:0}img{width:100%;border:1px solid #7d8f87;border-radius:6px}figcaption{text-align:center;margin-top:4px}</style><h1>TimeTrack: mensajes amistosos (${scheme})</h1><main>${tiles}</main>`,
      );
      await page.screenshot({ path: `${DIR}/overview-${scheme}.png`, fullPage: true });
    });
  });
}
