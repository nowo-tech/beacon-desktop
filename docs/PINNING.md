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
- **Scope.** Only the hosts listed in `pins.json` are pinned. Self-hosted Beacon servers keep normal WebPKI
  validation, and Settings shows *Connection not pinned*. Loopback (`localhost`, `127.0.0.1`, `::1`) and IP addresses
  are never pinned.
- **Expiry.** The pin set has an `expires` date. After that date the app stops enforcing it: it falls back to WebPKI
  and Settings shows *pinning expired, update the app*. This means an old install can never be locked out. CI fails
  90 days before the expiry date (`shipped_pin_set_is_valid_and_covers_the_production_host`), so a new set ships in
  time.
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
  intermediate chain, an unpinned host, and an untrusted CA (plain TLS error).
- `tests/unit/pinning.test.ts`: the `beacon_fetch` bridge, the error mapping (Spanish and English text, no offline
  mode, nothing queued) and the Settings line.
