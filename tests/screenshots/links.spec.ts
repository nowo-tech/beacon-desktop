import { expect, test, type Page } from '@playwright/test';
import { reset, signIn } from './helpers';

/**
 * "Open Beacon in", "Copy link" and the empty states of the list, for review (`pnpm screenshots:links`,
 * `LINKS_SCREENS=<dir>`), Spanish, light and dark. Real UI on the fake platform; the browsers are the fake host's list.
 */
const DIR = process.env.LINKS_SCREENS ?? '';
test.skip(DIR === '', 'set LINKS_SCREENS=<dir> to write the review screenshots');
test.use({ locale: 'es-ES', timezoneId: 'Europe/Madrid' });
test.beforeEach(reset);

type App = {
  state: { settings: Record<string, unknown>; pinned: unknown[]; lastTask: unknown };
  tasks: unknown[];
  entries: unknown[] | null;
  render(): void;
  refresh(): Promise<void>;
  show(view: string): void;
  setTheme(theme: string): Promise<void>;
  persist(patch: unknown): void;
  start(task: { id: string; title: string }): Promise<void>;
  browsers: unknown;
  loadBrowserChoice(): Promise<void>;
};
type Choice = { kind: 'detected'; id: string; name: string };
type Tt = { __timeTrack: { app: App; hooks: { browsers: { id: string; name: string }[]; browserChoice: Choice } } };
/** Runs `fn` in the page with the app and the fake platform hooks (and `arg`). */
const run = <A, T>(page: Page, fn: (tt: Tt['__timeTrack'], arg: A) => T | Promise<T>, arg: A) =>
  page.evaluate(([source, value]) => new Function('tt', 'arg', `return (${source})(tt, arg);`)((window as unknown as Tt).__timeTrack, value), [fn.toString(), arg] as const) as Promise<T>;

const BROWSERS = [
  { id: 'win:brave', name: 'Brave' },
  { id: 'win:firefox.exe', name: 'Mozilla Firefox' },
  { id: 'win:google chrome', name: 'Google Chrome' },
  { id: 'win:microsoft edge', name: 'Microsoft Edge' },
  { id: 'win:vivaldi', name: 'Vivaldi' },
];

for (const scheme of ['light', 'dark'] as const) {
  test(`links and empty states (${scheme})`, async ({ page }) => {
    await signIn(page);
    await run(page, (tt, theme) => tt.app.setTheme(theme), scheme);
    const save = (name: string) => page.screenshot({ path: `${DIR}/${name}-${scheme}.png`, animations: 'disabled', caret: 'hide' });

    // Empty states: (a) nothing pinned, tracked before; (b) never tracked; (c) no task at all.
    const empty = async (state: 'pinned' | 'recent' | 'tasks') => {
      await run(
        page,
        (tt, kind) => {
          const app = tt.app;
          app.entries = [];
          app.state.pinned = [];
          app.state.lastTask = kind === 'pinned' ? { id: 'T-101', title: 'Old task' } : null;
          if (kind === 'tasks') app.tasks = [];
          app.render();
        },
        state,
      );
      const slot = page.locator(state === 'tasks' ? '#tasks-empty' : '#quick-empty');
      await expect(slot).toHaveAttribute('data-empty', state);
      for (const img of await slot.locator('img').all()) await expect(img).toHaveJSProperty('complete', true);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      await save(`empty-${state}`);
    };
    await empty('pinned');
    await empty('recent');
    await empty('tasks');

    // Settings → Abrir Beacon en, with Brave chosen among the detected browsers.
    await run(page, (tt) => tt.app.refresh(), null);
    await expect(page.locator('#tasks li').first()).toBeVisible();
    await run(
      page,
      async (tt, browsers) => {
        tt.hooks.browsers = browsers;
        // The choice is kept by the host since 0.5.0 (browser.rs; here the fake platform's hook), not in settings.
        tt.hooks.browserChoice = { kind: 'detected', id: 'win:brave', name: 'Brave' };
        await tt.app.loadBrowserChoice();
        tt.app.show('settings');
      },
      BROWSERS,
    );
    await expect(page.locator('#browser option')).toHaveCount(7);
    await expect(page.locator('#browser')).toHaveValue('detected:win:brave');
    await page.evaluate(() => (document.querySelector('#theme') as HTMLElement | null)?.scrollIntoView({ block: 'start' }));
    await save('browser-setting');
    // The chosen browser was uninstalled: the small notice.
    await run(
      page,
      (tt) => {
        tt.hooks.browsers = tt.hooks.browsers.filter((b) => b.id !== 'win:brave');
        tt.app.browsers = null;
        tt.app.show('main');
        tt.app.show('settings');
      },
      null,
    );
    await expect(page.locator('#browser-missing')).toBeVisible();
    await page.evaluate(() => (document.querySelector('#theme') as HTMLElement | null)?.scrollIntoView({ block: 'start' }));
    await save('browser-missing');

    // Copy link: next to the running task's link and My time, the link menu, and the confirmation.
    await run(
      page,
      (tt) => {
        tt.app.show('main');
        return tt.app.start({ id: 'T-102', title: 'Write release notes' });
      },
      null,
    );
    await expect(page.locator('#timer-copy-link')).toBeVisible();
    await expect(page.locator('#copy-my-time')).toBeVisible();
    const link = page.locator('#timer-open-in-beacon');
    await link.click({ button: 'right' });
    await expect(page.locator('#link-menu')).toBeVisible();
    await save('copy-link-menu');
    await page.locator('#link-menu-copy').click();
    await expect(page.locator('#notice')).toContainText('Enlace copiado');
    await save('copy-link-done');
  });
}
