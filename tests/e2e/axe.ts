import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * Waits until no finite CSS animation or transition is running. Toasts fade in (`toast-in`: 0.3 s from opacity 0,
 * styles.css), and axe's colour-contrast rule blends a text with what is behind it through the element's opacity: a
 * scan during the fade reported `color-contrast` on the toast text, which the settled toast passes (the flaky
 * "Working without a timer?" test). Infinite animations (the device-code arcs) never finish and are ignored. Loops in
 * case a re-render starts a new animation while waiting. Scroll-driven animations (the faded edges of the Settings
 * tablist) follow a scroll position, not time, and never finish: ignored too.
 */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let round = 0; round < 10; round++) {
      const running = document
        .getAnimations()
        .filter((animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity && animation.timeline instanceof DocumentTimeline);
      if (running.length === 0) return;
      await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
    }
  });
}

/** WCAG 2.1 A / AA violations of the settled page, as `rule target, target` lines (empty when it passes). */
export async function axe(page: Page): Promise<string[]> {
  await settled(page);
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
