/**
 * Live pin check (docs/PINNING.md, audit FY-D-3): connects to every host of `src-tauri/pins.json`, hashes the public
 * key (SPKI SHA-256, base64) of each CA certificate in the chain the server presents, and fails when none of them is
 * pinned — the case in which every pinned install would refuse the server. Runs weekly next to the expiry tripwire
 * (.github/workflows/pins.yml), as a second signal independent of the S18 monitor in Beacon.
 *
 * Node builds the chain with its own root store (not webpki-roots, which the app uses), so this checks "a pinned CA key
 * is in the path", not the full validation the app does.
 *
 * CLI: node scripts/release/check-pin-chain.mjs [path/to/pins.json]
 */
import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:tls';
import { pathToFileURL } from 'node:url';

/** SPKI SHA-256 (base64) of a DER certificate: the value pins.json lists. */
export function spkiSha256(der) {
  const spki = new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}

/**
 * @param {{pins: {pins?: {sha256: string, label?: string}[]}, host: string, chain: string[]}} input
 *   `chain`: SPKI hashes from the leaf (first) to the last certificate Node returned.
 * @returns {{ok: boolean, message: string}}
 */
export function checkChain({ pins, host, chain }) {
  const pinned = new Map((pins.pins ?? []).map((pin) => [pin.sha256, pin.label ?? pin.sha256]));
  if (chain.length < 2) return { ok: false, message: `${host}: the server sent no CA certificate (chain of ${chain.length})` };
  // CA keys only: the leaf is never pinned (pins.json, docs/PINNING.md).
  const hits = chain.slice(1).filter((hash) => pinned.has(hash));
  return hits.length > 0
    ? { ok: true, message: `${host}: pinned CA key in the chain (${hits.map((hash) => pinned.get(hash)).join('; ')})` }
    : { ok: false, message: `${host}: no pinned CA key in the chain [${chain.slice(1).join(', ')}]: the pinned apps refuse this server (docs/PINNING.md)` };
}

/* c8 ignore start */
/** SPKI hashes of the chain `host:443` presents, leaf first (Node's verified path; self-signed root last). */
function liveChain(host) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
      const hashes = [];
      const seen = new Set();
      for (let cert = socket.getPeerCertificate(true); cert?.raw !== undefined && !seen.has(cert.fingerprint256); cert = cert.issuerCertificate) {
        seen.add(cert.fingerprint256);
        hashes.push(spkiSha256(cert.raw));
      }
      socket.end();
      resolve(hashes);
    });
    socket.on('timeout', () => socket.destroy(new Error(`${host}: TLS timeout`)));
    socket.on('error', reject);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2] ?? new URL('../../src-tauri/pins.json', import.meta.url);
  const pins = JSON.parse(readFileSync(file, 'utf8'));
  let failed = false;
  for (const host of pins.hosts ?? []) {
    let result;
    try {
      result = checkChain({ pins, host, chain: await liveChain(host) });
    } catch (error) {
      result = { ok: false, message: `${host}: ${error instanceof Error ? error.message : String(error)}` };
    }
    (result.ok ? console.log : console.error)(`${result.ok ? 'pin chain:' : 'pin chain ERROR:'} ${result.message}`);
    failed ||= !result.ok;
  }
  process.exit(failed ? 1 : 0);
}
/* c8 ignore stop */
