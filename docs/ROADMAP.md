# Roadmap

What TimeTrack (this desktop app, the browser extension and Beacon's TimeTrackBundle) builds next, what was considered
and left out for now, and what it will deliberately never do. It follows the market analysis of 2026-11-05 (14
time trackers compared), the owner's decision to implement only the recommended items, and the feature gap review of
2026-11-18 (section 4).

Product line: **TimeTrack measures your time, it does not watch you. What you do not confirm does not leave your
computer.**

Scales used below:

- **Value**: high, medium, low.
- **Effort**: S (up to 3 days), M (1–2 weeks), L (more than 3 weeks).
- **Privacy risk**: 0 none · 1 low (local only) · 2 medium (needs consent or careful design) · 3 high.
- **Owner**: the component that does most of the work — *desktop* (this repository), *extension* (time-track-extension),
  *TimeTrackBundle* (the client API in Beacon), *Beacon* (the host application).

## 1. Recommended (approved)

| # | Item | Status | Value | Effort | Privacy | Owner |
|---|---|---|---|---|---|---|
| 1 | **Continue last, global shortcut and time in the tray**: one click or `Ctrl/Cmd+Alt+T` (`Ctrl+Alt+Shift+R` on Linux; window hidden or not) starts the last task again; the tray shows the elapsed time (macOS menu-bar title, tooltip everywhere), refreshed by the Rust heartbeat | Done / 0.5.0 | High | S | 0 | desktop |
| 2 | **Three answers on return from idle**: keep · discard (stop at the idle start) · reassign to another task or a quick "Meeting", from pinned, recent or a search | Done / 0.5.0 (desktop) | High | S | 0 | desktop (extension to follow) |
| 3 | **"Working without a timer?"** reminder during working hours (Start last / Choose task, at most every 45 min) and **pause on screen lock or sleep** with the same three answers on return | Done / 0.5.0 | High | S | 0–1 (OS signals stay local) | desktop |
| 4 | **Estimate, remaining and logged time** of the task in the timer card and the task rows | Next, after 0.5.0 — waiting for the API: TimeTrackBundle's `GET tasks` / `GET timer` do not publish the estimate or the time logged yet (request below) | High | S | 0 | TimeTrackBundle, then desktop and extension |
| 5 | **Timer button inside Beacon's task cards** through the browser extension: start, stop and see the remaining time on the card itself | Done / extension 0.4.0 | High | M | 0 | extension (Beacon markup hooks) |
| 6 | **Calendar suggestions** (Google / Microsoft 365, read-only OAuth): an event whose title has the task key is proposed as an entry; dailies are grouped | Planned | High | M | 1 | desktop and extension (suggestions confirmed by the user) |
| 7 | **Weekly timesheet**: week view, *Submit week* with a Friday reminder, manager approval and period lock | Planned | High | M | 0 | Beacon / TimeTrackBundle (clients show the state) |
| 8 | **Optional Pomodoro, personal goals and focus mode** tied to the mascot (breaks it announces, daily / weekly goal with a kind progress in the tray, "do not disturb" during a block). Off by default, never rankings or comparisons with others | Out of the closure (owner decision 2026-11-11); no date | Medium | S–M | 0 | desktop and extension |
| 9 | **Private local timeline** (opt-in): app and window title, and the domain from the extension, recorded **only on this computer** with pause, exclusion list, deletion and short retention (e.g. 14 days); one click turns it into a **timesheet draft** the user edits and confirms | Out of the closure (owner decision 2026-11-11); no date | High | L | 2 | desktop and extension |
| 10 | **Working day, hours balance, holidays and overtime** (contracted hours, Spain's RDL 8/2019 working-time record) and **budget vs actual** per project with 80 % / 100 % alerts | Planned | High | L | 0–1 | Beacon / TimeTrackBundle |

### Also in 0.5.0: meeting detection

| Item | Status | Privacy risk | Owner |
|---|---|---|---|
| **Meeting detection** (opt-in): notice a call in Teams, Zoom, Webex, Slack, a browser (Google Meet, Jitsi…) and similar apps from the microphone being in use, ask which meeting it is (a task, the generic meeting, "not a meeting", "don't ask for this app") and offer to go back to the previous task when the call ends | Done / 0.5.0 | 1 (local only, opt-in) | desktop |

#### Meeting detection and the "not doing" rules

Meeting detection reads an activity signal, so it follows the rule below for anything near monitoring:

- **Opt-in**: off by default, turned on in Settings with a dated consent record, revocable at any time (turning it off
  stops the checks and deletes the call's state).
- **Local-first**: the microphone state and the app's identity are read on the computer every 20 seconds and reduced
  at once to a fixed app name (Teams, Zoom, …, "browser"); nothing about the call is stored beyond its state in local
  storage, and **nothing is sent to the server**. Only the timer action the person chooses reaches Beacon, as any
  manual action does.
- **Transparent**: Settings explains exactly what is read and shows what the last check found; PRIVACY.md lists it.
- **Minimal** (GDPR art. 5(1)(c)): only "is the microphone in use" and "which meeting app holds it". **No window
  titles, URLs, chats, participants or audio** — a Google Meet tab is only "a browser call".
- **Not employer monitoring** (Estatuto de los Trabajadores art. 20.3; LOPDGDD art. 87, privacy in the use of digital
  devices at work): it only helps the worker record their own time; the employer sees nothing the worker did not
  record.
- Window titles or URLs to name the meeting automatically are **not** part of it. Calendar data reaches the app
  only through **meeting reminders** (below), a separate item covered by Beacon's DPIA for spec 210.

### Meeting reminders (TimeTrack 1.14, spec 210)

| Item | Status | Privacy risk | Owner |
|---|---|---|---|
| **Meeting reminders**: a reminder before each meeting (5 min by default, 1–120 or off), *Join* and *Snooze*, a start prompt when a timer runs (*Keep* / *Pause* / *Track the meeting*, opt-in automatic pause), *Today's meetings* in the window and the tray; only inside working hours and never on days off unless switched on | Done, unreleased (desktop ≥ 0.6, contract §23) | 1 (data from Beacon, local cache ≤ 48 h) | desktop; Beacon (calendars, sync, DPIA) and TimeTrackBundle 1.14 (`GET me/meetings`) |

Rules (contract §22–§23, owner decisions Q-O18…Q-O22): the meetings come from Beacon, which owns the calendar
connection, the sync, retention and the DPIA; the desktop asks for `meetings:read` explicitly; the reminders are on by
default only once a calendar is connected in Beacon (connecting it is the opt-in) and can be switched off per device;
the local list lives at most 48 hours and is deleted on sign-out; nothing about meetings is sent back. The browser
extension shows no meetings in 1.14 (Q-O21).

### API request for item 4 (TimeTrackBundle)

The desktop does not invent these numbers. The client API needs, on each task of `GET /api/time-track/tasks` and on
the running timer of `GET /api/time-track/timer` (and `timer/start`, `timer/switch`), three optional fields, absent
when unknown (contract v0.4, announced in `GET me.features.task_effort`):

```json
{
  "id": "T-101",
  "title": "Write onboarding guide",
  "estimateSeconds": 28800,
  "loggedSeconds": 19800,
  "remainingSeconds": 9000
}
```

- `estimateSeconds`: the task's estimate (`Task::getEstimatedMinutes() * 60` in TaskBoardBundle), `null` without one.
- `loggedSeconds`: time logged on the task by everyone, closed entries only (the clients add the running timer).
- `remainingSeconds`: `max(0, estimate - logged)`, or `null` without an estimate (sent so every client rounds the same
  way; negative overruns are shown as "over by …" from `loggedSeconds - estimateSeconds`).
- Through `TaskReference` / `TaskProviderInterface` (new optional properties, `null` by default, so other providers keep
  working) and `ClientTaskPresenter::task()` / `timer()`; `features.task_effort = true` when the provider fills them.

### Security hardening (desktop)

| Item | Status | Owner |
|---|---|---|
| **Session token out of the webview**: Rust keeps the token in the OS keychain with the origin that issued it, and `beacon_fetch` / the updater add `Authorization` themselves; `secret_get` / `secret_set` are gone, sign-in answers are captured in Rust only after a native confirmation, and token fields are scrubbed from every answer (audits FN-L1, FY-D-2, GM; SECURITY.md, *Credentials*) | Done (0.6.0) | desktop |

## 2. Considered, not scheduled

From the same analysis; kept as ideas, with no date.

| Item | Value | Effort | Privacy | Owner | Note |
|---|---|---|---|---|---|
| Tags and billable / non-billable on the entry, last value remembered | Medium | S | 0 | TimeTrackBundle, clients | Needs the field in Beacon |
| Notes required per project | Low | S | 0 | Beacon | Server-side policy |
| Button on GitHub / GitLab issues and pull requests that finds the Beacon task by its key | Medium | M | 1 | extension | Reads the active tab's URL only when pressed, never stores it |
| Weekly personal report (notification or e-mail): hours per project, breaks taken, overtime | Medium | S–M | 0 | Beacon | Only for the user |
| Suggestions from local Git commits with a task key | Medium | M | 1 | desktop | Only repositories the user picks; nothing sent without confirmation |
| Webhooks and a public API for time entries | Medium | M | 0 | TimeTrackBundle | For customer integrations |
| Assisted timesheet draft with rules (and, if ever, a local model) from the timeline, the calendar and Git | High | L | 2 | desktop | Deterministic rules first; AI only local or with consent |
| Mobile app or PWA with a synced timer and an offline queue | Medium | L | 0 | Beacon | A PWA in Beacon may be enough at first |
| Invoicing (rates, invoices, EU e-invoice) | Medium | L | 0 | Beacon | Only if the target market bills by the hour |
| IDE plugins (VS Code, JetBrains) that show or start the timer of the branch's task | Medium | L | 1 | new clients | The timer leads; no heartbeats to the server |

## 3. Deliberately NOT doing

**Activity monitoring** (screenshots, applications and activity level; spec 199, TimeTrackBundle 1.26) is **off unless
your organisation enables it with a recorded DPIA; you see it first**. It runs only while your own timer runs, captures
only what the organisation's policy lists, and is never turned into a score. Everything below stays out in every case.

TimeTrack is a tool for the worker first. These features are common in "employee monitoring" products and are
excluded on purpose:

| Feature | Why not |
|---|---|
| **Productivity or activity scores** | They measure movement, not work: reading, thinking and meetings score low; they invite "mouse jigglers" and are the most resented bossware metric. |
| **Keystrokes, clipboard or full URLs** | That is surveillance of private life and of third parties' data, far beyond what time tracking needs. Meeting detection reads the microphone holder locally and sends nothing. |
| **Recording or analysing audio** | Meeting detection never opens the microphone or reads its level. |
| **GPS, webcam or kiosk photos** | Location and biometric data are high-risk and disproportionate for office or remote work. |
| **Forced timers** (no manual entries) | It treats people as suspects and blocks the legitimate correction of a forgotten timer; kind reminders and approval work better. |
| **Peer rankings or leaderboards** | They reward hours, not results, push presenteeism and clash with wellbeing. Personal goals are fine; comparisons are not. |
| **Forced website blocking** | Paternalistic and out of scope at work; at most an optional "do not disturb" for the user. |

The same reasons apply to all of them:

- **Worker trust.** People who feel watched stop trusting the tool and the employer, and the data gets worse, not better.
  TimeTrack's value is that people use it willingly.
- **GDPR.** Data minimisation and proportionality (art. 5(1)(c)): only what is needed for the purpose. Monitoring based
  on the employer's legitimate interest must pass the balancing test, and systematic monitoring of employees calls for
  a data protection impact assessment (art. 35) that these features would hardly pass.
- **Spanish Estatuto de los Trabajadores**, art. 20.3: the employer's monitoring must respect the worker's dignity; art.
  20 bis: the right to privacy in the use of digital devices and to digital disconnection.
- **LOPDGDD**, arts. 87–91: privacy in the use of digital devices at work (87), digital disconnection (88), video
  surveillance and sound recording (89), geolocation (90), and collective agreements setting these guarantees (91).

**Rule for any future feature near monitoring** (the local timeline, calendar or Git suggestions, anything that reads
activity): it must be **opt-in**, **local-first** (nothing leaves the computer unless the worker confirms it),
**transparent to the worker** (they see exactly what is recorded, can pause and delete it) and **reviewed with a DPIA**
before it ships.

## 4. Feature gap review (2026-11-18)

What the desktop app (0.6.0) and the extension (0.4.0) still lack against what time-tracking clients usually offer,
once the server side exists. Server-side items (rates, projects, team reports, webhooks) are in the
[TimeTrackBundle roadmap](https://github.com/nowo-tech/TimeTrackBundle/blob/main/docs/ROADMAP.md) and the register,
leave and holidays in the [WorkingTimeBundle roadmap](https://github.com/nowo-tech/WorkingTimeBundle/blob/main/docs/ROADMAP.md).
Items 1–10 above are not repeated. Order inside each horizon is the priority.

### Next

| Item | What it is | Why it helps | Owner |
|---|---|---|---|
| **Clock in, break and clock out** | The workday buttons and state from the client API (`GET workday`, `POST workday/{action}`, TimeTrackBundle 1.13), in the window and the tray, with the offline queue keeping the real time | One app for the legal working-hours register and task time; workers forget the second app | desktop, then extension |
| **Activity monitoring client** (spec 199, closure block 3) | The desktop side of TimeTrackBundle 1.26: the notice first, a visible indicator while it runs, pause, a list of what was captured and delete before upload | Planned for the closure; off unless the organisation enables it with a recorded DPIA, you see it first | desktop |
| **Add and edit past entries** | A form for a forgotten entry (`POST entries`, 1.14) and edits of the person's own open-period entries | Corrections today need the web; the clients are where people notice the gap | desktop and extension |
| **Today and this week** | Tracked time per day and task for the current week, against the working-time target when Beacon sends it | Shows at a glance whether the day is complete | desktop |
| **Timesheet state and submit** | The week's state (open, submitted, approved, locked) and *Submit week* with the reminder of item 7 | The approval flow already exists on the server; the clients only need to show it | desktop and extension |
| **Three answers on return from idle, in the extension** | The keep / discard / reassign choice of item 2 in the extension popup | Same behaviour in both clients | extension |

### Later

| Item | What it is | Why it helps | Owner |
|---|---|---|---|
| **Hours balance and leave** | The hours balance (`GET balance`) and today's leave or day off, with reminders held on those days | Workers see what they owe or are owed and are not nudged on leave | desktop |
| **Tags and billable on start** | Pick tags and billable when starting, last value remembered (from section 2, once the server has tags) | Complete entries without opening the web | desktop and extension |
| **Favourites** | Saved task + tag + billable combinations, also as tray entries | One-click start for frequent work | desktop and extension |
| **Keyboard-first command bar** | Search, start, switch and stop from one shortcut-opened field | Fast for heavy users; accessible without a pointer | desktop |
| **Accessibility pass** | Screen reader labels, focus order and contrast checked on every view of both clients (WCAG 2.2 AA) | The clients must be usable by everyone the web is | desktop and extension |

### Considering

| Item | What it is | Why it helps | Note |
|---|---|---|---|
| **Domains from the extension** (spec 199) | Domains, never full URLs, while the worker's own timer runs | Completes monitoring for browser work | Announced after TimeTrackBundle 1.26; off unless the organisation enables it with a recorded DPIA; you see it first |
| **Phone companion** | A mobile client or installable web page with a synced timer and an offline queue (section 2) | Tracking away from the computer | A web page in Beacon may be enough |
