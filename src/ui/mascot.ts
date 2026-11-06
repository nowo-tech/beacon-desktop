import type { MessageKey } from '../lib/i18n';
import type { PoseId } from '../lib/messages/types';
import { h } from './dom';
import imported from './pose-art.json';

/**
 * Mascot moments (0.5.0). One pose per situation, the way symfony-beacon uses its robot: friendly empty, waiting, error
 * and success states, never on every screen and never inside the running timer. Every pose is a WebP with alpha in
 * `public/mascot/` (1x / @2x, provenance in public/mascot/README.md); the same art works on both themes (the dark
 * theme only dims it a little, see `--mascot-filter` in styles.css).
 */
export type Pose =
  | 'mascot'
  | 'mascot-small'
  | 'mascot-wait'
  | 'mascot-arcs'
  | 'pose-card'
  | 'pose-hourglass'
  | 'pose-reading'
  | 'pose-wrench'
  | 'pose-reconnect'
  | 'pose-pause'
  | 'error-401'
  | 'error-404'
  | 'error-429'
  | 'error-503';

export type Moment =
  | 'firstRun'
  | 'deviceWaiting'
  | 'deviceExpired'
  | 'deviceDenied'
  | 'signedIn'
  | 'saved'
  | 'longRunning'
  | 'noTasks'
  | 'noResults'
  | 'stillThere'
  | 'away'
  | 'gap'
  | 'resume'
  | 'offline'
  | 'updateOffer'
  | 'updateWorking'
  | 'updateRequired'
  | 'about';

/**
 * Pose of each moment, and its alt text when the picture says something the text next to it does not (the first-run
 * hero). Every other moment is decorative: the heading and text beside it carry the meaning (`alt=""` +
 * `aria-hidden`).
 */
export const MOMENTS: Record<Moment, { pose: Pose; alt: MessageKey | null }> = {
  firstRun: { pose: 'mascot', alt: 'mascotAlt' },
  deviceWaiting: { pose: 'mascot-wait', alt: null },
  deviceExpired: { pose: 'pose-hourglass', alt: null },
  deviceDenied: { pose: 'error-401', alt: null },
  signedIn: { pose: 'pose-card', alt: null },
  saved: { pose: 'mascot-small', alt: null },
  longRunning: { pose: 'pose-hourglass', alt: null },
  noTasks: { pose: 'mascot-small', alt: null },
  noResults: { pose: 'pose-reading', alt: null },
  stillThere: { pose: 'mascot-small', alt: null },
  away: { pose: 'pose-pause', alt: null },
  gap: { pose: 'pose-hourglass', alt: null },
  resume: { pose: 'pose-card', alt: null },
  offline: { pose: 'pose-reconnect', alt: null },
  updateOffer: { pose: 'mascot-small', alt: null },
  updateWorking: { pose: 'pose-wrench', alt: null },
  updateRequired: { pose: 'pose-wrench', alt: null },
  about: { pose: 'mascot-small', alt: null },
};

/** Error catalogue id → pose (errors without one show no picture). */
export const ERROR_POSES: Record<string, Pose> = {
  not_beacon: 'error-404',
  no_device_flow: 'error-404',
  invalid_response: 'error-404',
  unreachable: 'pose-reconnect',
  server: 'pose-wrench',
  rate_limited: 'error-429',
  insufficient_scope: 'error-401',
};

/** Image with 1x / 2x sources from `public/mascot/`. An empty `alt` marks it decorative (also hidden from the a11y tree). */
export function art(pose: Pose, alt: string, className: string): HTMLImageElement {
  return picture(pose, alt, className, pose);
}

function picture(file: string, alt: string, className: string, pose: string): HTMLImageElement {
  return h('img', {
    class: className,
    attrs: {
      src: `mascot/${file}.webp`,
      srcset: `mascot/${file}.webp 1x, mascot/${file}@2x.webp 2x`,
      alt,
      'aria-hidden': alt === '' ? 'true' : undefined,
      decoding: 'async',
      'data-pose': pose,
    },
  });
}

/**
 * Friendly-message poses (`POSE_IDS`) with their own art in `public/mascot/pose-<id>.webp`: written by
 * `scripts/mascot/import-poses.sh`, so new art needs no code change.
 */
export const POSE_ART: ReadonlySet<string> = new Set(imported as string[]);

/** Closest existing pose for the friendly-message poses whose own art is not imported yet. */
export const POSE_FALLBACK: Partial<Record<PoseId, Pose | `pose-${PoseId}`>> = {
  // Empty states (src/lib/emptyStates.ts) until their own art (`pose-empty-*`) is imported.
  'empty-pinned': 'pose-peek-3',
  'empty-recent': 'pose-focus',
  'empty-tasks': 'pose-teamwork',
};

/** Shown for a pose with neither art nor a fallback (a new id before its art arrives). */
const LAST_RESORT: Pose = 'mascot-small';

/** File (without extension) drawn for a friendly-message pose: its own art, else the fallback. */
export function poseFile(id: PoseId, available: ReadonlySet<string> = POSE_ART): string {
  return available.has(id) ? `pose-${id}` : (POSE_FALLBACK[id] ?? LAST_RESORT);
}

/** Decorative picture of a friendly message (`data-pose` = the message's pose id). */
export function poseArt(id: PoseId, className: string): HTMLImageElement {
  return picture(poseFile(id), '', className, id);
}

/**
 * Picture of an empty state of the list, with its alt text (`data-pose` = the empty-state pose id): the light-theme
 * art and, when imported, the `-dark` variant with a light outer stroke (else the same art). CSS shows the one of the
 * active theme (`.theme-light` / `.theme-dark`, following Settings → Theme and the system); the hidden one is out of
 * the accessibility tree.
 */
export function emptyArt(id: PoseId, alt: string, className: string, available: ReadonlySet<string> = POSE_ART): HTMLElement {
  const darkId = `${id}-dark` as PoseId;
  const dark = available.has(darkId) ? `pose-${darkId}` : poseFile(id, available);
  return h(
    'span',
    { class: `${className} empty-art-pair`, attrs: { 'data-pose': id } },
    picture(poseFile(id, available), alt, 'theme-light', id),
    picture(dark, alt, 'theme-dark', darkId),
  );
}

/** The picture of a moment, with its translated alt text (or decorative). */
export function moment(name: Moment, className: string, translate: (key: MessageKey) => string): HTMLImageElement {
  const { pose, alt } = MOMENTS[name];
  const image = art(pose, alt !== null ? translate(alt) : '', className);
  image.setAttribute('data-moment', name);
  return image;
}

/**
 * Picks one of several equivalent messages (light variety in success copy) without randomness, so tests and
 * screenshots are stable: the n-th success of a session gets variant n mod count.
 */
export function variant<T>(choices: readonly T[], n: number): T {
  return choices[((n % choices.length) + choices.length) % choices.length] as T;
}
