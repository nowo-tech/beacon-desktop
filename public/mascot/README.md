# Mascot art

The robot is symfony-beacon's mascot (the owner's own artwork), reused here the way Beacon uses it: friendly empty,
waiting, error and success moments, never on every screen. Every file is a WebP with alpha, in 1x and `@2x`.

## Provenance

| File | Source in nowo-tech/symfony-beacon | How |
|---|---|---|
| `mascot`, `mascot-small`, `mascot-wait`, `mascot-arcs` | `public/brand/mascot.png` | 0.2.0: standing robot, small robot, robot without its arcs and the arcs alone (the device-code pulse) |
| `error-401`, `error-404`, `error-429`, `error-503` | `public/illustrations/error-{401,404,429,503}.png` | 0.2.0: whole illustration, resized |
| `pose-card` | `public/illustrations/error-401.png` | 0.5.0: robot waving with its access card (crop, number removed) |
| `pose-hourglass` | `public/illustrations/error-408.png` | 0.5.0: robot with alarm clock and hourglass (crop, number removed) |
| `pose-reading` | `public/illustrations/error-400.png` | 0.5.0: robot reading instructions (crop, number removed) |
| `pose-wrench` | `public/illustrations/error-500.png` | 0.5.0: robot with a wrench next to a server (crop, number removed) |
| `pose-reconnect` | `public/illustrations/error-502.png` | 0.5.0: robot plugging a cable back in (crop, number removed) |
| `pose-pause` | `public/illustrations/error-429.png` | 0.5.0: robot next to a pause button (crop, number removed) |

The 0.5.0 poses were taken from symfony-beacon `main` at `a573ca6b` (v1.121.0) and are rebuilt with
`python scripts/mascot/build.py <symfony-beacon checkout>` (Pillow; crop boxes, feathered edges, 96 px / 192 px high,
WebP quality 80). Add `--preview poses.png` to get every pose on the light and dark paper.

## Where each pose appears

The catalogue is `src/ui/mascot.ts` (`MOMENTS`, `ERROR_POSES`).

| Moment | Pose |
|---|---|
| First run (sign-in screen) | `mascot` (alt text: the robot waving) |
| Device code: waiting for approval | `mascot-wait` + pulsing `mascot-arcs` (static with reduced motion) |
| Device code: expired | `pose-hourglass` |
| Device code: declined / missing permissions | `error-401` |
| Signed in ("You're in!") | `pose-card` |
| Timer stopped ("Saved 0:25 on …") | `mascot-small` in the notice |
| Timer running for 8 hours or more ("Still going strong?") | `pose-hourglass` |
| No tasks yet | `mascot-small` |
| No search results | `pose-reading` |
| "Still there?" | `mascot-small` |
| Timer paused after no answer | `pose-pause` |
| "Welcome back" (time away) | `pose-hourglass` |
| "Resume …?" | `pose-card` |
| Offline | `pose-reconnect` (card and the "can't reach" error) |
| Rate limited | `error-429` |
| Server error | `pose-wrench` |
| Not a Beacon / no device sign-in | `error-404` |
| Update available | `mascot-small` |
| Update downloading / installing | `pose-wrench` |
| Update required (direct and Microsoft Store builds) | `pose-wrench` |
| About | `mascot-small` |

Not on purpose: the running timer card, the task rows, Settings (apart from About) and the privacy screen.

## Rules

- Decorative by default: `alt=""` and `aria-hidden="true"`; the heading next to the picture carries the meaning. Only
  the first-run hero has alt text (translated, `mascotAlt`).
- Themes: the same art on light and dark paper (Beacon has no dark variants either). The dark theme dims it slightly
  (`--mascot-filter`); crops have feathered edges so no glow ends in a hard rectangle.
- Motion: only the device-code arcs pulse, and not under `prefers-reduced-motion: reduce`.
- Size: tiny (3 rem) in cards and empty states, small (4 rem) on full screens, 7.5 rem for the first-run hero and error
  art. Each file stays under 45 KB (unit test).
