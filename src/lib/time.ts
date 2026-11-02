/** Seconds elapsed since an ISO date (never negative). */
export function elapsedSeconds(startedAt: string, now: Date = new Date()): number {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - start) / 1000));
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/** `H:MM:SS` for the popup timer. */
export function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${pad(m)}:${pad(s)}`;
}

/** At most 4 characters for the toolbar badge: `0m`, `59m`, `1h05`, `9h59`, `10h+`. */
export function formatBadge(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours >= 10) {
    return '10h+';
  }
  return `${hours}h${pad(minutes % 60)}`;
}
