// @vitest-environment happy-dom
// UX batch 4: the status strip (UXA-7) and the toast region with Undo (UXA-8), as components.
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { formatCountdown, pickMessage, StatusStrip, type StripClock, type StripMessage } from '../../src/ui/statusStrip';
import { MAX_TOASTS, ToastRegion, UNDO_MS } from '../../src/ui/toastRegion';

class Clock implements StripClock {
  t = 1_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

describe('status strip (UXA-7)', () => {
  beforeEach(() => document.body.replaceChildren());

  it('picks the most severe message, the first listed among equals', () => {
    const info: StripMessage = { key: 'i', text: 'i', tone: 'info' };
    const warnA: StripMessage = { key: 'a', text: 'a', tone: 'warn' };
    const warnB: StripMessage = { key: 'b', text: 'b', tone: 'warn' };
    const danger: StripMessage = { key: 'd', text: 'd', tone: 'danger' };
    expect(pickMessage([])).toBeNull();
    expect(pickMessage([null, false, undefined])).toBeNull();
    expect(pickMessage([info, warnA, warnB])).toBe(warnA);
    expect(pickMessage([info, warnB, danger, warnA])).toBe(danger);
  });

  it('formats a countdown as m:ss, rounded up, never negative', () => {
    expect(formatCountdown(25_000)).toBe('0:25');
    expect(formatCountdown(24_001)).toBe('0:25');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('keeps its slot, shows one message, announces it once, dismiss hides it until it changes', () => {
    const announce = vi.fn();
    const onDismiss = vi.fn();
    const focusAway = vi.fn();
    const strip = new StatusStrip({ id: 'x', dismissLabel: 'Dismiss', announce, onDismiss, focusAway, clock: new Clock() });
    document.body.append(strip.root, Object.assign(document.createElement('button'), { id: 'elsewhere' }));
    expect(strip.root.id).toBe('x-strip');
    expect(strip.box.hidden).toBe(true);
    const retry = vi.fn();
    strip.show({ key: 'offline', text: 'You are offline.', tone: 'warn', action: { id: 'x-retry', label: 'Retry', onClick: retry } });
    expect(strip.box.hidden).toBe(false);
    expect(strip.box.className).toBe('ss-box warn');
    expect(strip.root.dataset.tone).toBe('warn');
    expect(document.querySelector('#x-text')?.textContent).toBe('You are offline.');
    (document.querySelector('#x-retry') as HTMLButtonElement).click();
    expect(retry).toHaveBeenCalledOnce();
    // The same message again (a re-render) is not announced twice.
    strip.show({ key: 'offline', text: 'You are offline.', tone: 'warn' });
    expect(announce).toHaveBeenCalledTimes(1);
    (document.querySelector('#x-dismiss') as HTMLButtonElement).focus();
    (document.querySelector('#x-dismiss') as HTMLButtonElement).click();
    expect(strip.box.hidden).toBe(true);
    expect(strip.current).toBeNull();
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ key: 'offline' }));
    expect(focusAway).toHaveBeenCalledOnce();
    // Still the same message: stays hidden; another one shows (and is announced).
    strip.show({ key: 'offline', text: 'You are offline.', tone: 'warn' });
    expect(strip.box.hidden).toBe(true);
    strip.show({ key: 'error', text: 'Could not load.', tone: 'danger', dismissible: false });
    expect(strip.box.hidden).toBe(false);
    expect(document.querySelector('#x-dismiss')).toBeNull();
    expect(announce).toHaveBeenLastCalledWith('Could not load.');
    strip.dismiss();
    strip.show(null);
    expect(strip.box.hidden).toBe(true);
    expect(strip.root.dataset.tone).toBeUndefined();
    strip.dismiss();
  });

  it('counts down every second without announcing again, then calls onElapsed once', () => {
    const clock = new Clock();
    const announce = vi.fn();
    const onElapsed = vi.fn();
    const strip = new StatusStrip({ id: 'c', dismissLabel: 'Dismiss', announce, clock });
    document.body.append(strip.root);
    strip.show({ key: 'rate', text: (left) => `Back in ${formatCountdown(left)}.`, tone: 'info', until: clock.now() + 3000, onElapsed });
    const text = () => document.querySelector('#c-text')?.textContent;
    expect(text()).toBe('Back in 0:03.');
    clock.advance(1000);
    expect(text()).toBe('Back in 0:02.');
    clock.advance(2000);
    expect(text()).toBe('Back in 0:00.');
    expect(onElapsed).toHaveBeenCalledOnce();
    clock.advance(5000);
    expect(onElapsed).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledTimes(1);
    // A countdown already over calls back at once; a replaced message stops its clock.
    const late = vi.fn();
    strip.show({ key: 'late', text: () => 'x', tone: 'info', until: clock.now() - 1, onElapsed: late });
    expect(late).toHaveBeenCalledOnce();
    const stopped = vi.fn();
    strip.show({ key: 'r2', text: () => 'y', tone: 'info', until: clock.now() + 2000, onElapsed: stopped });
    strip.show({ key: 'other', text: 'z', tone: 'warn' });
    clock.advance(3000);
    expect(stopped).not.toHaveBeenCalled();
    strip.show({ key: 'r3', text: () => 'w', tone: 'info', until: clock.now() + 2000, onElapsed: stopped });
    strip.destroy();
    clock.advance(3000);
    expect(stopped).not.toHaveBeenCalled();
  });
});

describe('toast region (UXA-8)', () => {
  let region: ToastRegion;
  let announce: Mock<(text: string) => void>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    document.body.replaceChildren();
    announce = vi.fn();
    region = new ToastRegion({ label: 'Notifications', undoLabel: 'Undo', dismissLabel: 'Close', undoHint: 'Undo with Ctrl+Z.', shortcut: 'Ctrl+Z', announce });
    const field = Object.assign(document.createElement('textarea'), { id: 'field' });
    const outside = Object.assign(document.createElement('button'), { id: 'outside' });
    document.body.append(outside, field, region.root);
  });
  afterEach(() => vi.useRealTimers());

  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const toasts = () => [...region.root.querySelectorAll('.ut')];

  it('is one named region; a toast is announced with the keyboard hint, never focused, and expires after UNDO_MS', () => {
    expect(region.root.getAttribute('role')).toBe('region');
    expect(region.root.getAttribute('aria-label')).toBe('Notifications');
    expect(region.root.hidden).toBe(true);
    const undo = vi.fn();
    const onClose = vi.fn();
    (document.getElementById('outside') as HTMLButtonElement).focus();
    region.offer({ key: 'a', group: 'tasks', text: '#141 completed', undo, onClose });
    expect(region.root.hidden).toBe(false);
    expect(document.activeElement?.id).toBe('outside');
    expect(announce).toHaveBeenCalledWith('#141 completed. Undo with Ctrl+Z.');
    const button = region.root.querySelector('.ut-undo') as HTMLButtonElement;
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+Z Meta+Z');
    expect(button.title).toBe('Undo (Ctrl+Z)');
    vi.advanceTimersByTime(UNDO_MS - 10);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(20);
    expect(toasts()).toHaveLength(0);
    expect(region.root.hidden).toBe(true);
    expect(undo).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('a newer offer with the same key replaces the older; at most MAX_TOASTS; Undo and Close; focus moves on', () => {
    const undos = Array.from({ length: 5 }, () => vi.fn());
    region.offer({ key: 'same', group: 'g', text: 'one', undo: undos[0] });
    region.offer({ key: 'same', group: 'g', text: 'two', undo: undos[1] });
    expect(toasts().map((node) => node.textContent?.startsWith('two'))).toEqual([true]);
    region.offer({ key: 'b', group: 'g', text: 'b', undo: undos[2] });
    region.offer({ key: 'c', group: 'g', text: 'c', undo: undos[3] });
    region.offer({ key: 'd', group: 'g', text: 'd', undo: undos[4] });
    expect(region.offers.map((offer) => offer.key)).toEqual(['b', 'c', 'd']);
    expect(region.offers).toHaveLength(MAX_TOASTS);
    // Focus enters the region from outside: the timers pause; Undo moves focus to the next toast.
    (document.getElementById('outside') as HTMLButtonElement).focus();
    const first = toasts()[0].querySelector('.ut-undo') as HTMLButtonElement;
    first.focus();
    vi.advanceTimersByTime(UNDO_MS * 2);
    expect(region.offers).toHaveLength(3);
    first.click();
    expect(undos[2]).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(toasts()[0].querySelector('.ut-undo'));
    (toasts()[0].querySelector('.ut-close') as HTMLButtonElement).click();
    expect(undos[3]).not.toHaveBeenCalled();
    (toasts()[0].querySelector('.ut-close') as HTMLButtonElement).click();
    expect(region.offers).toHaveLength(0);
    expect(document.activeElement?.id).toBe('outside');
    expect(undos[0]).not.toHaveBeenCalled();
    expect(undos[1]).not.toHaveBeenCalled();
    expect(undos[4]).not.toHaveBeenCalled();
  });

  it('Ctrl/⌘+Z undoes the newest, not in a text field unless it holds the toast\'s text, not under a modal dialog', () => {
    const a = vi.fn();
    const b = vi.fn();
    expect(region.undoLatest()).toBe(false);
    region.offer({ key: 'a', group: 'chat', text: 'a', undo: a });
    region.offer({ key: 'b', group: 'chat', text: 'b', undo: b, fieldText: 'Never mind' });
    const field = document.getElementById('field') as HTMLTextAreaElement;
    field.value = 'Never mind!';
    key({ key: 'z', ctrlKey: true }, field);
    expect(b).not.toHaveBeenCalled();
    key({ key: 'z', ctrlKey: true, shiftKey: true });
    expect(b).not.toHaveBeenCalled();
    field.value = 'Never mind';
    key({ key: 'z', ctrlKey: true }, field);
    expect(b).toHaveBeenCalledOnce();
    key({ key: 'z', ctrlKey: true }, field);
    expect(a).not.toHaveBeenCalled();
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    dialog.showModal();
    key({ key: 'z', metaKey: true });
    expect(a).not.toHaveBeenCalled();
    dialog.close();
    dialog.remove();
    key({ key: 'z', metaKey: true });
    expect(a).toHaveBeenCalledOnce();
  });

  it('dropping a group closes its toasts without undo', () => {
    const undo = vi.fn();
    const onClose = vi.fn();
    region.offer({ key: 't', group: 'tasks', text: 't', undo, onClose });
    region.offer({ key: 'c', group: 'chat', text: 'c', undo });
    region.dismissGroup('tasks');
    expect(region.offers.map((offer) => offer.key)).toEqual(['c']);
    expect(onClose).toHaveBeenCalledOnce();
    region.dismiss('c');
    region.dismiss('missing');
    expect(region.offers).toHaveLength(0);
    expect(undo).not.toHaveBeenCalled();
  });

  it('hovering pauses the countdown', () => {
    region.offer({ key: 'h', group: 'g', text: 'h', undo: vi.fn() });
    region.root.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(UNDO_MS * 3);
    expect(region.offers).toHaveLength(1);
    region.root.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(UNDO_MS);
    expect(region.offers).toHaveLength(0);
  });
});
