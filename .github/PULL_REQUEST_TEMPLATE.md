## Description

Please include a concise summary of the changes and the related issue (if applicable).

Fixes # (issue number)

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Checklist

- [ ] My code follows the project's coding standards (ESLint, `cargo fmt`, `cargo clippy`)
- [ ] I have performed a self-review of my code
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit and end-to-end tests pass locally with my changes
- [ ] I have updated the documentation accordingly
- [ ] I have updated `CHANGELOG.md` under `[Unreleased]` if applicable
- [ ] The privacy rules in `CONTRIBUTING.md` still hold (no activity monitoring, no URLs or titles sent anywhere)

## Testing

Please describe the tests you ran to verify your changes:

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage
pnpm test:e2e
(cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
```

## Screenshots (if applicable)

Add screenshots to help explain your changes.

## Additional Notes

Add any other notes about the PR here.
