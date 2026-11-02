# Contributing

1. Node 24, pnpm (`packageManager` in `package.json`; `corepack enable`), Rust stable and the Tauri prerequisites.
2. `pnpm install`, then `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm test:e2e` and, in `src-tauri/`,
   `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` must pass (coverage ≥ 90%).
3. Conventional commits (`feat:`, `fix:`, `docs:`, `chore:` …), one topic per pull request, CHANGELOG entry under
   `[Unreleased]`.
4. Privacy rules are part of the definition of done: no activity monitoring, no URLs or titles sent anywhere, any new
   data needs an opt-in with dated consent and an update of PRIVACY.md and the "What we collect" screen (en + es).
5. `src/api/` is shared verbatim with nowo-tech/time-track-extension: change both repositories together.
