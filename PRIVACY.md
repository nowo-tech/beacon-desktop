# Privacy

TimeTrack records only the time you choose to track. It is built to comply with the GDPR / RGPD and the Spanish
LOPDGDD (arts. 87–91, digital rights at work, including the right to disconnect) and art. 34.9 of the Estatuto de los
Trabajadores (working time record). Your employer, who runs Beacon, is the data controller for the data on the server.

## Sent to your server

- The device name you approve in Beacon (device sign-in).
- The task you start, stop or switch to, an optional note, and the source `desktop`.
- Your answer to "Still there?" (keep, discard, pause, or count on another task, with the start and end of that time),
  and the times you started or stopped a timer (also for actions sent later, after being offline). Never the input
  counter, and never the screen lock or sleep events: when you **reassign** idle time, only the entry you confirm is
  sent (the task you chose, with the start and end of that time), as an ordinary entry the server checks like any
  other.
- The search text you type in the "Reassign" task picker (the same `tasks` search as the main search field).
- The app version, platform, architecture and installer kind (for example `nsis` or `appimage`) when it checks for
  updates. The Microsoft Store build never checks with Beacon: the Store updates it.
- With meeting reminders (TimeTrack 1.14), the request for your own meetings of today and tomorrow (`GET
  me/meetings`: the time window and time zone only). Nothing about your meetings is sent back.
- Nothing else: no screenshots, keystrokes, applications, window titles, URLs, activity or idle state. With meeting
  detection on, which meeting app holds the microphone is checked on this computer and never sent (below).

How it travels: always over HTTPS. For the official Beacon server, the app only accepts certificates from the
certificate authorities whose keys are built into it (TLS public-key pinning): a network that intercepts encrypted
traffic (a TLS-inspecting proxy, antivirus or a rogue certificate) cannot read or change what is sent, and the app
sends nothing and shows "La conexión con Beacon no es de confianza (certificado inesperado)" instead. Other servers
use standard TLS validation (Settings says "Connection not pinned"). Nothing about this check is sent anywhere; a
mismatch is logged locally with the server name only, never a token.

## Stored on this computer

- The session token, in the OS keychain.
- Server URL, your e-mail, the running timer, queued offline actions (with the time each happened), the tasks you pin
  and the last task you tracked (id and title, to resume it), an unsent "meeting" note, the "Still there?" state (the
  question being asked, if any), the server's feature switches, your settings and the date of each consent decision,
  and the friendly-message history (so lines do not repeat and each moment comes once a day): the line numbers shown
  lately, the time of the last one, the current one with the running entry it belongs to, and the moments and cheers
  already used, and for "Working without a timer?" the start of the current stretch of input, whether the counter
  moved during it, the time of the last reminder and the line numbers shown lately (never the counter's values).
  Entries are named by their task id and start time (`<task id>@<start>`). All of it is in the app's local storage. Signing out deletes the token, the timer, the queue, the idle-check state, the friendly-message
  history, the last task, the pinned tasks, the "Working without a timer?" state and the generic meeting task, so the
  next person never sees your task titles (in the app or in a desktop notification) or starts one of your tasks.
- **Clear local data** (Settings → What we collect) signs you out and deletes all of the above, and turns "start at
  login" off.
- "Open Beacon in" (Settings): which browser opens your links, by the id the system gives it, or the path of a browser
  you picked by hand in the file dialog. Read from the system (installed browsers) when Settings opens; kept by the
  app in `browser.json` in its configuration folder on this computer (not in the window's storage) and never sent.
  *Clear local data* resets it to the system default. A copied link goes only to your clipboard, without user info or secret-looking parameters.
- Today / This week totals and recent tasks are computed on this computer from your own entries (`entries:read`, the
  same data Beacon shows you); nothing extra is sent.

## "Still there?" check

- While a timer runs and nobody was asked yet, the app reads the OS "seconds since last input" counter once a second
  (in its background heartbeat, so the question comes on time even with the window closed to the tray), on this
  computer, only to decide when to ask whether you are still there. The counter is never stored, logged or sent.
  Screen lock and sleep count as idle.
- The question opens in its own small window in the middle of the screen, on top of other windows; it holds only what
  the main window shows there and sends nothing itself. It shows the running task's title, so during a screen share
  the people watching can see it too.
- Your organisation turns it on or off and sets the wait (TimeTrackBundle 1.10, `GET me`); you can make the wait
  longer in Settings. With a server that does not say (1.9), it is off until you turn it on (dated consent).
- With no answer, the timer stops at your last input and the app asks you about that time when you are back.

## Screen lock and sleep

- With **Pause on screen lock or sleep** on (Settings, on by default; it works together with the "Still there?"
  check), the app listens to your operating system's own lock and sleep events: Windows session notifications
  (`WTS_SESSION_LOCK` / `UNLOCK`) and power broadcasts, macOS `com.apple.screenIsLocked` / `screenIsUnlocked` and the
  workspace sleep / wake notifications, Linux logind on the system D-Bus (`Lock`, `Unlock`, `LockedHint`,
  `PrepareForSleep`). It only keeps, in memory, the moment the lock or sleep started.
- That time counts as idle. When you are back (unlocked and awake), the app asks what to do with it: **keep** it,
  **discard** it (the timer stops when the lock started) or **reassign** it to another task. A lock shorter than two
  minutes is not asked about; a very long one stops the timer at the start of the lock, as an unanswered "Still
  there?" does. Only your answer is sent.
- The events are never stored, logged or sent, and the app never locks, wakes or watches the screen itself.

## "Working without a timer?"

- With **Remind me when I work without a timer** on (Settings, on by default), during your working hours (Beacon's
  schedule with your changes in My schedule, never on a day off or at lunch) and only while no timer runs, the app
  reads the same OS "seconds since last input" counter at each 30-second check. After the minutes you chose (10 by
  default) of input in a row, it shows a friendly reminder with **Start <last task>** and **Choose task**, at most
  once every 45 minutes, never while the friendly messages are paused. Outside those conditions the counter is not
  read for it.
- The counter is never stored, logged or sent; only the start of the current stretch and the time of the last reminder
  are kept, locally. Nothing reaches the server unless you start a timer.
- As a desktop notification, its title, line, picture and button labels are handed to your operating system like the
  friendly messages.

## "Continue last" shortcut and the tray clock

- The global shortcut (Settings; by default `Ctrl+Alt+T`, `⌘⌥T` on macOS, `Ctrl+Alt+Shift+R` on Linux) is registered with your operating system
  only to know when *you* press it; no other key is read.
- The tray shows the elapsed time of the running timer (macOS menu bar, tooltip everywhere), refreshed by the app's
  background heartbeat from the start time it already has. Nothing is sent for it.

## Friendly messages

- The varied "Still there?" phrasing, the cheers on long stretches and the time-of-day moments (early start, coffee,
  lunch, late work, Friday afternoon, weekend) are chosen on this computer from the running timer's start and the
  clock, in your Beacon language and time zone when the server says (`me.locale`, `me.workingHours.timezone`). Nothing
  about them is sent. Settings → Friendly messages turns them off.
- They appear as **desktop notifications** (Windows Action Center, macOS Notification Center, the Linux notification
  service): the title, the line and the mascot picture are handed to your operating system, which may keep them in
  its notification history on this computer like any other app's. Nothing goes to a server. The pictures are written
  once to the app's cache folder (the OS needs a file). Settings → Friendly messages → *Show them as desktop
  notifications* keeps them inside the app instead; if the OS refuses them, they stay inside the app and Settings says
  so. *Pause for 1 h* (also in the tray menu) silences them for an hour.
- To recognise meetings and dailies, the name, type and labels of the running task (as Beacon sent them) are matched
  against a word list on this computer; nothing extra is stored or sent.

## Working-hours reminders

- Your schedule (start, end, lunch, days off) is read from Beacon (`me.workingHours`, `me.daysOff`) and the reminders
  are worked out on this computer from it, the clock and whether a timer runs. Changes you make in Settings → My
  schedule and the days off you add stay in the app's local storage, with a copy of Beacon's schedule for an offline
  start and which reminders were shown today; none of it is sent. Signing out deletes them.
- As desktop notifications, their title, line, picture and button label are handed to your operating system like the
  friendly messages. Pressing *Start* / *Stop* / *Resume* does what the same button in the app does (`timer/start`,
  `timer/stop`).

## Meeting reminders (TimeTrack 1.14; on by default once a calendar is connected in Beacon)

- **Data source**: Beacon, not your calendar. You connect a calendar in Beacon (Account → Integrations → Calendars,
  covered by Beacon's privacy notice and its DPIA for spec 210); the app never talks to Google or Microsoft. It needs
  the `meetings:read` permission, which you grant explicitly in Beacon (sessions from before 0.6 are asked once).
- **What the app receives**: your own meetings of today and tomorrow, as Beacon's API shapes them: times, title (none
  for a private meeting, shown as "Busy"), the join link of Teams / Meet / Zoom / Jitsi / Webex meetings, the first
  names of attendees who are Beacon users you can already see, the number of other attendees (never their names,
  e-mails or domains) and the tasks linked to the meeting that you can track.
- **Stored on this computer**: that list, for offline reminders, until the end of tomorrow and never more than 48
  hours; and which reminders were shown or snoozed, as a hash of the meeting id and start time with the times only
  (no title, link or id), deleted 24 hours after the meeting. Signing out deletes the list; turning the reminders off
  deletes it too; *Clear local data* deletes both.
- **Never**: logged, sent to anyone else, or used for anything but the reminder, *Today's meetings* and the tray.
- **Sent to Beacon**: nothing about your meetings; only the timer action you choose (*Pause* = `timer/stop`, *Track
  the meeting* = `timer/switch` with `origin: meeting`). *Join* opens the link in your browser after checking it is
  one of those video-call services.
- **Opt-out**: Settings → Meeting reminders → *Remind me before my meetings* (per device), or disconnect the calendar
  in Beacon.

## Meeting detection (off by default, dated consent)

- **What is read, and only while you have it on** (Settings → Meetings): every 20 seconds, on this computer, whether
  the microphone is in use and which app holds it — on Windows the per-user microphone "recent activity" store
  (`CapabilityAccessManager\ConsentStore\microphone`, the same list Windows shows in its privacy settings), on macOS
  CoreAudio (is the default input running, and which audio processes record), on Linux the sound server's recording
  streams (`pactl` / `pw-dump`, the `application.process.binary` of each). The app's identity is reduced at once to a
  fixed name (Teams, Zoom, Webex, Slack, Discord, Skype, GoTo, Jitsi Meet, or "browser"); any other app and every path
  are dropped there and then.
- **Never read**: window titles, web addresses (a Google Meet tab is only "a browser call"), chats, participants,
  calendar entries, audio or its level. The microphone is never opened by the app.
- **Stored on this computer**: the call in progress (app name, start, when the microphone was released, when the last
  question was asked), the task you chose for it and the one running before (id and title, to offer "Back to …"), your
  generic meeting task and the apps you said not to ask about. Signing out deletes the call and the generic meeting
  task; turning the feature off deletes the call too.
- **Sent**: nothing about the call. Only what you choose in the question reaches Beacon, as any other timer action
  (`timer/start`, `timer/switch`, `timer/stop`).
- The questions are desktop notifications like the friendly messages (title, line, pose and one button handed to your
  OS) and a card in the window. They follow the 1 h pause, never come while "Still there?" is open, at most every 10
  minutes, and, with no timer running, only within your working day and not on days off.
- Why this stays within the rules of `docs/ROADMAP.md` ("Deliberately NOT doing"): it is opt-in, local-first and
  transparent (Settings shows what the last check found), it reads the minimum needed to ask one question (GDPR art.
  5(1)(c), data minimisation), it is no monitoring tool for the employer (Estatuto de los Trabajadores art. 20.3:
  nothing reaches the employer unless you record it yourself) and it respects privacy in the use of digital devices at
  work (LOPDGDD art. 87).

## Optional features (off by default, dated consent, revocable in Settings)

- **Notifications**: never shown outside the working hours your organisation publishes (`me.workingHours`).
- **Start at login**: starts the app hidden in the tray; it never starts a timer. On Windows the app keeps this to one
  entry for itself (it removes start-at-login entries of older TimeTrack copies; it reads no other app's entry beyond
  its executable name and changes none), locally, nothing is sent.

## Your rights

Ask your employer (the controller) to access, rectify or erase your data. You can see and export your own entries in
Beacon (own data export, RGPD arts. 15 and 20).
