// @vitest-environment happy-dom
// The Tasks menu button (picker.ts) where the webview has the Popover API (happy-dom has none: stubbed here), and the
// board's edge-fade fallback for webviews without scroll-driven animations.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { edgeHints } from '../../src/tasks/module';
import { closeMenus, menuButton } from '../../src/tasks/picker';
import { h } from '../../src/ui/dom';

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;

afterEach(() => {
  delete proto.showPopover;
  delete proto.hidePopover;
  vi.unstubAllGlobals();
  closeMenus();
  document.body.replaceChildren();
});

function withPopover() {
  const open = new Set<HTMLElement>();
  proto.showPopover = function (this: HTMLElement) {
    open.add(this);
  };
  proto.hidePopover = function (this: HTMLElement) {
    open.delete(this);
    this.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' }));
  };
  return open;
}

describe('menu button', () => {
  it('uses popover="manual" when there is a Popover API; a press outside closes it, a browser-side close syncs aria-expanded, a press on the open button does not reopen it', () => {
    const open = withPopover();
    const picked: string[] = [];
    const wrap = menuButton({ id: 'pk', key: 'pk', className: 'pick', label: 'Status', content: ['To do'], value: 'a', items: [{ kind: 'radio', value: 'a', label: 'Alpha' }, { kind: 'radio', value: 'b', label: 'Beta', hint: 'You' }], onPick: (value) => picked.push(value) });
    document.body.append(wrap);
    const trigger = wrap.querySelector('button') as HTMLButtonElement;
    const menu = document.getElementById('pk-menu') as HTMLElement;
    expect(menu.getAttribute('popover')).toBe('manual');
    expect(menu.hidden).toBe(false);
    expect(menu.nextElementSibling).toBeNull();
    expect(trigger.nextElementSibling).toBe(menu);
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(open.has(menu)).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(open.has(menu)).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(open.has(menu)).toBe(true);
    // The browser hid it (e.g. removed from the top layer): the toggle event syncs the button.
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    menu.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' }));
    open.delete(menu);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(open.has(menu)).toBe(false);
    // Keyboard open: focus on the checked item; picking another value closes and reports it.
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(document.activeElement?.getAttribute('data-value')).toBe('a');
    expect(menu.querySelector('[data-value="b"] .mi-hint')?.textContent).toBe('You');
    (menu.querySelector('[data-value="b"]') as HTMLButtonElement).click();
    expect(open.has(menu)).toBe(false);
    expect(picked).toEqual(['b']);
    expect(document.activeElement).toBe(trigger);
    // A resize closes it.
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    globalThis.dispatchEvent(new Event('resize'));
    expect(open.has(menu)).toBe(false);
  });

  it('check and command items, focus leaving closes it, a disabled button never opens, an end-aligned menu stays on screen', () => {
    const picked: string[] = [];
    const wrap = menuButton({ id: 'more', key: 'more', className: 'more', label: 'More', content: ['…'], bare: true, align: 'end', items: [{ kind: 'check', value: 'mine', label: 'Only mine', checked: true }, { kind: 'command', value: 'open', label: 'Open' }], onPick: (value) => picked.push(value) });
    const after = h('button', { attrs: { type: 'button' } }, 'after');
    document.body.append(wrap, after);
    const trigger = wrap.querySelector('button') as HTMLButtonElement;
    const menu = document.getElementById('more-menu') as HTMLElement;
    expect(trigger.querySelector('.mb-chev')).toBeNull();
    expect(menu.querySelector('[role="menuitemcheckbox"]')?.getAttribute('aria-checked')).toBe('true');
    expect(menu.querySelector('[role="menuitem"] .mi-check')).toBeNull();
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(Number.parseInt(menu.style.left, 10)).toBeGreaterThanOrEqual(8);
    // The checkbox item reports even when "checked" (it toggles).
    (menu.querySelector('[data-value="mine"]') as HTMLButtonElement).click();
    expect(picked).toEqual(['mine']);
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    menu.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(menu.hidden).toBe(false);
    menu.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: after }));
    expect(menu.hidden).toBe(true);
    const off = menuButton({ id: 'off', key: 'off', className: 'pick', label: 'Off', content: ['x'], disabled: true, items: [{ kind: 'command', value: 'x', label: 'X' }], onPick: () => undefined });
    document.body.append(off);
    (off.querySelector('button') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect((document.getElementById('off-menu') as HTMLElement).hidden).toBe(true);
  });
});

describe('board edge fades', () => {
  it('marks the edges with more content where scroll-driven animations are missing', () => {
    const observed: Element[] = [];
    let callback: IntersectionObserverCallback = () => undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          callback = cb;
        }
        observe(target: Element) {
          observed.push(target);
        }
        disconnect() {}
      },
    );
    vi.stubGlobal('CSS', { supports: () => false, escape: (value: string) => value });
    const first = h('section', { class: 'col' });
    const last = h('section', { class: 'col' });
    const wrap = h('div', { class: 'board-wrap' }, h('div', { class: 'board' }, first, h('section', { class: 'col' }), last));
    const observer = edgeHints(wrap);
    expect(observer).not.toBeNull();
    expect(observed).toEqual([first, last]);
    callback([{ target: first, intersectionRatio: 1 } as unknown as IntersectionObserverEntry, { target: last, intersectionRatio: 0.4 } as unknown as IntersectionObserverEntry], observer as IntersectionObserver);
    expect(wrap.classList.contains('more-start')).toBe(false);
    expect(wrap.classList.contains('more-end')).toBe(true);
    callback([{ target: first, intersectionRatio: 0.2 } as unknown as IntersectionObserverEntry], observer as IntersectionObserver);
    expect(wrap.classList.contains('more-start')).toBe(true);
    // Nothing to observe, or CSS does it: no observer.
    expect(edgeHints(h('div', {}, h('div', { class: 'board' })))).toBeNull();
    vi.stubGlobal('CSS', { supports: () => true, escape: (value: string) => value });
    expect(edgeHints(wrap)).toBeNull();
  });
});
