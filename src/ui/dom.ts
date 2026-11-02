export type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  id?: string;
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
