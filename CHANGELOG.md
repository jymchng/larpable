# Changelog

All notable changes to Larpable are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository scaffolding: strict TypeScript, React 18 + Vite application shell, Vitest
  runner, and `bun` scripts for dev, build, typecheck and test.
- Browser capability detection (`src/env/support.ts`) for the two things unkernel
  cannot run without — WebAssembly JSPI and cross-origin isolation — surfaced in the UI
  with actionable messages instead of a failed boot.
- Environment status model (`src/env/status.ts`) with the PRD §5.3 lifecycle, used by
  the shell's status bar so the UI never claims more than the environment manager knows.
- Cross-origin isolation headers for `dev`, `preview` and production (`netlify.toml`),
  including cache policy for hashed assets and the pinned Linux images.
