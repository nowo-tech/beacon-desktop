# TimeTrack Desktop 0.4.0 — release plan: signed auto-update, Microsoft Store, unsigned macOS

Owner request (via Beacon, 2026-11-04): zero-cost signing and auto-update.

| Platform | Distribution | Code signing | Updates |
| --- | --- | --- | --- |
| Windows | **Microsoft Store** (MSIX, free individual account) | Store re-signs the MSIX (free) | Microsoft Store |
| Windows | **Direct download from Beacon** (NSIS `-setup.exe`, per-user) | none (SmartScreen: *More info → Run anyway*) | in-app, Tauri updater, minisign-signed |
| macOS | Direct download from Beacon (universal `.dmg`) | none, ad-hoc only (Gatekeeper: [first-open guide](guides/macos-first-open.en.md)) | in-app, `.app.tar.gz`, minisign-signed |
| Linux | Direct download from Beacon (`.deb`, `.AppImage`) | unchanged | AppImage in-app as before; `.deb` → Beacon download |

Two kinds of signature are involved, and only one of them costs nothing everywhere:

- **Updater signatures** (minisign, `tauri signer`): free, and required. Every updater file is signed with the owner's
  private key. The app carries the public key and refuses anything else. It also refuses a signature whose signed
  version differs from the one Beacon announces (`requireSignedVersion: true`).
- **OS code signing** (Authenticode, Apple Developer ID): paid. It is skipped, except on the Microsoft Store, where
  Microsoft signs the MSIX for free.

## 1. What is in this PR

### Auto-update (direct-download builds)

- `tauri.conf.json`: `bundle.createUpdaterArtifacts: true`, so `.sig` files are produced for the AppImage, the NSIS
  `-setup.exe` and the macOS `.app.tar.gz`. `plugins.updater.pubkey` holds the committed placeholder
  `REPLACE_WITH_TIMETRACK_UPDATER_PUBLIC_KEY`, and `plugins.updater.windows.installMode` is `passive` (a small progress
  window, no questions).
- **Public key wiring.** `src-tauri/src/lib.rs` `updater_pubkey()` reads `TAURI_UPDATER_PUBKEY` at compile time
  (`option_env!`, `build.rs` reruns when it changes). Otherwise it reads `plugins.updater.pubkey`, and passes the key
  explicitly to the updater (`UpdaterBuilder::pubkey`). The placeholder, an empty value or non-base64 counts as "no
  key". The app then never blocks: it offers the Beacon download.
- **Release gate.** `scripts/release/check-updater-key.mjs`, also available as `pnpm release:check`, runs as the first
  step of `beforeBuildCommand` on every `tauri build`, and in the release workflow. A direct-download build fails while
  the placeholder is still there and `TAURI_UPDATER_PUBKEY` is not set, or when the key does not decode to a minisign
  public key. These builds pass with a warning: debug builds (`TAURI_ENV_DEBUG=true`) and explicit test builds
  (`TIMETRACK_ALLOW_UNSIGNED=1` with `--config src-tauri/tauri.unsigned.conf.json`). The Store build passes, because it
  needs no key.
- **Endpoint.** Beacon's `time_track_client_updater`:
  `{server}/api/time-track/updates/desktop/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}`. The
  endpoint is built at run time from the server the person signed in to (https, or loopback for development). The
  person's client token goes in a custom `Authorization: Bearer` header (`UpdaterBuilder::header`). It is removed for
  the artifact download when the pre-signed URL is on another origin (unchanged from 0.3.0).
- **Behaviour.**
  - The app checks at start-up, every 6 hours, and from **Check for updates…** in the tray or **Check for updates** in
    Settings → About. A manual check also reports "up to date" or "could not check".
  - The **update card** is calm and non-blocking. It shows the small mascot and the same moss / mist card as "Still
    there?", with no alert colours: *"Version X is available"*, **What's new** (the response's `notes`, plain text,
    `aria-expanded`), **Update now** and **Later**. *Later* hides that version until a manual check or the next launch.
  - **Download with progress.** A native `<progress>` reports per-percent `update-progress` events from Rust. Tauri
    verifies the signature, then the app installs and relaunches. A failure, such as a bad signature or a network
    error, becomes the existing non-blocking message with **Download from Beacon**.
  - **A running timer is never interrupted without asking.** *Update now* while a timer runs asks first: *"A timer is
    running on X. Updating restarts TimeTrack; the timer keeps running in Beacon."* The choices are **After I stop**,
    **Update now** and **Cancel**. *After I stop* installs as soon as the timer is stopped, whether from the app, the
    tray, another device (next refresh) or the idle check.
  - **Forced update.** `min_supported_version` from the updater (body or `X-Min-Supported-Version`) and, new in 0.4.0,
    `minSupportedVersion` from **GET me** both count. The strictest one wins. Below it, the existing "Update required"
    screen appears (`role=alertdialog`), now with the mascot. With a timer running it adds the note and **Stop the
    timer, then update**. It never traps: *Remind me later*, *Download from Beacon* and *Sign out* stay. A minimum that
    no offered update satisfies shows a message, not the screen (audit CN D1, unchanged).
  - **Copes with installs it cannot update.** An MSI or deb copy (`bundle_type`) reports `installable: false` and gets
    the Beacon download message, never a wrong package.
  - All new text is in English and Spanish. Announcements go through the persistent polite live region, and focus
    moves only when the person acts (to *After I stop* or back to *Update now*). axe WCAG 2.1 A/AA checks run in e2e,
    light and dark.
- **Windows installers**:
  - **NSIS only**, `installMode: currentUser`: installed per user under `%LOCALAPPDATA%`, with no UAC prompt for the
    install or for updates.
  - **MSI is no longer built.** An MSI install is per-machine, and the NSIS updater would add a second per-user copy
    next to it. MSI is only worth keeping for managed deployments (GPO / Intune), which nobody has asked for. If that
    comes up: add `msi` back to the targets, and have Beacon answer `bundle_type=msi` with an `.msi` updater entry
    (`TimeTrack_<v>_x64_en-US.msi` + `.sig`, which Tauri also produces).
  - People who installed 0.1–0.3 from the MSI get *"Automatic updates are not available for this installation"*. They
    should uninstall it (Settings → Apps) and install the new `-setup.exe` once.
- **macOS**:
  - Updates come as the universal `.app.tar.gz` + `.sig`, listed under both `aarch64` and `x86_64` (unchanged
    `collect-desktop.sh`).
  - `bundle.macOS.signingIdentity: "-"` **ad-hoc signs** the bundle. It costs nothing, and it turns Apple Silicon's
    *"damaged"* error into the normal *"cannot verify"* prompt that the [first-open guide](guides/macos-first-open.en.md)
    covers.
  - **Not verifiable here:** that an in-app update shows no Gatekeeper prompt after the first approval. The updater
    downloads with its own HTTP client, so no quarantine flag is set, and replaces the `.app` in place. That is the
    expected result, but no Mac was available. Check it on the first real update (QA list, §6).

### Microsoft Store (MSIX)

- **Path chosen: MSIX, re-signed by the Store (zero cost).** Rejected: submitting the unpackaged NSIS / MSI by URL. For
  that path, Microsoft requires *"The binary and all of its Portable Executable (PE) files must be digitally signed
  with a code signing certificate that chains up to a certificate issued by a Certificate Authority (CA) that is part
  of the Microsoft Trusted Root Program"*, which means a paid certificate. Tauri's own Store page documents only that
  path (*"Currently Tauri only generates EXE and MSI installers"*, which *"must be offline, handle auto-updates and be
  code signed"*). For MSIX, Microsoft says: *"Your MSIX and AppX packages don't have to be signed with a certificate
  rooted in a trusted certificate authority when submitting to the Microsoft Store. The Microsoft Store will
  automatically re-sign your MSIX/AppX packages with a Microsoft certificate"*. Individual developer accounts have been
  free since 2025.
- **Store channel.** `TIMETRACK_CHANNEL=store` is read at build time by Vite (`__CHANNEL__`) and by Rust
  (`option_env!`). In that channel:
  - the updater plugin is not registered, and `check_update` / `install_update` refuse to run;
  - there is no tray **Check for updates…** item and no autostart switch (an MSIX app cannot use the Run key the
    autostart plugin writes);
  - About says *"Updates come from the Microsoft Store"* and offers **Open Microsoft Store**;
  - a forced update (GET me `minSupportedVersion`) sends the person to the Store listing (`TIMETRACK_STORE_URL`, else
    Beacon's Apps page).
- `src-tauri/tauri.store.conf.json` (merge patch) turns the updater artifacts off and removes `plugins.updater`.
- `scripts/store/msix-manifest.mjs` generates `AppxManifest.xml`:
  - the Partner Center identity comes from `MSIX_IDENTITY_NAME`, `MSIX_PUBLISHER` and `MSIX_PUBLISHER_DISPLAY_NAME`;
  - it is a full-trust desktop app (`runFullTrust`), Windows 10 1809 or later, in en-us and es-es;
  - the version is `MAJOR+1.MINOR.PATCH.0`. The Store needs a first part of at least 1 and a fourth part of 0, so
    0.4.0 becomes **1.4.0.0**. Users never see it.
- `scripts/store/build-msix.ps1` runs on Windows with the free Windows SDK:
  1. builds the Store binary (`tauri build --no-bundle`);
  2. stages `TimeTrack.exe`, the Store logos (`tauri icon`) and the manifest;
  3. packs `out/store/TimeTrack_<v>_x64.msix` with `MakeAppx pack`.
- `release.yml` has an optional `store-msix` job, which runs when the `MSIX_*` repository variables are set.
  (GitHub Actions is blocked by billing for now, so the owner runs the script locally.)

## 2. Release plan

1. **Merge this PR** (owner, after review). CI cannot run: billing. The local gates below are the evidence.
2. **Owner steps A and B** (§4): generate the key, commit the public key, and set the signing secrets.
3. **Beacon changes** (§3), shipped before or together with the 0.4.0 channel.
4. **Build and publish 0.4.0, direct download**:
   - Either the tag `v0.4.0` runs `release.yml`, once Actions is available, which builds, signs, collects and uploads
     to `time-track-clients/desktop/0.4.0/` and then `channel/stable.json` last;
   - or, while Actions is blocked, the owner builds on each OS with the secrets in the environment (§4 B, local builds)
     and uploads with `scripts/release/collect-desktop.sh` + `channel.mjs stable` + `s3-put.sh`, in the same order.
5. **First signed release caveat.** 0.3.0 and older builds carry whatever public key they were built with: the
   repository variable `TAURI_UPDATER_PUBKEY`, if one was set when they were built, or none.
   - **With no key, or a different key** (a new key pair): those copies cannot auto-update to 0.4.0. They show
     *"Automatic updates are not available…"* plus **Download from Beacon**, or a failed-verification message. People
     install 0.4.0 by hand **once**. Every later version updates in-app.
   - **If the owner still has the private key that matches the existing `TAURI_UPDATER_PUBKEY` variable**, reuse that
     key pair (§4 A, "Already have a key"). The copies built with it then auto-update to 0.4.0.
6. **Microsoft Store**: owner step C (§4), then build the MSIX (§4 D) and submit it. Certification usually takes up to
   3 business days. Then Beacon adds the Store link (§3, item 4).
7. **QA on real machines** (§6) before raising `min_supported_version` to 0.4.0.
8. **Raise `min_supported_version`** only after the Store has published 0.4.0. Store users can only update once
   Microsoft has certified the version, so a minimum raised too early sends them to a listing that does not have it
   yet. They still have *Remind me later*.

## 3. What Beacon must change (symfony-beacon, read-only review of `e82fefc5`)

Read:
- `src/TimeTrack/Controller/TimeTrackClientUpdaterController.php`
- `src/TimeTrack/Distribution/{StableChannel,ClientRelease,ClientReleases,ClientAppsPage,ChannelMinSupportedVersion}.php`
- `specs/190-time-track-integrations/spec.md` FR-013
- `docs/dev-notes/tasks.md` (Updater)
- `src/Setup/Demo/fixtures/time-track-sample-release.json`

**Response vs. the Tauri v2 updater format.** Beacon uses Tauri's *dynamic server* shape: **204** when there is no
update, otherwise `{version, notes, pub_date, url, signature, min_supported_version?}` with nulls filtered out. Tauri
requires `version`, `url` and `signature`; `notes` and `pub_date` (RFC 3339) are optional; extra keys are ignored. The
static `platforms.{target-arch}` shape is not needed, because the route already carries `{target}/{arch}`.
**`signature` is not missing:** the controller returns `ClientReleaseFile::signature`, and `StableChannel` refuses any
`kind=updater` entry without one (base64, ≤ 4096 characters, which matches a Tauri `.sig`). No field has to be added for
the update to install. The changes are:

| # | Where | Change | Why |
| --- | --- | --- | --- |
| 1 | Updater route | **Accept the new query `?bundle_type=`** (`nsis`, `msi`, `appimage`, `deb`, `rpm`, `app`, `unknown`). Answer **204** for `msi`, `deb` and `rpm` until the channel has a matching updater entry. Keep serving `nsis`, `appimage`, `app` and a missing value as today. Unknown values → treat as missing (never 400). | The app sends it from 0.4.0. Today Beacon ignores it, which works, because the app already refuses to self-install on MSI / deb copies. Answering 204 saves the download and keeps the logic on the server. |
| 2 | `stable.json` (client release CI) | **Windows: only the NSIS `-setup.exe`** as `installer` + `updater`. From 0.4.0 there is no `.msi` (`collect-desktop.sh` already skips a missing one). Each `updater` entry's `signature` must be the **exact content of the `.sig` produced by Tauri CLI 2.x** for that file. The trusted comment includes `version:<v>`, which `requireSignedVersion` checks against `version`. | A `.sig` from another build, or a `version` that differs from the signed one, fails verification. The app then shows the Beacon download. |
| 3 | `notes` | Optional: plain text or simple Markdown (the app shows it as plain text with line breaks, never as HTML). Optional later: localised notes (`notes` per `Accept-Language`, or `notes_es`); the app does not send `Accept-Language` yet. | The card shows the notes as is. |
| 4 | Apps page (`ClientAppsPage`, `apps.html.twig`) | Add a **Microsoft Store** link on the Windows card: *"Get it from Microsoft Store"* → `https://apps.microsoft.com/detail/<Store ID>`, from a new InstanceSettings field (e.g. `time_track.windows_store_url`) or a constant next to `CHROME_WEB_STORE_ID`. Keep the direct `-setup.exe` download next to it. | Owner decision: Windows ships through both. |
| 5 | Apps page, unsigned-installer steps | Windows: *"Windows protected your PC" → More info → Run anyway* (direct download only; the Store needs none). macOS: link to this repository's [`docs/guides/macos-first-open.en.md`](guides/macos-first-open.en.md) / [`.es.md`](guides/macos-first-open.es.md), or copy their text. The Sequoia steps go through System Settings → Privacy & Security → **Open Anyway**; Control-click no longer works there. Add a note for MSI users: *uninstall the old MSI version, then install the setup.exe once*. | First-open friction is the only cost of skipping paid signing. |
| 6 | `min_supported_version` (desktop channel → GET me + header) | Process only: raise it **after** the Store has published that version (§2, step 8). Optional later: let the provider tell Store installs apart (client name `TimeTrack desktop (…)` / a future `channel` hint). | Store users depend on Microsoft's certification delay. |
| 7 | Sample release fixture | Add `windows/x86_64/updater` (`…-setup.exe`) and `darwin/{aarch64,x86_64}/updater` (`…universal.app.tar.gz`) entries with signatures, and drop the `.msi`, so e2e covers the 0.4.0 shape. | The fixture only has a Linux updater today. |

Nothing else changes: the route, the auth (client Bearer token; 401 → the app asks to sign in again), the 10-minute
pre-signed URL on the bucket host (the app strips the token for other origins), `X-Min-Supported-Version` and
`Cache-Control: no-store, private` all stay.

## 4. Owner's manual steps

> The updater **private key never leaves the owner's machine and the build secrets**. Nobody else — no agent, no
> Beacon instance, no repository file — generates, holds or prints it. Only the **public** key goes into the repo.

### A. Generate the updater key pair (once, on your own machine)

```sh
cd time-track-desktop            # any checkout with pnpm install done
pnpm tauri signer generate -w ~/.tauri/timetrack.key
```

- Choose a strong password when asked. Store **the password and the file `~/.tauri/timetrack.key`** in your password
  manager, and keep an offline backup. If the private key is lost, installed apps can no longer be updated
  automatically: everyone has to reinstall by hand once, with a new key.
- `~/.tauri/timetrack.key.pub` is the **public** key. It is safe to share.
- **Already have a key?** If the `TAURI_SIGNING_PRIVATE_KEY` secret set for 0.1.0 is a key you still hold, with its
  password, and the repository variable `TAURI_UPDATER_PUBKEY` is its public key, skip generating. Use that key pair:
  `TAURI_UPDATER_PUBKEY`'s value is the content of its `.pub`. Copies built with that key then auto-update to 0.4.0.

### B. Put the public key in the repo and the private key where builds run

1. Replace the placeholder with your public key, in one line:

   ```sh
   node -e 'const f="src-tauri/tauri.conf.json",fs=require("fs"),c=fs.readFileSync(f,"utf8");fs.writeFileSync(f,c.replace("REPLACE_WITH_TIMETRACK_UPDATER_PUBLIC_KEY",fs.readFileSync(process.env.HOME+"/.tauri/timetrack.key.pub","utf8").trim()))'
   pnpm release:check        # → "updater key: updater public key <ID> (from tauri.conf.json …)"
   git commit -am "chore: updater public key" && git push
   ```

   Or skip the commit and set it as the repository variable `TAURI_UPDATER_PUBKEY` (Settings → Secrets and variables →
   Actions → Variables). The build reads that variable too, but the committed key is clearer.
2. GitHub secrets (repository → Settings → Secrets and variables → Actions → **Secrets**), or from your terminal:

   ```sh
   gh secret set TAURI_SIGNING_PRIVATE_KEY -R nowo-tech/time-track-desktop < ~/.tauri/timetrack.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R nowo-tech/time-track-desktop   # paste the password when asked
   ```

3. **Local builds** (while Actions is blocked), in the shell of the machine that builds. Nothing is written to disk:

   ```sh
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/timetrack.key)"
   read -rs TAURI_SIGNING_PRIVATE_KEY_PASSWORD && export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   pnpm tauri build                                  # Linux: deb + AppImage (+ .sig)
   # Windows (PowerShell): $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $HOME\.tauri\timetrack.key ; pnpm tauri build --bundles nsis
   # macOS: pnpm tauri build --target universal-apple-darwin --bundles app,dmg
   ```

   A build without the key or with the placeholder fails on purpose. For a throwaway test build without updates, use
   `TIMETRACK_ALLOW_UNSIGNED=1 pnpm tauri build --config src-tauri/tauri.unsigned.conf.json`.

### C. Microsoft Store — Partner Center (once)

1. **Account (free, individual).** Go to <https://storedeveloper.microsoft.com> → *Get started* → **Individual**, and
   sign in with a personal Microsoft account. Identity check: an ID document and a selfie. No fee and no credit card
   (company accounts still pay a one-time fee).
2. **Reserve the name.** Partner Center → **Apps and games** → **New product** → **MSIX or PWA app** → name **TimeTrack
   for Beacon**. Fallbacks if it is taken: *TimeTrack para Beacon*, *Beacon TimeTrack*. A reservation lasts 3 months
   without a submission.
3. **Identity values.** Product → **Product management → Product identity**. Copy:
   - `Package/Identity/Name` → `MSIX_IDENTITY_NAME`
   - `Package/Identity/Publisher` (`CN=…`) → `MSIX_PUBLISHER`
   - `Package/Properties/PublisherDisplayName` → `MSIX_PUBLISHER_DISPLAY_NAME`
   - the **Store ID** → `TIMETRACK_STORE_URL=https://apps.microsoft.com/detail/<Store ID>`

   These values are not secret. Set them as repository **variables** for the optional CI job, and give the Store URL
   to Beacon (§3, item 4).
4. **First submission** → *Start your submission*:
   - **Pricing and availability:** Free; all markets, or the ones you serve. Visibility *Public*. Because the app is
     useless without a Beacon account, consider *Make this product available but not discoverable in the Store*: only
     the direct link from Beacon's Apps page works.
   - **Properties:** category *Productivity*. **Privacy policy URL:** Beacon's public privacy page,
     `<your Beacon URL>/legal/privacy` (localised `/en/legal/privacy`, `/es/legal/privacy`; route `legal_privacy`).
     Website and support contact: your Beacon URL or support e-mail. System requirements: keyboard and mouse
     recommended.
   - **Age ratings:** fill in the IARC questionnaire as *app, not a game*. Truthful answers for TimeTrack: no violence,
     no sexual content, no gambling, no purchases. Users do not chat or share content with each other. The app sends
     the work time the person chooses to track to their own organisation's server, so answer *yes* if asked whether
     personal information is shared, and say with whom. Expected result: the lowest age band (3+ / Everyone).
   - **Packages:** upload `out/store/TimeTrack_<version>_x64.msix` (§4 D). Device family: Desktop only.
   - **Submission options → restricted capabilities:** justify `runFullTrust`. Suggested text: *"TimeTrack is a desktop
     tray application (Tauri / WebView2) packaged with the Desktop Bridge. It needs full trust to show a system-tray
     icon, register a user-chosen global keyboard shortcut and store the sign-in token in Windows Credential Manager."*
   - **Store listings:** English (en-us) and Spanish (es-es), matching the manifest languages.
     - Description: reuse the README intro and *What we collect*.
     - Screenshots: at least 1, PNG, **1366×768 or larger**. Composed 1366×768 images built from the 0.3.0 captures
       and the 0.4.0 update card are in `repositories/.uic-work/timetrack-0.4.0/store-screenshots/` (timer, update card,
       "Still there?", privacy, settings; light and dark side by side). They come from
       `.uic-work/timetrack-0.3.0/screenshots/after/`. Upload them to each language listing.
     - App tile icon 300×300: `scripts/icons/app-icon-1024.png` scaled down.
   - Submit. Certification usually takes up to 3 business days.

### D. Every version on the Store

1. On Windows, with the Windows SDK installed and the `MSIX_*` (+ `TIMETRACK_STORE_URL`) variables set:
   `pwsh scripts/store/build-msix.ps1`. This writes `out/store/TimeTrack_<v>_x64.msix`, with package version
   `MAJOR+1.MINOR.PATCH.0`.
2. Optional local test: Settings → System → For developers → **Developer Mode** on, then
   `Add-AppxPackage -Register out\store\stage\AppxManifest.xml`. Check that sign-in, the tray, the shortcut and
   notifications work, and that About says *"Updates come from the Microsoft Store"*. Then
   `Get-AppxPackage *TimeTrack* | Remove-AppxPackage`.
3. Partner Center → TimeTrack for Beacon → **Update** (new submission) → **Packages**: remove the old package and
   upload the new `.msix` → **Store listings**: *What's new in this version* (from CHANGELOG, en + es) → **Submit**.
   The package version must be higher than the published one (the mapping guarantees it).

## 5. Gates (local; GitHub Actions blocked by billing)

See the PR description for the exact results of this commit. They cover:
- `pnpm lint`, `pnpm typecheck`, and `pnpm test:coverage` (thresholds 90 / 85);
- `playwright test` (full e2e, including `tests/e2e/updates.spec.ts` with axe, light and dark);
- Rust `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and `cargo test`, for both the direct and the
  `TIMETRACK_CHANNEL=store` build, in a `rust:1-bookworm` container.

## 6. QA on real machines (not possible here)

- [ ] Windows 11, direct NSIS install: no UAC prompt; SmartScreen *More info → Run anyway*; update 0.4.0 → 0.4.1
      in-app (passive progress window, relaunch, still signed in).
- [ ] Windows, old MSI copy: *"Automatic updates are not available for this installation"* → uninstall + `-setup.exe`.
- [ ] Windows, MSIX from the Store (or `Add-AppxPackage -Register`): tray, global shortcut, Credential Manager token,
      notifications (toasts in a packaged app), no update UI, About → *Open Microsoft Store*.
- [ ] macOS Sequoia: first open per the guide (record the exact dialog texts and capture screenshots M1–M5); then an
      in-app update shows **no** Gatekeeper prompt. Sonoma: Control-click → Open (M6).
- [ ] Linux AppImage: in-app update; `.deb`: Beacon download message.
- [ ] Timer running → *Update now* → *After I stop* → stop from the tray → the update installs.
- [ ] Beacon `min_supported_version` above the running version → "Update required" (direct) / Store button (Store).

## 7. Sources

- Tauri v2, *Updater* plugin (dynamic server: 204, required `url` / `version` / `signature`; `createUpdaterArtifacts`;
  `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`; Windows `installMode`; custom headers) — https://v2.tauri.app/plugin/updater/
- Tauri v2, *Microsoft Store* (EXE/MSI only, "must be offline, handle auto-updates and be code signed"; publisher ≠
  product name) — https://v2.tauri.app/distribute/microsoft-store/
- Microsoft Learn, *App package requirements for MSIX app* (Store re-signs MSIX, no CA certificate; the fourth version
  part is reserved and the first cannot be 0) —
  https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/app-package-requirements
- Microsoft Learn, *App package requirements for MSI/EXE app* (Trusted Root Program certificate required; silent,
  offline installer; versioned URL) — https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/app-package-requirements
- Microsoft Learn, *Screenshots and images for MSIX app* (desktop screenshots ≥ 1366×768 PNG, at least 1) —
  https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/screenshots-and-images
- Microsoft Learn, *Create an app package with MakeAppx* — https://learn.microsoft.com/windows/msix/package/create-app-package-with-makeappx-tool
- Microsoft Learn, *Package a desktop app manually* (full-trust manifest) — https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-manual-conversion
- Windows Developer Blog, *Free developer registration for individual developers on Microsoft Store* (2025-09-10) —
  https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/
- Apple Support, *Safely open apps on your Mac* — https://support.apple.com/en-us/102445
- Macworld, Sequoia removes the Control-click bypass —
  https://www.macworld.com/article/2457844/what-to-do-when-you-cant-open-an-app-you-just-installed-in-macos-sequoia.html

## 8. macOS first-open guide

The same text as [`guides/macos-first-open.en.md`](guides/macos-first-open.en.md) and
[`guides/macos-first-open.es.md`](guides/macos-first-open.es.md), which Beacon can link to or copy.

### English — Opening TimeTrack on a Mac for the first time

TimeTrack for macOS is **not notarized by Apple**. Notarization needs a paid Apple Developer Program membership, and
TimeTrack is distributed at zero cost. macOS therefore asks you to confirm **once** that you trust the app. After that,
TimeTrack opens like any other app.

Only do this for a copy you downloaded from **your own Beacon** (Tasks → Time → Apps). To check the download, compare
its SHA-256 with the one shown on that page:

```sh
shasum -a 256 ~/Downloads/TimeTrack_*_universal.dmg
```

The dialog texts below are Apple's wording at the time of writing. They can differ slightly between macOS versions.

#### macOS Sequoia (15) and later

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

#### macOS Sonoma (14) and earlier

Either of these works:

- **System Settings**, as on Sequoia: try to open TimeTrack once, then go to **System Settings → Privacy & Security →
  Open Anyway**, and confirm.
- **Control-click**: in **Applications**, Control-click (or right-click) **TimeTrack** → **Open**, then click **Open**
  in the dialog.

  > **[Screenshot M6 — `docs/guides/images/macos-6-sonoma-control-click.en.png`]** Sonoma Finder, Applications folder,
  > with the context menu open on TimeTrack and **Open** highlighted. Then the dialog that offers **Open** and
  > **Cancel**. Two images side by side, or two files (`…-6a…`, `…-6b…`).

#### After the first time

- macOS remembers your choice. You only do this once per Mac.
- **Updates installed from inside TimeTrack don't ask again.** When TimeTrack shows *"Version X is available"* and you
  choose **Update now**, it downloads the update, checks its signature, replaces itself and restarts, with no macOS
  prompt. This is expected from how macOS treats files that weren't downloaded by a browser, but it has not been
  verified on a real Mac yet (see the 0.4.0 release plan).
- If you install a new version by hand from a downloaded `.dmg` instead, macOS may ask again. Repeat the steps above.

#### If macOS says "TimeTrack is damaged and can't be opened"

This message means the downloaded copy has no valid signature at all. TimeTrack 0.4.0 and later are ad-hoc signed
to avoid it. If you still see it, and you are sure the file came from your Beacon and its SHA-256 matches, run this
in Terminal. It removes the download flag from that one app only:

```sh
xattr -dr com.apple.quarantine /Applications/TimeTrack.app
```

Never turn off Gatekeeper for the whole Mac.

#### Sources

- Apple Support, *Safely open apps on your Mac* — https://support.apple.com/en-us/102445
- Apple Support, *Open a Mac app from an unknown developer* — https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac
- Macworld, *What to do when you can't open an app you just installed in macOS Sequoia* (Control-click change) —
  https://www.macworld.com/article/2457844/what-to-do-when-you-cant-open-an-app-you-just-installed-in-macos-sequoia.html

### Español — Abrir TimeTrack en un Mac por primera vez

TimeTrack para macOS **no está notarizado por Apple**. La notarización exige el Apple Developer Program, que es de
pago, y TimeTrack se distribuye sin coste. Por eso macOS te pide que confirmes **una sola vez** que confías en la app.
Después, TimeTrack se abre como cualquier otra app.

Hazlo solo con una copia descargada de **tu propio Beacon** (Tareas → Tiempo → Apps). Para comprobar la descarga,
compara su SHA-256 con el que muestra esa página:

```sh
shasum -a 256 ~/Downloads/TimeTrack_*_universal.dmg
```

Los textos de los diálogos son los de Apple en el momento de escribir esto. Pueden variar un poco entre versiones de
macOS.

#### macOS Sequoia (15) y posteriores

En Sequoia, **Control-clic (clic derecho) → Abrir ya no se salta esta comprobación**. Tienes que usar Ajustes del
Sistema.

1. **Instala.** Abre el `TimeTrack_<versión>_universal.dmg` descargado y arrastra **TimeTrack** a **Aplicaciones**.

   > **[Captura M1 — `docs/guides/images/macos-1-dmg.es.png`]** La ventana del Finder con la imagen de disco abierta,
   > en modo claro: el icono de TimeTrack (la cabeza de la mascota sobre el cuadrado verde musgo) a la izquierda, una
   > flecha y el alias de la carpeta Aplicaciones a la derecha. Recorta a la ventana de la imagen de disco.

2. **Intenta abrirla una vez.** En **Aplicaciones**, haz doble clic en **TimeTrack**. macOS muestra **No se ha abierto
   "TimeTrack"**: *"Apple no ha podido verificar que "TimeTrack" no contenga software malicioso que pueda dañar el Mac o
   poner en riesgo tu privacidad."* Pulsa **OK**. **No** pulses *Trasladar a la papelera*.

   > **[Captura M2 — `docs/guides/images/macos-2-not-opened.es.png`]** El diálogo «No se ha abierto "TimeTrack"» con
   > sus dos botones, **OK** y **Trasladar a la papelera**. Resalta **OK**. Recorta al diálogo.

3. **Permítela en Ajustes del Sistema.** Abre el **menú Apple → Ajustes del Sistema → Privacidad y seguridad**. Baja
   hasta **Seguridad**. Verás *Se ha bloqueado "TimeTrack" para proteger el Mac.* Pulsa **Abrir igualmente**. El botón
   solo aparece después del paso 2, y solo durante un rato (alrededor de una hora). Si no lo ves, repite el paso 2.

   > **[Captura M3 — `docs/guides/images/macos-3-open-anyway.es.png`]** Ajustes del Sistema → Privacidad y seguridad,
   > bajado hasta la sección **Seguridad**: la línea *Se ha bloqueado "TimeTrack" para proteger el Mac.* y el botón
   > **Abrir igualmente**. Resalta el botón. Ventana de unos 800 px de ancho; recorta al panel derecho.

4. **Confirma con tu contraseña.** Escribe la contraseña de inicio de sesión del Mac, o usa Touch ID.

   > **[Captura M4 — `docs/guides/images/macos-4-password.es.png`]** La petición de autenticación (Ajustes del Sistema
   > o «Privacidad y seguridad»), con el campo de contraseña vacío. Recorta a la petición.

5. **Abre.** Un último diálogo pregunta si quieres abrir TimeTrack. Pulsa **Abrir igualmente** (en algunas versiones el
   botón es **Abrir**). TimeTrack arranca y su icono aparece en la barra de menús.

   > **[Captura M5 — `docs/guides/images/macos-5-confirm.es.png`]** El diálogo final de confirmación con el botón
   > **Abrir igualmente** (o **Abrir**) resaltado. Recorta al diálogo.

#### macOS Sonoma (14) y anteriores

Funciona cualquiera de estas dos formas:

- **Ajustes del Sistema**, como en Sequoia: intenta abrir TimeTrack una vez, ve a **Ajustes del Sistema → Privacidad y
  seguridad → Abrir igualmente** y confirma.
- **Control-clic**: en **Aplicaciones**, haz Control-clic (o clic derecho) en **TimeTrack** → **Abrir**, y pulsa
  **Abrir** en el diálogo.

  > **[Captura M6 — `docs/guides/images/macos-6-sonoma-control-click.es.png`]** Finder de Sonoma, carpeta
  > Aplicaciones, con el menú contextual abierto sobre TimeTrack y **Abrir** resaltado. Después, el diálogo que ofrece
  > **Abrir** y **Cancelar**. Dos imágenes juntas, o dos archivos (`…-6a…`, `…-6b…`).

#### Después de la primera vez

- macOS recuerda tu decisión. Solo lo haces una vez en cada Mac.
- **Las actualizaciones que instala TimeTrack no vuelven a preguntar.** Cuando TimeTrack muestra *«La versión X está
  disponible»* y eliges **Actualizar ahora**, descarga la actualización, comprueba su firma, se sustituye a sí mismo y
  se reinicia, sin ningún aviso de macOS. Es lo esperado por cómo trata macOS los archivos que no ha descargado un
  navegador, pero todavía no se ha comprobado en un Mac real (ver el plan de la versión 0.4.0).
- Si instalas una versión nueva a mano desde un `.dmg` descargado, macOS puede volver a preguntar. Repite los pasos.

#### Si macOS dice «"TimeTrack" está dañado y no se puede abrir»

Este mensaje significa que la copia descargada no tiene ninguna firma válida. TimeTrack 0.4.0 y posteriores llevan una
firma ad hoc para evitarlo. Si aun así lo ves, y estás seguro de que el archivo viene de tu Beacon y su SHA-256
coincide, ejecuta esto en Terminal. Quita la marca de descarga solo de esa app:

```sh
xattr -dr com.apple.quarantine /Applications/TimeTrack.app
```

No desactives nunca Gatekeeper para todo el Mac.

#### Fuentes

- Soporte de Apple, *Abrir apps de forma segura en el Mac* — https://support.apple.com/es-es/102445
- Soporte de Apple, *Abrir una app de un desarrollador desconocido* — https://support.apple.com/es-es/guide/mac-help/mh40616/mac
- Macworld, cambio de Control-clic en Sequoia —
  https://www.macworld.com/article/2457844/what-to-do-when-you-cant-open-an-app-you-just-installed-in-macos-sequoia.html
