# Roadmap

What TimeTrack (this desktop app, the browser extension and Beacon's TimeTrackBundle) builds next and what it will
deliberately never do.

Product line: **TimeTrack measures your time, it does not watch you. What you do not confirm does not leave your
computer.**

## In progress

| Item | Status | Privacy risk | Owner |
|---|---|---|---|
| **Meeting detection** (opt-in): notice a call in Teams, Zoom, Webex, Slack, a browser (Google Meet, Jitsi…) and similar apps from the microphone being in use, ask which meeting it is (a task, the generic meeting, "not a meeting", "don't ask for this app") and offer to go back to the previous task when the call ends | 0.5.x / 0.6.0 (`feat/meeting-detection`) | 1 (local only, opt-in) | desktop |

### Meeting detection and the "not doing" rules

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

## Deliberately NOT doing

| Feature | Why not |
|---|---|
| **Screenshots** (even blurred) | They capture personal data and third parties' data far beyond what time tracking needs. |
| **Keyboard / mouse activity scores visible to managers** | They measure movement, not work, and are the most resented bossware metric. |
| **Sending URLs, window titles or app usage to the server** | That is surveillance of browsing and private life. Meeting detection reads the microphone holder locally and sends nothing. |
| **Recording or analysing audio** | Meeting detection never opens the microphone or reads its level. |
| **GPS, webcam or kiosk photos** | Location and biometric data are high-risk and disproportionate. |
| **Peer rankings or leaderboards** | They reward hours, not results. |

The same reasons apply to all of them: worker trust; the GDPR (art. 5(1)(c) minimisation and proportionality, art. 35
impact assessment for systematic monitoring); the Estatuto de los Trabajadores (art. 20.3 dignity in monitoring, art.
20 bis privacy and digital disconnection); the LOPDGDD (arts. 87–91).

**Rule for any future feature near monitoring**: it must be **opt-in**, **local-first** (nothing leaves the computer
unless the worker confirms it), **transparent to the worker** and **reviewed with a DPIA** before it ships.
