# TLS public-key pinning

TimeTrack desktop pins the TLS public keys of the certificate authorities (CAs) that issue the certificate of the
official Beacon host. Even on a network with a TLS-inspecting proxy, or with a rogue CA trusted by the operating
system, the app's traffic to that host cannot be read or modified: the TLS handshake fails before any request (and its
Bearer token) is sent.

## How it works

- **Everything goes through Rust.** The webview cannot reach the network (CSP `connect-src ipc:`, no HTTP plugin).
  The UI calls the command `beacon_fetch` (`src-tauri/src/net.rs`, main window only). It makes GET or POST requests
  with allow-listed headers and no redirects or cookies, through one reqwest client on rustls. The update check
  (`check_update`) and the updater (`install_update`, via `configure_client`) use the same TLS configuration.
- **Verifier** (`src-tauri/src/pinning.rs`, `PinningVerifier`):
  1. Normal WebPKI validation (rustls `WebPkiServerVerifier`) against the compiled-in Mozilla roots
     (`webpki-roots`). The OS trust store is not used, so a CA added to it is not trusted at all.
  2. Only for a host in `src-tauri/pins.json`, and only while the pin set has not expired: a valid path from the
     server certificate to a trust anchor must contain a CA whose SPKI SHA-256 is pinned. The CA can be an
     intermediate or the anchor itself. The path search tries alternative chains (cross-signs) until one matches.
     The leaf key never counts.
  3. On a mismatch the handshake fails (fail closed: no fallback, no "continue anyway"). The UI shows *La conexión
     con Beacon no es de confianza (certificado inesperado)*, or the English *The connection to Beacon is not trusted
     (unexpected certificate)*, with Retry / Copy details. The action is not queued as offline. A non-sensitive event
     goes to stderr: `[tls-pinning] beacon_untrusted_certificate: unexpected certificate for <host> (pin set v<N>)`.
     It never includes a token, URL or certificate.
- **Bound origin.** `beacon_fetch`, the update check and the updater only talk to the origin of the server being
  signed in to (`beacon_bind`); plain `http://` to loopback works in debug builds only.
- **Trusted roots.** Only `webpki-roots` (Mozilla root store, CDLA-Permissive-2.0) is trusted, for every host.
  Self-hosted servers behind a private or corporate CA are not supported (API and updater).
- **Scope.** Only the hosts listed in `pins.json` are pinned. Self-hosted Beacon servers keep normal WebPKI
  validation, and Settings shows *Connection not pinned*. Loopback (`localhost`, `127.0.0.1`, `::1`) and IP addresses
  are never pinned.
- **Expiry.** The pin set has an `expires` date. After that date the app stops enforcing it: it falls back to WebPKI
  and Settings shows *pinning expired, update the app*; the main view shows the same as a card, and a desktop
  notification says it once per pin set version. This means an old install can never be locked out. CI fails 90 days
  before the expiry date (`shipped_pin_set_is_valid_and_covers_the_production_host` on Rust changes, and
  `.github/workflows/pins.yml` every Monday and on demand), and `release.yml` refuses to build a release when the set
  expires within 180 days (`scripts/release/check-pin-expiry.mjs`), so a new set ships in time.
- **Updater.** The update check sends the Bearer token to Beacon, so it must be pinned. The minisign signature already
  protects the downloaded artifact, but it does nothing for the token. The artifact download goes to object storage
  (another host, standard WebPKI, no token), and the signature is checked against the key built into the app.

## Pin set v1 (2026-11-05, expires 2028-05-01)

Production host: `beacon.nowo.tech` (the `BEACON_URL` repository variable). On 2026-11-05 it served this chain,
checked with `openssl s_client -connect beacon.nowo.tech:443 -servername beacon.nowo.tech -showcerts`:

```
0 CN=beacon.nowo.tech                 (leaf, Let's Encrypt, 90 days — not pinned)
1 C=US, O=Let's Encrypt, CN=YR1       issued by ISRG Root YR
2 C=US, O=ISRG, CN=Root YR            cross-signed by ISRG Root X1 (trust anchor)
```

| SPKI SHA-256 (base64)                          | CA                                          | Source                                |
| ---------------------------------------------- | ------------------------------------------- | ------------------------------------- |
| `fk6IOKit1ild5647BH06ujSIq5XbCgqlbYl6ANhhi88=` | ISRG Root YR (Let's Encrypt Gen Y, RSA)     | live chain + letsencrypt.org/certs/gen-y/root-yr.pem |
| `C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=` | ISRG Root X1 (anchor of the served chain)   | letsencrypt.org/certs/isrgrootx1.pem, Mozilla store |
| `LoMHBotttiDko50Gi13uXW71eIy7LAttI+rYT8wXF4w=` | Let's Encrypt YR1 (issuing intermediate)    | live chain + letsencrypt.org/certs/gen-y/int-yr1.pem |
| `sCkq5UWXjg+7mKu9lMhhYF5bGLsy7VI/UNW3tccdR7w=` | ISRG Root YE (Let's Encrypt Gen Y, ECDSA)   | letsencrypt.org/certs/gen-y/root-ye.pem |
| `diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=` | ISRG Root X2 (Let's Encrypt, ECDSA)         | letsencrypt.org/certs/isrg-root-x2.pem, Mozilla store |
| `hxqRlPTu1bMS/0DITB1SSu0vd4u/8l8TjPgfaAp63Gc=` | **Backup CA:** GTS Root R1 (Google, RSA)    | Mozilla store (`GTS_Root_R1.pem`)     |
| `mEflZT5enoR1FuXLgYYGqnVEoZvmf9c2bVBpiOjYQ0c=` | **Backup CA:** GTS Root R4 (Google, ECDSA)  | Mozilla store (`GTS_Root_R4.pem`)     |

Why these pins:

- **Roots, not leaves.** Let's Encrypt renews the leaf every 60–90 days with a new key. Leaf pins would break the app
  at the first renewal, and Beacon has no documented key-reuse policy. So the leaf is never pinned.
- **Every Let's Encrypt chain is covered.** Let's Encrypt picks the intermediate (YR1–YR3, YE1–YE3, or the older
  R1x / E5–E9) and can switch between RSA and ECDSA. The ISRG roots (YR, YE, X1, X2) match all of them. The YR1 pin
  is only informational.
- **The backup CA is from a different company.** Google Trust Services offers free ACME certificates. If Let's
  Encrypt is unavailable or distrusted, Beacon can switch to GTS without an app update.

To recompute a pin from a certificate:

```sh
openssl x509 -in ca.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
```

## Server-side preconditions (operations)

A pinned app fails closed when the official host serves a chain without a pinned key, and the pinned update check
fails too, so stuck apps cannot even learn about a fix. These must be in place on `beacon.nowo.tech` (and the name it
points to, `little-vps.nowo.tech`) **before** a pinned build reaches users, and stay in place (audit FY-M1):

1. **CAA records** that allow only the pinned CAs: `0 issue "letsencrypt.org"`, `0 issue "pki.goog"`, plus an
   `iodef` contact (for example `0 iodef "mailto:security@…"`). No CAA record means any CA may issue.
2. **An explicit ACME issuer** in the edge (Caddy / FrankenPHP / reverse proxy): Let's Encrypt only, or Let's Encrypt
   plus Google Trust Services (with EAB). **Never ZeroSSL**: Caddy's default issuer list falls back to ZeroSSL after a
   failed Let's Encrypt renewal, and one fallback would put an unpinned (Sectigo) chain on the host and lock out
   every pinned install while browsers look fine.
3. **A chain monitor** (CI cron or uptime check) that fails when no SPKI of the chain served by the host is in
   `src-tauri/pins.json`, for example:

   ```sh
   openssl s_client -connect beacon.nowo.tech:443 -servername beacon.nowo.tech -showcerts </dev/null 2>/dev/null \
     | awk '/BEGIN CERT/,/END CERT/' | csplit -s -z -f cert- - '/BEGIN CERT/' '{*}'
   for c in cert-*; do openssl x509 -in "$c" -pubkey -noout | openssl pkey -pubin -outform der \
     | openssl dgst -sha256 -binary | base64; done | grep -qxFf <(jq -r '.pins[].sha256' src-tauri/pins.json)
   ```

   It should also check that the served chain validates against `webpki-roots` (not only the system store), since
   that is the only root store the app trusts.

Before any CA switch (runbook step 3), check the new chain against these three as well.

### Current state of `beacon.nowo.tech` (checked 2026-11-05)

- **DNS only, TLS at the origin.** `beacon.nowo.tech` is a CNAME to `little-vps.nowo.tech` (an A record to the VPS,
  not a Cloudflare address). Traefik terminates TLS with a Let's Encrypt certificate it gets over ACME, and serves
  leaf → YR1 → Root YR (cross-signed by ISRG Root X1). That chain matches pin set v1.
- **CAA is not yet restrictive.** The zone `nowo.tech` is on Cloudflare with Universal SSL active. When a zone has any
  CAA record, Cloudflare adds CAA records for its own CAs automatically. So the effective set for `beacon.nowo.tech`
  (no CAA of its own, and none at `little-vps.nowo.tech`, so the lookup climbs to `nowo.tech`) is `letsencrypt.org`,
  `pki.goog`, `ssl.com`, `comodoca.com` (Sectigo) and `digicert.com`, for `issue` and `issuewild`. The intended
  `0 issue "letsencrypt.org"` does not by itself stop the other CAs. To make precondition 1 hold, put the CAA records
  on the name the CNAME points to (`little-vps.nowo.tech`: `0 issue "letsencrypt.org"`, `0 issue "pki.goog"`,
  `0 issuewild ";"`, `0 iodef "mailto:…"`). A CNAME cannot carry CAA itself. Then check with a DNS-over-HTTPS query
  that Cloudflare has not added its own CAs to that name as well.

### Cloudflare proxy (orange cloud): decision

The pin set stays as the security review (FY) left it: Let's Encrypt (ISRG X1 / X2 / YR / YE, YR1) plus Google Trust
Services (GTS R1 / R4) as the backup CA. **No SSL.com or Sectigo pins.**

- If `beacon.nowo.tech` is switched to *Proxied*, apps see Cloudflare's edge certificate, not Traefik's. Cloudflare
  Universal SSL issues from Let's Encrypt, Google Trust Services or SSL.com, and its backup certificates can also come
  from Sectigo. A Let's Encrypt or GTS edge certificate matches the pins (GTS WE1 / WR1 chain to GTS Root R4 / R1, also
  when the GlobalSign cross-sign is served). An SSL.com or Sectigo edge certificate does **not**, and every pinned app
  would fail closed.
- Pinning SSL.com and Sectigo as well would make two more CA companies acceptable for the official host, which
  removes most of the protection against a mis-issuing CA. The host does not need them: TLS is terminated by Traefik
  with Let's Encrypt, and a proxied host would also give Cloudflare the plaintext, which is a separate decision.
- **Rule:** keep `beacon.nowo.tech` *DNS only*. If it ever has to be proxied, first use an edge certificate whose CA
  is fixed to Let's Encrypt or Google Trust Services (Cloudflare Advanced Certificate Manager lets you choose the CA),
  check the served chain with the chain monitor above, and only then switch.
- **Recovery is server side and immediate:** switching the record back to *DNS only* restores the origin's Let's
  Encrypt chain, so pinned apps reconnect after the DNS TTL without an app update. The chain monitor (precondition 3)
  is what notices the switch.

## Rotation runbook

Pins only change with a new signed app version. Always keep at least one pin that matches the live chain in every
version that users still run.

**Changing the CA (or a CA key) of the production host:**

1. **Add.** Add the new CA's SPKI pin(s) to `src-tauri/pins.json` and keep all the old ones. Bump `version`, set
   `issued` to today, and set `expires` to at most 18 months out. Update the table above and the CHANGELOG.
2. **Ship.** Release the version and let it spread. Raise `min_supported_version` in Beacon to that version, so older
   copies are asked to update before the switch, and wait until active installs have updated.
3. **Switch** the certificate of the production host to the new CA. Check it with `openssl s_client` (see above),
   then from an updated app (Settings shows *Secure connection*, and any API call works).
4. **Remove.** In a later release, remove the old pins (bump `version` again). Keep the backup CA.

**Routine maintenance** (no CA change): before the pin set expires (CI fails 90 days before), re-check the live chain,
refresh the dates (`version` +1, new `issued`, new `expires`) and ship.

**Emergency (the CA in use is distrusted or compromised):** switch the host to the backup CA (Google Trust
Services). The installed apps already accept it, so no app update is needed. Then pick a new backup CA and ship it
with the add → ship → remove steps.

**Adding a host** (for example a second official region): add it to `hosts` (exact name, lowercase, no wildcard, no
IP) and ship it with the add → ship steps.

**Never** commit private keys or real certificates for tests. The Rust tests generate their CAs, leaves and the local
TLS mock server at test time (`rcgen`).

## Tests

- `src-tauri/src/pinning.rs`: a pin match on a root and on an intermediate, a mismatch with a trusted rogue CA, a
  leaf key that is never a pin, the backup pin, an expired pin set (falls back to WebPKI), an unpinned host, WebPKI
  failures before pinning, IP addresses, and pin file validation. A CI tripwire checks the shipped set (covers
  `beacon.nowo.tech`, has a backup CA, and expires more than 90 days out).
- `src-tauri/src/net.rs` (end to end): a local TLS mock server with a CA made at test time, reached through the real
  client. Covered: the pinned success, a pin mismatch (exact error, and the server never receives the request), an
  intermediate chain, an unpinned host, an untrusted CA (plain TLS error), and requests to another origin than the
  bound server (refused, nothing and no token reaches the server). Loopback http only in debug builds; updater error
  details without query strings.
- `tests/unit/pinning.test.ts`: the `beacon_fetch` bridge, the error mapping (Spanish and English text, no offline
  mode, nothing queued), the Settings line, binding the server (sign-in, start-up, sign-out) and the expired-pinning
  card and notification.
- `tests/unit/release-scripts.test.ts`: the expiry tripwire script used by `pins.yml` and `release.yml`.
