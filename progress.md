# Larpable — progress

_Status snapshot after implementing goal 8 of 24. Every number below was copied from a
command run in this repo; nothing is estimated._

---

## 1. Where the project stands

**Product:** Larpable — a browser-native AI website development environment: Linux in
WebAssembly (unkernel), an autonomous coding agent, and a live preview of the real
production build. Built from `prds/01-whole-prd.md`.

**Workflow position:** `implement_goal`, goal **#8 of 24** (runtime detection → scaffold →
install/build). Goals #1–#7 are verified and closed; #8 is implemented and typechecks, its
tests arrive with the verification phase.

| Goal | State | Evidence |
| --- | --- | --- |
| 1. Repo scaffolding + toolchain | verified | typecheck 0; `dist/` with COOP/COEP. `2663396` |
| 2. unkernel feasibility harness | verified | `bun run feasibility`, 202.9 s → `docs/feasibility-report.md`. `50b11f0` |
| 3. `ExecutionEnvironment` + `UnkernelEnvironment` | verified | 22 adapter tests through a fake kernel; real-guest test green. |
| 4. Browser boot + `/workspace` mount | verified | Playwright: boot → `uname -a` → write/read in `/workspace`; explicit unsupported-browser path. |
| 5. Terminal attached to the guest pty | verified | `f07b736` (xterm over the real pty). |
| 6. Guest file bridge | verified | `tests/fs-bridge.test.ts`, 19 tests. |
| 7. Guest runtime bootstrap (node/npm, cached) | verified | `tests/runtime-bootstrap.test.ts` (16) + gated real-boot test. `58d169e`, `ea2aace`, `a980f4c` |
| 8. Runtime detection → scaffold → install/build | implemented | `bun run typecheck` 0; suite still 120/122. Files in §2. |

Measured constraints the design obeys (from `docs/feasibility-report.md` and
`docs/evidence/runtime-bootstrap-guest.json`):

| Fact | Value |
| --- | --- |
| Guest | Alpine 3.24.4, kernel 7.3.4+, **aarch64** |
| Node in guest | `v26.13.1`, npm `11.20.0` — first call exits 127, then works |
| Bun (aarch64 musl) | **unusable** — `libstdc++.so.6`, C++ symbol relocations |
| `apk` as guest uid 1000 | **unusable** — `Unable to open log: Permission denied` |
| Browser networking | no `directBackend` → **Wisp only** |
| Cold boot with install | 51.8 s (repeat 55.1 s) |
| Second boot, same `kwdata` disk | 15.8 s (repeat 13.6 s), `reused=true`, `downloaded=false` |

---

## 2. What goal 8 delivered

| File | What it does |
| --- | --- |
| `src/runtime/detect.ts` | `detectRuntime()` probes the guest once and returns `RuntimeInfo` (node/npm vs bun + versions, `installed`, `reused`). Bun is refused with the measured reason, not a generic failure. `installCommand()`, `LOCKFILES`, `describeRuntime()`. |
| `src/runtime/scaffold.ts` | `scaffoldProject()` builds file lists for `react-ts`, `vue`, `svelte`, `vanilla` — templates are real strings in the file, no network fetch at scaffold time. `writeScaffold()` writes them through the workspace fs. |
| `src/build/plan.ts` | Pure decisions, no I/O: `parsePackageJson()`, `detectBuildCommand()` (scripts.build → framework default → typecheck-only), `resolveOutputDir()` (vite config → `netlify.toml` → CRA → `dist/`), `classifyFailure()` with `BuildFailureKind` (`missing-script`, `missing-dependency`, `compile`, `network`, `permission`, `missing-entry`, `timeout`, `unknown`). |
| `src/build/manager.ts` | `BuildManager` orchestrates install → build through `ExecutionEnvironment`, captures `CommandLog`s, assigns build ids, verifies the output dir really contains an HTML entry, and maps timeouts/aborts to typed failures. |

Design decisions worth remembering:

- **`plan.ts` never touches the guest.** All judgement (which command, which output dir,
  what kind of failure) is a pure function, so it is cheap to test and impossible to make
  flaky. `manager.ts` only executes what the plan decided.
- **`timeout` is its own failure kind.** A build that ran out of budget must not be
  reported as a compile error; the agent would chase a problem in the user's code.
- **The output directory is verified, not trusted.** A build that exits 0 into an empty
  `dist/` is still a failure — `missing-entry` — because previewing an empty page looks
  like success to everyone except the person looking at it.
- **Scaffold templates live in the source.** Fetching them from the network would make the
  first-run experience depend on a CDN that the guest may not reach.

---

## 3. Verification actually run

```
bun run typecheck   → exit 0 (both tsconfigs)
bun run test        → 120 passed | 2 skipped (122) in 6.35 s
```

The suite has been green three consecutive runs at `a980f4c`; this goal's four new modules
add no tests yet and change no existing behaviour, so the count is unchanged. Goal 8 has
**no unit tests and no gated integration test** — that is the next phase's job, and until
then this file claims implementation, not verification.

---

## 4. `curl` on production — reproduced, two root causes, one still open

Reported symptom: in the deployed app `curl` fails two ways at once —
`[net] … wisp server unavailable`, then `curl: -w needs the real curl` and
`wget: can't connect (198.18.0.2): Connection refused`.

**Cause 1 — no guest network on the Netlify origin.** Measured handshakes:

| Wisp server | `Origin: https://larpable.netlify.app` |
| --- | --- |
| `wss://wisp.pi0.io:6680/` (current default) | **404** (works for `localhost`) |
| `wss://wisp.mercurywork.shop/` | **101 Switching Protocols** |
| `wisp.incognito.cafe`, `wisp.ading.dev` | handshake failed |

So the guest's `198.18.0.2` is a Wisp-backed address with no working proxy behind it, and
every outbound connection is refused.

**Cause 2 — there is no real `curl`.** `/usr/local/bin/curl` is a first-use shim;
`apk add cmd:curl` cannot run at uid 1000. A static aarch64-musl `curl 8.23.0-1` was
fetched from `stunnel/static-curl` to `.tmp/curl/curl` (10,061,488 bytes, sha256
`3a7c6818…`) and `scripts/probe-curl-install.mjs` staged it at
`/workspace/.larpable/bin/curl` — but **the shim still won on `PATH`**, so
`curl --version` printed `installing the real curl` instead of a version. The binary was
never executed.

**Open:** (a) make the staged binary beat the shim — either put `.larpable/bin` ahead of
`/usr/local/bin` in the guest `PATH` or replace the shim during bootstrap; (b) default the
app to `wss://wisp.mercurywork.shop/` (still overridable with `VITE_WISP_SERVERS` /
`?wisp=`) so a deployment can actually reach the network.

---

## 5. Blockers

**None blocking the goals.** Two known-open items are tracked as goals, not surprises:

- `/distros/*` now 404s for missing files (`netlify.toml`), and the day-long cache rule is
  scoped to real files only — needs one deploy to prove in production.
- `tests/terminal-shell.test.ts` still has a timing race; it needs ~10 consecutive clean
  runs before it can be called stable.

## 6. Repo state

- Branch `main`; last commit `a980f4c`.
- New and uncommitted: `src/runtime/detect.ts`, `src/runtime/scaffold.ts`,
  `src/build/plan.ts`, `src/build/manager.ts`, `scripts/probe-curl-install.mjs`,
  `docs/evidence/probe-curl-production.png`, this file.
- No placeholders: Bun, `apk`, and browser `direct` networking all fail with a message
  that names the measured reason.
