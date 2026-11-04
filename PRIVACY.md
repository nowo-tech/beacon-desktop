# Privacy

TimeTrack records only the time you choose to track. It is built to comply with the GDPR / RGPD and the Spanish
LOPDGDD (arts. 87–91, digital rights at work, including the right to disconnect) and art. 34.9 of the Estatuto de los
Trabajadores (working time record). Your employer, who runs Beacon, is the data controller for the data on the server.

## Sent to your server

- The device name you approve in Beacon (device sign-in).
- The task you start, stop or switch to, an optional note, and the source `desktop`.
- If you enabled idle detection: only your answer about an away period (keep / discard / split, with its start and end).
- The app version, platform and architecture when it checks for updates.
- Nothing else: no screenshots, keystrokes, applications, window titles, URLs, activity or idle state.

## Stored on this computer

- The session token, in the OS keychain.
- Server URL, your e-mail, the running timer, queued offline actions, the tasks you pin and the last task you tracked
  (id and title, to resume it), your settings and the date of each consent decision, in the app's local storage.
  Signing out deletes the token, the timer and the queue.
- Today / This week totals and recent tasks are computed on this computer from your own entries (`entries:read`, the
  same data Beacon shows you); nothing extra is sent.

## Optional features (off by default, dated consent, revocable in Settings)

- **Idle detection**: reads the OS "seconds since last input" counter locally while a timer runs; when you come back it
  asks you what to do with the away time. The counter is never sent.
- **Notifications**: never shown outside the working hours your organisation publishes (`me.workingHours`).
- **Start at login**: starts the app hidden in the tray; it never starts a timer.

## Your rights

Ask your employer (the controller) to access, rectify or erase your data. You can see and export your own entries in
Beacon (own data export, RGPD arts. 15 and 20).
