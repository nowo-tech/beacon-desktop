# Privacy

TimeTrack records only the time you choose to track. It is built to comply with the GDPR / RGPD and the Spanish
LOPDGDD (arts. 87–91, digital rights at work, including the right to disconnect) and art. 34.9 of the Estatuto de los
Trabajadores (working time record). Your employer, who runs Beacon, is the data controller for the data on the server.

## Sent to your server

- The device name you approve in Beacon (device sign-in).
- The task you start, stop or switch to, an optional note, and the source `desktop`.
- Your answer to "Still there?" (keep, discard, pause, or count on another task, with the start and end of that time),
  and the times you started or stopped a timer (also for actions sent later, after being offline). Never the input
  counter.
- The app version, platform, architecture and installer kind (for example `nsis` or `appimage`) when it checks for
  updates. The Microsoft Store build never checks with Beacon: the Store updates it.
- Nothing else: no screenshots, keystrokes, applications, window titles, URLs, activity or idle state.

## Stored on this computer

- The session token, in the OS keychain.
- Server URL, your e-mail, the running timer, queued offline actions (with the time each happened), the tasks you pin
  and the last task you tracked (id and title, to resume it), an unsent "meeting" note, the "Still there?" state (the
  question being asked, if any), the server's feature switches, your settings and the date of each consent decision,
  and the friendly-message history (so lines do not repeat and each moment comes once a day): the line numbers shown
  lately, the time of the last one, the current one with the running entry it belongs to, and the moments and cheers
  already used. Entries are named by their task id and start time (`<task id>@<start>`). All of it is in the app's
  local storage. Signing out deletes the token, the timer, the queue, the idle-check state and the friendly-message
  history.
- **Clear local data** (Settings → What we collect) signs you out and deletes all of the above, and turns "start at
  login" off.
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

## Optional features (off by default, dated consent, revocable in Settings)

- **Notifications**: never shown outside the working hours your organisation publishes (`me.workingHours`).
- **Start at login**: starts the app hidden in the tray; it never starts a timer.

## Your rights

Ask your employer (the controller) to access, rectify or erase your data. You can see and export your own entries in
Beacon (own data export, RGPD arts. 15 and 20).
