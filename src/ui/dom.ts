export type Child = Node | string | null | undefined | false;

/** Focus is restored across re-renders by this attribute (see `patch`). */
export const KEY_ATTR = 'data-key';

export interface Props {
  class?: string;
  id?: string;
  /** Stable focus key (`data-key`): after a region is re-rendered, the element with the same key gets focus back. */
  key?: string;
  attrs?: Record<string, string | boolean | undefined>;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

/** Minimal element factory. Text is always set as text nodes (no innerHTML anywhere). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class !== undefined) {
    element.className = props.class;
  }
  if (props.id !== undefined) {
    element.id = props.id;
  }
  if (props.key !== undefined) {
    element.setAttribute(KEY_ATTR, props.key);
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === true) {
      element.setAttribute(name, '');
    } else if (typeof value === 'string') {
      element.setAttribute(name, value);
    }
  }
  for (const [name, handler] of Object.entries(props.on ?? {})) {
    element.addEventListener(name, handler as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

function focusKey(element: Element): string | null {
  return element.getAttribute(KEY_ATTR) ?? (element.id !== '' ? `#${element.id}` : null);
}

function findByKey(container: ParentNode, key: string): HTMLElement | null {
  if (key.startsWith('#')) return container.querySelector<HTMLElement>(`[id="${CSS.escape(key.slice(1))}"]`);
  return container.querySelector<HTMLElement>(`[${KEY_ATTR}="${CSS.escape(key)}"]`);
}

/**
 * Replaces the children of one region and keeps keyboard focus: if focus was inside the region, the new element with
 * the same `data-key` (or id) is focused again (text selection restored for inputs); when it no longer exists,
 * `fallback` (a key or `#id`, searched in the document) gets it. Other regions and their focus are untouched.
 */
export function patch(region: HTMLElement, children: Child[], fallback?: string): void {
  const active = document.activeElement;
  const inside = active !== null && active !== region && region.contains(active);
  const key = inside ? focusKey(active) : null;
  const selection =
    inside && active instanceof HTMLInputElement && active.type !== 'checkbox' ? [active.selectionStart, active.selectionEnd] : null;
  region.replaceChildren(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
  if (!inside) return;
  const target = (key !== null ? findByKey(region, key) : null) ?? (fallback !== undefined ? findByKey(document, fallback) : null);
  if (target === null) return;
  target.focus();
  if (selection !== null && target instanceof HTMLInputElement) {
    try {
      target.setSelectionRange(selection[0], selection[1]);
    } catch {
      // Inputs without selection support.
    }
  }
}
