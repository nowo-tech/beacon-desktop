import { h, type Child } from './dom';

/**
 * The answers of a toast (working-hours reminder, "Working without a timer?", the meeting question): one markup and
 * one CSS rule (`.toast-actions`, `.toast-action` in styles.css) for all of them.
 */
export function toastActions(id: string | undefined, ...actions: Child[]): HTMLDivElement {
  return h('div', { class: 'toast-actions', id }, ...actions);
}

/** A toast's main answer: a small secondary button in the language of the message (`locale`). */
export function toastAction(
  id: string,
  label: string,
  locale: string,
  onClick: () => void,
  attrs: Record<string, string | undefined> = {},
): HTMLButtonElement {
  return h('button', { class: 'secondary small toast-action', id, key: id, attrs: { type: 'button', lang: locale, ...attrs }, on: { click: onClick } }, label);
}
