import { applyTheme } from '../lib/theme';
import type { PromptClient } from '../platform';
import { PromptMount, type PromptView } from './prompt';

/**
 * Entry of the "Still there?" window (`index.html?window=prompt`): draws the main window's prompt and reports the
 * answers. No session, no network, no timers of its own besides the visible countdown.
 */
export async function startPromptWindow(root: HTMLElement, client: PromptClient): Promise<PromptMount> {
  document.documentElement.classList.add('prompt-window');
  const region = document.createElement('main');
  region.className = 'prompt-region';
  region.id = 'prompt-region';
  root.replaceChildren(region);
  const mount = new PromptMount(region, {
    onAnswer: (answer) => void client.answer(answer),
  });
  const show = (view: PromptView | null) => {
    if (view !== null) {
      applyTheme(view.theme ?? 'system');
      document.documentElement.lang = view.lang;
      document.title = view.windowTitle;
    }
    mount.show(view);
  };
  client.onView(show);
  show(await client.view());
  return mount;
}
