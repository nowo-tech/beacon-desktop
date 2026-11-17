# Contributing

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to
uphold it. Please report unacceptable behavior to **hectorfranco@nowo.tech**.

## How to contribute

1. Node 24, pnpm (`packageManager` in `package.json`; `corepack enable`), Rust stable and the Tauri prerequisites.
2. `pnpm install`, then `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm test:e2e` and, in `src-tauri/`,
   `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` must pass (coverage ≥ 90%).
3. Conventional commits (`feat:`, `fix:`, `docs:`, `chore:` …), one topic per pull request, CHANGELOG entry under
   `[Unreleased]`.
4. Privacy rules are part of the definition of done: no activity monitoring, no URLs or titles sent anywhere, any new
   data needs an opt-in with dated consent and an update of PRIVACY.md and the "What we collect" screen (en + es).
5. `src/api/` is shared verbatim with nowo-tech/time-track-extension: change both repositories together.
6. GitHub Actions are pinned to full commit SHAs with the version in a trailing comment; Dependabot updates them,
   proposing a release only once it is seven days old (`cooldown` in `.github/dependabot.yml`).
   `dtolnay/rust-toolchain` is the exception: it is pinned to a head of its `stable` branch, which Dependabot cannot
   track. Refresh it by hand now and then (`gh api repos/dtolnay/rust-toolchain/commits/stable --jq .sha`) in
   `ci.yml` and `platforms.yml`, and keep its `toolchain: stable` input.
