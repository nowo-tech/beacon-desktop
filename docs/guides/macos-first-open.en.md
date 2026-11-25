# Opening TimeTrack on a Mac for the first time

> **Beacon Desktop** is the new name of TimeTrack (0.9.0). On disk the app keeps its old name, so the download is
> still `TimeTrack_<version>_universal.dmg`, the app is `TimeTrack.app` in Applications and macOS dialogs say
> "TimeTrack": the steps below are unchanged.

TimeTrack for macOS is **not notarized by Apple**. Notarization needs a paid Apple Developer Program membership, and
TimeTrack is distributed at zero cost. macOS therefore asks you to confirm **once** that you trust the app. After that,
TimeTrack opens like any other app.

Only do this for a copy you downloaded from **your own Beacon** (Tasks → Time → Apps). To check the download, compare
its SHA-256 with the one shown on that page:

```sh
shasum -a 256 ~/Downloads/TimeTrack_*_universal.dmg
```

The dialog texts below are Apple's wording at the time of writing. They can differ slightly between macOS versions.

## macOS Sequoia (15) and later

On Sequoia, **Control-click (right-click) → Open no longer skips this check**. You have to use System Settings.

1. **Install.** Open the downloaded `TimeTrack_<version>_universal.dmg` and drag **TimeTrack** onto **Applications**.

   > **[Screenshot M1 — `docs/guides/images/macos-1-dmg.en.png`]** The Finder window of the opened disk image in light
   > mode: the TimeTrack icon (the mascot head on the moss square) on the left, an arrow, and the Applications folder
   > alias on the right. Crop to the disk image window.

2. **Try to open it once.** In **Applications**, double-click **TimeTrack**. macOS shows **"TimeTrack" Not Opened**:
   *"Apple could not verify "TimeTrack" is free of malware that may harm your Mac or compromise your privacy."* Click
   **Done**. Do **not** click *Move to Trash*.

   > **[Screenshot M2 — `docs/guides/images/macos-2-not-opened.en.png`]** The "TimeTrack" Not Opened dialog with its
   > two buttons, **Done** and **Move to Trash**. Highlight **Done**. Crop to the dialog.

3. **Allow it in System Settings.** Open the **Apple menu → System Settings → Privacy & Security**. Scroll down to
   **Security**. You'll see *"TimeTrack" was blocked to protect your Mac.* Click **Open Anyway**. The button appears only
   after step 2, and only for a while (about an hour). If it isn't there, repeat step 2.

   > **[Screenshot M3 — `docs/guides/images/macos-3-open-anyway.en.png`]** System Settings → Privacy & Security,
   > scrolled to the **Security** section: the line *"TimeTrack" was blocked to protect your Mac.* and the
   > **Open Anyway** button. Highlight the button. Window width about 800 px; crop to the right-hand pane.

4. **Confirm with your password.** Enter your Mac login password, or use Touch ID.

   > **[Screenshot M4 — `docs/guides/images/macos-4-password.en.png`]** The authentication prompt ("System Settings is
   > trying to …" or "Privacy & Security"), with the password field empty. Crop to the prompt.

5. **Open.** A last dialog asks whether to open TimeTrack. Click **Open Anyway** (on some versions the button is
   **Open**). TimeTrack starts, and its icon appears in the menu bar.

   > **[Screenshot M5 — `docs/guides/images/macos-5-confirm.en.png`]** The final confirmation dialog with the
   > **Open Anyway** (or **Open**) button highlighted. Crop to the dialog.

## macOS Sonoma (14) and earlier

Either of these works:

- **System Settings**, as on Sequoia: try to open TimeTrack once, then go to **System Settings → Privacy & Security →
  Open Anyway**, and confirm.
- **Control-click**: in **Applications**, Control-click (or right-click) **TimeTrack** → **Open**, then click **Open**
  in the dialog.

  > **[Screenshot M6 — `docs/guides/images/macos-6-sonoma-control-click.en.png`]** Sonoma Finder, Applications folder,
  > with the context menu open on TimeTrack and **Open** highlighted. Then the dialog that offers **Open** and
  > **Cancel**. Two images side by side, or two files (`…-6a…`, `…-6b…`).

## After the first time

- macOS remembers your choice. You only do this once per Mac.
- **Updates installed from inside TimeTrack don't ask again.** When TimeTrack shows *"Version X is available"* and you
  choose **Update now**, it downloads the update, checks its signature, replaces itself and restarts, with no macOS
  prompt. This is expected from how macOS treats files that weren't downloaded by a browser, but it has not been
  verified on a real Mac yet (see the 0.4.0 release plan).
- If you install a new version by hand from a downloaded `.dmg` instead, macOS may ask again. Repeat the steps above.

## If macOS says "TimeTrack is damaged and can't be opened"

This message means the downloaded copy has no valid signature at all. TimeTrack 0.4.0 and later are ad-hoc signed
to avoid it. If you still see it, and you are sure the file came from your Beacon and its SHA-256 matches, run this
in Terminal. It removes the download flag from that one app only:

```sh
xattr -dr com.apple.quarantine /Applications/TimeTrack.app
```

Never turn off Gatekeeper for the whole Mac.

## Sources

- Apple Support, *Safely open apps on your Mac* — https://support.apple.com/en-us/102445
- Apple Support, *Open a Mac app from an unknown developer* — https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac
- Macworld, *What to do when you can't open an app you just installed in macOS Sequoia* (Control-click change) —
  https://www.macworld.com/article/2457844/what-to-do-when-you-cant-open-an-app-you-just-installed-in-macos-sequoia.html
