# Third-party notices

Beacon Desktop (formerly TimeTrack desktop) is MIT-licensed ([LICENSE](LICENSE)). It is built on open-source crates and npm packages under
permissive licences (MIT, Apache-2.0, BSD, ISC and similar); `Cargo.lock` and `pnpm-lock.yaml` list every version.
The components below need a specific notice.

## webpki-roots (Mozilla root store data)

- **Component:** [`webpki-roots`](https://github.com/rustls/webpki-roots) (crate, compiled into the app as the only
  set of trusted TLS roots; see [docs/PINNING.md](docs/PINNING.md)).
- **Licence:** [Community Data License Agreement – Permissive, Version 2.0](https://cdla.dev/permissive-2-0/)
  (CDLA-Permissive-2.0). The root certificate data comes from the Mozilla CA Certificate Program, through the Common
  CA Database (CCADB).
- **Notice:** CDLA-Permissive-2.0 allows use, modification and redistribution of the data, including in proprietary
  or differently licensed works, provided this licence text (or a link to it) is kept with any redistributed copy of
  the data. The data is provided "as is", without warranties.
- Because the roots are compiled in, adding or removing a trusted root takes an app release (Dependabot keeps the
  crate current).
