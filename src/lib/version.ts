const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

/** Compares `MAJOR.MINOR.PATCH[-pre]` versions; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** True when `current` is below the server's `min_supported_version` (blocking "update required" screen). */
export function updateRequired(current: string, minSupported: string | null | undefined): boolean {
  return typeof minSupported === 'string' && minSupported !== '' && compareVersions(current, minSupported) < 0;
}
