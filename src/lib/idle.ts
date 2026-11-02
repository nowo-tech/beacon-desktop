/**
 * Local idle detection. Fed with the OS "seconds since last input"; it only decides WHEN to ask the user.
 * The idle state never leaves the device: only the user's decision goes to `POST timer/discard-idle`.
 */
export interface IdlePeriod {
  from: Date;
  to: Date;
}

export class IdleMonitor {
  private idleFrom: Date | null = null;

  constructor(public thresholdSeconds: number) {}

  get isIdle(): boolean {
    return this.idleFrom !== null;
  }

  /** Returns the idle period once the user is back (input seen after being idle ≥ threshold), else null. */
  observe(idleSeconds: number, now: Date = new Date()): IdlePeriod | null {
    if (this.idleFrom === null) {
      if (idleSeconds >= this.thresholdSeconds) {
        this.idleFrom = new Date(now.getTime() - idleSeconds * 1000);
      }
      return null;
    }
    if (idleSeconds < this.thresholdSeconds) {
      const period = { from: this.idleFrom, to: new Date(now.getTime() - idleSeconds * 1000) };
      this.idleFrom = null;
      return period.to > period.from ? period : null;
    }
    return null;
  }

  reset(): void {
    this.idleFrom = null;
  }
}

/** The server requires `from` ≥ timer start and `to` ≤ now. */
export function clampPeriod(period: IdlePeriod, timerStart: string, now: Date = new Date()): IdlePeriod | null {
  const start = new Date(timerStart);
  const from = period.from < start ? start : period.from;
  const to = period.to > now ? now : period.to;
  return to > from ? { from, to } : null;
}
