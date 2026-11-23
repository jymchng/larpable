# Definition of Done

PRD §21's checklist, with the evidence for each line. Three words are used precisely:

- **Met** — the behaviour was exercised and the result recorded; the evidence column names
  the file, test or command output.
- **Met, with a limitation** — it works, and the limitation is stated rather than hidden.
- **Open** — it is not proven yet. The evidence column says what is missing.

No line is marked Met on the strength of "the code exists". Last reviewed 2026-11-23.

| # | §21 item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | unkernel boots successfully | Met | Browser: "the guest booted to Ready — 5506 ms" in `docs/evidence/ui-acceptance.txt`; Node backend: "Alpine booted in 613 ms" in `docs/feasibility-report.md`; production: `docs/evidence/production-boot.png` |
| 2 | Linux commands execute | Met | Feasibility probe "Execute shell commands — uname and /etc/os-release both succeeded (exit 0/0)"; the in-app self-test asserts `uname -a` shows aarch64 (`src/env/self-test.ts`, `tests/self-test.test.ts`) |
| 3 | Filesystem operations work | Met | Feasibility "Host-mounted filesystem round-trip — host → guest and guest → host both visible without a remount"; `tests/fs-bridge.test.ts`, `tests/unkernel-environment.test.ts` |
| 4 | JavaScript runtime works | Met | "node v26.13.1, npm 11.20.0" in `docs/evidence/runtime-bootstrap-guest.json`; runtime panel shows the detected versions |
| 5 | Bun works or a documented fallback exists | Met, with a limitation | Debian: `bun --version` → 1.4.5, 67 packages installed in 41.9 s, `bun run build` in 143.8 s (`docs/evidence/build-guest.json`). Alpine: exit 127 (`docs/feasibility-report.md`), so Node + npm is the fallback. The measured reason is in `src/runtime/bootstrap.ts` and the README's "toolchain" section |
| 6 | Dependencies install inside Linux | Met | `docs/evidence/build-guest.json` — install exit 0, 41.9 s, 67 packages; `docs/evidence/nextjs-guest.txt` — 22 packages in 76–141 s |
| 7 | React applications can be generated | Met | `tests/scaffold.test.ts`; the scaffold used in `docs/evidence/build-guest.json` is the `react-ts` template |
| 8 | Production builds execute inside Linux | Met | `docs/evidence/build-guest.json` — `bun run build`, exit 0, 143.8 s, `dist/index.html` 0.39 kB + hashed assets |
| 9 | Build artifacts are accessible to the browser | Met | `docs/preview-browser-report.md` — the guest's `dist/` is listed, published to the worker, and served at `/__preview__/b-19w7puy/` |
| 10 | Website previews render in a sandboxed iframe | Met | `src/preview/sandbox.ts` + `tests/preview-frame.test.tsx` (sandbox string, no top-navigation/popups/modals/downloads); browser: `docs/evidence/preview-browser-desktop.png`, `preview-browser-mobile.png` |
| 11 | JavaScript modules load correctly | Met | `docs/preview-browser-report.md` — "the build's module executed inside the iframe: #answer reads "42"" |
| 12 | CSS and assets load correctly | Met | `docs/preview-browser-report.md` — "computed body background is rgb(18, 52, 86), expected rgb(18, 52, 86)"; the UI acceptance run's mobile check also reads the built page's own text inside the frame |
| 13 | Client-side routing works | Met | `docs/preview-browser-report.md` — "the deep link keeps its own path: #route reads "/__preview__/b-19w7puy/app/editor""; `tests/preview-routing.test.ts`, `tests/preview-browser.test.ts` (`pathFromFrameUrl`) |
| 14 | LLM can autonomously create websites | Met, with a limitation | The demo provider drives the real tools end to end in the browser (`docs/evidence/ui-acceptance.txt`, 25/25: prompt → 3 `write_file` rows → build → preview); the same procedure is asserted against the mock provider in `tests/agent-workflows.test.ts` ("ends with a validated netlify.toml, a successful build and a preview of that build"). A run against a *real* model is gated behind `LARPABLE_GUEST_TESTS=1` plus a key and has no recorded evidence yet |
| 15 | LLM can modify existing websites | Met, with the same limitation | `tests/agent-workflows.test.ts` — "rebuilds, republishes under a new id, and preserves the rest of the page" |
| 16 | LLM can recover from build failures | Met, with the same limitation | `tests/agent-workflows.test.ts` — "fails, reads the compiler, fixes the source, rebuilds and publishes the new build", and "reports a build that fails again as still failing, rather than looping silently" |
| 17 | Preview refreshes after successful builds | Met | Build-id routing (`src/preview/build-id.ts`, `tests/preview-build-id.test.ts`) plus the pane's reload path (`src/ui/App.tsx` → `preview.refresh(buildId)`); `docs/evidence/ui-acceptance.txt` — "reload loads a fresh document at the same URL" |
| 18 | `netlify.toml` is generated automatically | Met | `src/netlify/generator.ts`, `tests/netlify-generator.test.ts`, `tests/netlify-flow.test.ts`; guest-side write in `docs/evidence/netlify-guest.json` |
| 19 | Netlify configuration matches the actual project | Met | `tests/netlify-matrix.test.ts` — every framework × package-manager pair (6 × 3) is checked for command spelling, publish directory and SPA decision |
| 20 | Netlify configuration validation works | Met | `tests/netlify-validator.test.ts`, `tests/netlify-verdict.test.ts`; issues are returned to the agent, which corrects the file |
| 21 | Projects persist across sessions | Open (partly evidenced) | CRUD, path boundaries and metadata round-trip are unit-tested (`tests/project-manager.test.ts`) against `IndexedDbProjectStore`, and the guest's data disk is proven to survive a reboot (`docs/evidence/runtime-bootstrap-guest.json`, `reused: true`). A full browser reload showing a project file and its `netlify.toml` still present is not recorded — tracked as work |
| 22 | UI remains responsive during execution | Met | `docs/evidence/ui-acceptance.txt` — during a real 44.6 s build: 19,258 frames, max gap 83 ms, **0 gaps over 250 ms**, 58 long tasks, longest 75 ms |
| 23 | Unit tests pass | Met | `bun run test` — 61 files passed, 7 skipped (guest), **1,012 tests passed**, 8 skipped. `bun run typecheck` exits 0 and `bun run build` succeeds (12.57 s) on the same tree |
| 24 | Integration tests pass | Open (gated, evidence per file) | The guest suite runs only with `LARPABLE_GUEST_TESTS=1` (Node ≥ 24 + the Debian image). Recorded results exist per area — `docs/evidence/build-guest.json`, `runtime-bootstrap-guest.json`, `netlify-guest.json`, `preview-guest.md`, `nextjs-guest.txt` — but the Next.js guest run is stale (its runtime line reads `warm.warm is not a function`) and needs a re-run |
| 25 | End-to-end tests pass | Met, with a limitation | The demo-provider end-to-end run is recorded and green (`docs/evidence/ui-acceptance.txt`, 25/25, including prompt → tools → build → preview). A real-model end-to-end run is gated and unrecorded |
| 26 | Security limitations are documented | Met | `docs/security.md` — the ten §15 controls, the §16 failure table, and five named limitations (origin storage shared with the preview, no approval gate, Wisp visibility, WebAssembly is not a security boundary, dev-server exposure) |
| 27 | README and changelog are updated | Met | `README.md` (setup, architecture, unkernel notes, Wisp caveat with a self-hosted option, security summary, docs index) and `CHANGELOG.md` |

## What is still open, and where it is tracked

Nothing below is claimed anywhere in the README or the docs as working.

- **Project persistence across a page reload (#21)** — the browser proof is missing.
- **The gated guest/integration suite (#24)** — the Next.js guest test needs a re-run under a
  longer-lived runner; its last recorded line is a stale API call, not a result.
- **Real-model end-to-end (#14–#16, #25)** — the workflow is proven with the demo and mock
  providers; a paid-model run is opt-in and has no recorded transcript.
- **Approval gates for sensitive operations** — designed, not built (`docs/security.md` §10).
- **The provider key in origin storage** — a previewed page can read `localStorage`; the fix
  is to stop persisting the key or serve the preview from another origin.
- **Production deployment checks** — the deployed site boots and the preview renders
  (`docs/preview-browser-report.md`, 17/17 against `https://larpable.netlify.app`), while the
  `/distros/*` cache rules still need a post-deploy verification.

## Re-running the evidence

```bash
bun run typecheck && bun run test && bun run build   # the three gates
bun run acceptance:ui                                # prompt → tools → build → preview, frame gaps
bun run acceptance:preview                           # guest build → worker → iframe, CSS/JS/deep link
LARPABLE_GUEST_TESTS=1 bun run test:guest            # in-guest install/build/netlify/e2e
bun run feasibility                                  # the measured probes behind docs/feasibility-report.md
```
