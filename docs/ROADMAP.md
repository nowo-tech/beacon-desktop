# Roadmap

What TimeTrack (this desktop app, the browser extension and Beacon's TimeTrackBundle) builds next, what was considered
and left out for now, and what it will deliberately never do. It follows the competitor analysis of 2026-11-05 (14
time trackers compared: Toggl, Clockify, Harvest, Everhour, Timely, Hubstaff, TimeCamp, RescueTime, WakaTime,
ActivityWatch, Tempo, ClickUp, Kimai, Jira) and the owner's decision to implement only the recommended items.

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
| 5 | **Timer button inside Beacon's task cards** through the browser extension: start, stop and see the remaining time on the card itself | Planned | High | M | 0 | extension (Beacon markup hooks) |
| 6 | **Calendar suggestions** (Google / Microsoft 365, read-only OAuth): an event whose title has the task key is proposed as an entry; dailies are grouped | Planned | High | M | 1 | desktop and extension (suggestions confirmed by the user) |
| 7 | **Weekly timesheet**: week view, *Submit week* with a Friday reminder, manager approval and period lock | Planned | High | M | 0 | Beacon / TimeTrackBundle (clients show the state) |
| 8 | **Optional Pomodoro, personal goals and focus mode** tied to the mascot (breaks it announces, daily / weekly goal with a kind progress in the tray, "do not disturb" during a block). Off by default, never rankings or comparisons with others | Planned | Medium | S–M | 0 | desktop and extension |
| 9 | **Private local timeline** (opt-in): app and window title, and the domain from the extension, recorded **only on this computer** with pause, exclusion list, deletion and short retention (e.g. 14 days); one click turns it into a **timesheet draft** the user edits and confirms | Planned | High | L | 2 | desktop and extension |
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
- Calendar integration, window titles or URLs to name the meeting automatically are **not** part of it; any such idea
  would be a separate, opt-in item reviewed with a DPIA first.

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
| **Session token out of the webview**: Rust keeps the token and `beacon_fetch` / the updater add `Authorization` themselves, so the `secret_get` command and the token in webview memory go away. Today a script running in the main window could read the token with `secret_get`, clear the origin binding with `secret_delete` and bind another server (audits FN-L1, FY-D-2); script injection is prevented by `script-src 'self'` and a text-only DOM, so this is defence in depth | Planned (before 0.6) | desktop |

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

TimeTrack is a tool for the worker first. These features are common in "employee monitoring" products and are
excluded on purpose:

| Feature | Why not |
|---|---|
| **Screenshots** (even blurred) | They capture personal data and third parties' data (mail, health, chats) far beyond what time tracking needs. |
| **Keyboard / mouse activity scores visible to managers** | They measure movement, not work: reading, thinking and meetings score low; they invite "mouse jigglers" and are the most resented bossware metric. |
| **Sending URLs, window titles or app usage to the server** | That is surveillance of browsing and private life. If the local timeline (item 9) comes, it stays on the computer; meeting detection reads the microphone holder locally and sends nothing. |
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
