import { describe, expect, it } from 'vitest';
import type { Entry, Timer } from '../../src/api/types';
import { FULL_BREAKPOINT, inside, layoutFor, loadWindowMemory, otherMode, placeWindow, PRESETS, saveWindowMemory, type Screens, WINDOW_KEY, type WindowMemory } from '../../src/lib/layout';
import { todaySpans, weekByTask, weekDays } from '../../src/lib/week';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 };
const screens = (over: Partial<Screens> = {}): Screens => ({ areas: [SCREEN], current: SCREEN, scale: 1, ...over });
// UXA-30: nothing remembered opens the full view (about 1200 × 780).
const empty: WindowMemory = { mode: 'full', bounds: {} };

describe('layout', () => {
  it('picks the layout from the width and flips the mode', () => {
    expect(layoutFor(400)).toBe('compact');
    expect(layoutFor(FULL_BREAKPOINT - 1)).toBe('compact');
    expect(layoutFor(FULL_BREAKPOINT)).toBe('full');
    expect(otherMode('compact')).toBe('full');
    expect(otherMode('full')).toBe('compact');
  });

  it('remembers the mode and valid bounds only', () => {
    const storage = new MemoryStorage();
    expect(loadWindowMemory(storage)).toEqual(empty);
    saveWindowMemory({ mode: 'full', bounds: { full: { x: 10.4, y: 20, width: 1200, height: 780 } } }, storage);
    expect(loadWindowMemory(storage)).toEqual({ mode: 'full', bounds: { full: { x: 10, y: 20, width: 1200, height: 780 } } });
    storage.setItem(WINDOW_KEY, JSON.stringify({ mode: 'huge', bounds: { compact: { x: 1, y: 2, width: 0, height: 5 }, full: { x: 'a' }, other: null } }));
    expect(loadWindowMemory(storage)).toEqual(empty);
    storage.setItem(WINDOW_KEY, JSON.stringify({ bounds: { compact: null } }));
    expect(loadWindowMemory(storage)).toEqual(empty);
    storage.setItem(WINDOW_KEY, '{oops');
    expect(loadWindowMemory(storage)).toEqual(empty);
    const full = new MemoryStorage();
    full.setItem = () => {
      throw new Error('quota');
    };
    expect(() => saveWindowMemory(empty, full)).not.toThrow();
  });

  it('opens a view at its preset, centred, scaled to the screen', () => {
    expect(placeWindow('compact', empty, screens())).toEqual({ x: 760, y: 200, width: 400, height: 640 });
    expect(placeWindow('full', empty, screens())).toEqual({ x: 360, y: 130, width: 1200, height: 780 });
    const hiDpi = { x: 0, y: 0, width: 3840, height: 2080 };
    expect(placeWindow('full', empty, screens({ areas: [hiDpi], current: hiDpi, scale: 2 }))).toEqual({ x: 720, y: 260, width: 2400, height: 1560 });
    expect(placeWindow('full', empty, screens({ scale: 0 })).width).toBe(PRESETS.full.width);
  });

  it('keeps remembered bounds on any screen they fit on, else centres them on the current one', () => {
    const second = { x: 1920, y: 0, width: 1280, height: 1000 };
    const memory: WindowMemory = { mode: 'full', bounds: { full: { x: 2000, y: 50, width: 1100, height: 700 }, compact: { x: 100, y: 100, width: 420, height: 700 } } };
    expect(placeWindow('full', memory, screens({ areas: [SCREEN, second] }))).toEqual(memory.bounds.full);
    expect(placeWindow('compact', memory, screens())).toEqual(memory.bounds.compact);
    // The second monitor is gone: centred on the current one.
    expect(placeWindow('full', memory, screens())).toEqual({ x: 410, y: 170, width: 1100, height: 700 });
  });

  it('never makes the window larger than the work area nor smaller than the minimum', () => {
    const small = { x: 0, y: 0, width: 1024, height: 600 };
    expect(placeWindow('full', empty, screens({ areas: [small], current: small }))).toEqual({ x: 0, y: 0, width: 1024, height: 600 });
    const memory: WindowMemory = { mode: 'compact', bounds: { compact: { x: 5, y: 5, width: 100, height: 100 } } };
    expect(placeWindow('compact', memory, screens())).toEqual({ x: 5, y: 5, width: 380, height: 560 });
    const tiny = { x: 0, y: 0, width: 300, height: 400 };
    expect(placeWindow('compact', empty, screens({ areas: [tiny], current: tiny }))).toEqual({ x: 0, y: 0, width: 300, height: 400 });
  });

  it('uses the first screen when the current one is unknown, and the bounds as they are with no screen at all', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1040 };
    expect(placeWindow('compact', empty, screens({ areas: [second], current: null }))).toEqual({ x: 2680, y: 200, width: 400, height: 640 });
    expect(placeWindow('compact', empty, screens({ areas: [], current: null }))).toEqual({ x: 0, y: 0, width: 400, height: 640 });
    const memory: WindowMemory = { mode: 'compact', bounds: { compact: { x: 7, y: 8, width: 400, height: 640 } } };
    expect(placeWindow('compact', memory, screens({ areas: [], current: null }))).toEqual({ x: 7, y: 8, width: 400, height: 640 });
  });

  it('tells whether a rectangle fits in an area', () => {
    expect(inside({ x: 0, y: 0, width: 1920, height: 1040 }, SCREEN)).toBe(true);
    expect(inside({ x: -1, y: 0, width: 10, height: 10 }, SCREEN)).toBe(false);
    expect(inside({ x: 1900, y: 0, width: 30, height: 10 }, SCREEN)).toBe(false);
    expect(inside({ x: 0, y: 1035, width: 10, height: 10 }, SCREEN)).toBe(false);
  });
});

const entry = (taskId: string, from: string, to: string): Entry => ({ id: `${taskId}-${from}`, taskId, taskTitle: `Task ${taskId}`, startedAt: from, endedAt: to, durationSeconds: 0 });

describe('week', () => {
  // Wednesday 2026-11-04 15:00 (TZ=UTC in the tests).
  const now = new Date('2026-11-04T15:00:00Z');
  const entries = [
    entry('A', '2026-11-04T09:00:00Z', '2026-11-04T10:30:00Z'),
    entry('B', '2026-11-03T23:00:00Z', '2026-11-04T01:00:00Z'),
    entry('A', '2026-11-02T08:00:00Z', '2026-11-02T12:00:00Z'),
    entry('C', '2026-11-01T08:00:00Z', '2026-11-01T09:00:00Z'),
    entry('X', 'nope', '2026-11-04T01:00:00Z'),
    entry('Y', '2026-11-04T05:00:00Z', '2026-11-04T04:00:00Z'),
  ];
  const timer: Timer = { taskId: 'C', taskTitle: 'Task C', startedAt: '2026-11-04T14:00:00Z' } as Timer;

  it("lists today's stretches oldest first, clipped to today, with the running timer", () => {
    const spans = todaySpans(entries, timer, now);
    expect(spans.map((span) => [span.taskId, span.from.toISOString(), span.seconds, span.running])).toEqual([
      ['B', '2026-11-04T00:00:00.000Z', 3600, false],
      ['A', '2026-11-04T09:00:00.000Z', 5400, false],
      ['C', '2026-11-04T14:00:00.000Z', 3600, true],
    ]);
    expect(todaySpans(entries, timer, now, 'A').map((span) => span.seconds)).toEqual([5400]);
    expect(todaySpans([], null, now)).toEqual([]);
    expect(todaySpans([], { ...timer, startedAt: 'bad' }, now)).toEqual([]);
  });

  it('adds up the week by day (Monday first) and by task', () => {
    const days = weekDays(entries, timer, now);
    expect(days.map((day) => day.date.toISOString().slice(0, 10))).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    expect(days.map((day) => day.seconds)).toEqual([4 * 3600, 3600, 3600 + 5400 + 3600, 0, 0, 0, 0]);
    const byTask = weekByTask(entries, timer, now);
    expect(Object.fromEntries(byTask)).toEqual({ A: 4 * 3600 + 5400, B: 7200, C: 3600 });
  });
});
