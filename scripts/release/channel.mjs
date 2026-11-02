/**
 * Release channel helpers shared by time-track-extension and time-track-desktop (keep both copies identical).
 *
 * Bucket layout (Beacon spec, contract §7.1): `time-track-clients/<app>/<version>/<file>`, then
 * `time-track-clients/<app>/channel/stable.json` written LAST as the atomic switch:
 * `{version, pub_date, notes, min_supported_version?, files: [{target, arch, kind, key, sha256, signature?}]}`.
 *
 * CLI:
 *   node scripts/release/channel.mjs describe --app A --version V --target T --arch X --kind K [--signature F.sig] FILE
 *     → one JSON line describing FILE (append it to a fragments file)
 *   node scripts/release/channel.mjs stable --version V [--changelog CHANGELOG.md] [--min V] FRAGMENTS...
 *     → stable.json on stdout
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const PREFIX = 'time-track-clients';
export const APPS = ['desktop', 'firefox', 'chromium'];
export const KINDS = ['installer', 'updater', 'xpi'];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_FILE = /^[A-Za-z0-9._+-]+$/;

export function assertVersion(version) {
  if (!SEMVER.test(version ?? '')) {
    throw new Error(`Invalid version "${version}"`);
  }
  return version;
}

export function objectKey(app, version, file) {
  if (!APPS.includes(app)) {
    throw new Error(`Unknown app "${app}" (expected ${APPS.join(' | ')})`);
  }
  const name = basename(file).replaceAll(' ', '_');
  if (!SAFE_FILE.test(name)) {
    throw new Error(`Unsafe file name "${name}"`);
  }
  return `${PREFIX}/${app}/${assertVersion(version)}/${name}`;
}

export function channelKey(app) {
  if (!APPS.includes(app)) {
    throw new Error(`Unknown app "${app}"`);
  }
  return `${PREFIX}/${app}/channel/stable.json`;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * @param {{app: string, version: string, target: string, arch: string, kind: string, file: string,
 *          content: Buffer, signature?: string}} input
 * @returns {Record<string, string>}
 */
export function describeFile({ app, version, target, arch, kind, file, content, signature }) {
  if (!KINDS.includes(kind)) {
    throw new Error(`Unknown kind "${kind}" (expected ${KINDS.join(' | ')})`);
  }
  if (!target || !arch) {
    throw new Error('target and arch are required');
  }
  const entry = { target, arch, kind, key: objectKey(app, version, file), sha256: sha256(content) };
  if (signature !== undefined && signature.trim() !== '') {
    entry.signature = signature.trim();
  }
  return entry;
}

/** Body of the `## [version]` section of a Keep a Changelog file (empty string when absent). */
export function notesFromChangelog(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^## \\[?${version.replaceAll('.', '\\.')}\\]?(\\s|$)`).test(line));
  if (start === -1) {
    return '';
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

/**
 * @param {{version: string, notes?: string, pubDate?: Date, minSupportedVersion?: string, files: Array<Record<string, string>>}} input
 * @returns {Record<string, any>}
 */
export function buildStable({ version, notes = '', pubDate = new Date(), minSupportedVersion, files }) {
  assertVersion(version);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('stable.json needs at least one file');
  }
  const keys = new Set();
  for (const file of files) {
    if (!file.key?.includes(`/${version}/`)) {
      throw new Error(`File ${file.key} does not belong to version ${version}`);
    }
    const id = `${file.target}/${file.arch}/${file.kind}/${file.key}`;
    if (keys.has(id)) {
      throw new Error(`Duplicate file entry ${id}`);
    }
    keys.add(id);
  }
  const stable = { version, pub_date: pubDate.toISOString().replace(/\.\d{3}Z$/, 'Z'), notes };
  if (minSupportedVersion !== undefined && minSupportedVersion !== '') {
    stable.min_supported_version = assertVersion(minSupportedVersion);
  }
  stable.files = files;
  return stable;
}

export function parseFragments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/* c8 ignore start */
function main(argv) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      app: { type: 'string' },
      version: { type: 'string' },
      target: { type: 'string' },
      arch: { type: 'string' },
      kind: { type: 'string' },
      signature: { type: 'string' },
      changelog: { type: 'string' },
      min: { type: 'string' },
    },
  });
  if (command === 'describe') {
    const file = positionals[0];
    const entry = describeFile({
      app: values.app,
      version: values.version,
      target: values.target,
      arch: values.arch,
      kind: values.kind,
      file,
      content: readFileSync(file),
      signature: values.signature ? readFileSync(values.signature, 'utf8') : undefined,
    });
    process.stdout.write(`${JSON.stringify(entry)}\n`);
    return;
  }
  if (command === 'stable') {
    const files = positionals.flatMap((path) => parseFragments(readFileSync(path, 'utf8')));
    const notes = values.changelog ? notesFromChangelog(readFileSync(values.changelog, 'utf8'), values.version) : '';
    const stable = buildStable({ version: values.version, notes, minSupportedVersion: values.min, files });
    process.stdout.write(`${JSON.stringify(stable, null, 2)}\n`);
    return;
  }
  console.error('usage: channel.mjs describe|stable …');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
/* c8 ignore stop */
