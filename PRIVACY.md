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
- The app version, platform and architecture when it checks for updates.
- Nothing else: no screenshots, keystrokes, applications, window titles, URLs, activity or idle state.

## Stored on this computer

- The session token, in the OS keychain.
- Server URL, your e-mail, the running timer, queued offline actions (with the time each happened), the tasks you pin
  and the last task you tracked (id and title, to resume it), an unsent "meeting" note, the "Still there?" state (the
  question being asked, if any), the server's feature switches, your settings and the date of each consent decision,
  in the app's local storage. Signing out deletes the token, the timer, the queue and the idle-check state.
- **Clear local data** (Settings → What we collect) signs you out and deletes all of the above, and turns "start at
  login" off.
- Today / This week totals and recent tasks are computed on this computer from your own entries (`entries:read`, the
  same data Beacon shows you); nothing extra is sent.

## "Still there?" check

- While a timer runs, the app reads the OS "seconds since last input" counter every 30 seconds, on this computer, only
  to decide when to ask whether you are still there. The counter is never stored, logged or sent. Screen lock and sleep
  count as idle.
- Your organisation turns it on or off and sets the wait (TimeTrackBundle 1.10, `GET me`); you can make the wait
  longer in Settings. With a server that does not say (1.9), it is off until you turn it on (dated consent).
- With no answer, the timer stops at your last input and the app asks you about that time when you are back.

## Optional features (off by default, dated consent, revocable in Settings)

- **Notifications**: never shown outside the working hours your organisation publishes (`me.workingHours`).
- **Start at login**: starts the app hidden in the tray; it never starts a timer.

## Your rights

Ask your employer (the controller) to access, rectify or erase your data. You can see and export your own entries in
Beacon (own data export, RGPD arts. 15 and 20).
