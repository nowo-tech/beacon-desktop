import type { WorkingHours } from '../api/types';

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function minutes(value: string): number | null {
  const match = TIME.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** ISO weekday (1 = Monday) and minutes since midnight of `now` in `timeZone` (or local time). */
function localParts(now: Date, timeZone?: string | null): { day: number; minute: number } {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
      const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
      return { day, minute: Number(get('hour')) * 60 + Number(get('minute')) };
    } catch {
      // Unknown time zone: fall back to local time.
    }
  }
  return { day: now.getDay() === 0 ? 7 : now.getDay(), minute: now.getHours() * 60 + now.getMinutes() };
}

/**
 * Right to disconnect (LOPDGDD art. 88): notifications only inside `me.workingHours`.
 * `null` / absent = the host publishes no hours → allowed. Present but not understood → not allowed (fail closed).
 */
export function withinWorkingHours(hours: WorkingHours | null | undefined | unknown, now: Date = new Date()): boolean {
  if (hours === null || hours === undefined) {
    return true;
  }
  const value = hours as Partial<WorkingHours>;
  if (!Array.isArray(value.slots)) {
    return false;
  }
  const { day, minute } = localParts(now, value.timezone);
  return value.slots.some((slot) => {
    const from = minutes(String(slot?.from ?? ''));
    const to = minutes(String(slot?.to ?? ''));
    return slot?.day === day && from !== null && to !== null && minute >= from && minute < to;
  });
}
