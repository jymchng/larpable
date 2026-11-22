# Larpable — progress

_Status snapshot after implementing goal 3 of 15. Everything below was run; the
commands and numbers are copied from their output._

---

## 1. Where the project stands

**Product:** Larpable — a browser-native AI website development environment: Linux in
WebAssembly (unkernel), an autonomous coding agent, and a live preview of the real
production build. Built from `prds/01-whole-prd.md`.

**Workflow position:** `implement_goal` phase, goal **#3 of 15** (`ExecutionEnvironment`
abstraction + `UnkernelEnvironment` adapter) — implemented and green.

| Goal | State | Evidence |
| --- | --- | --- |
| 1. Repo scaffolding + toolchain | verified | typecheck 0, build emits `dist/`, dev server 200 with COOP/COEP. Commit `2663396`. |
| 2. unkernel feasibility harness | verified | `bun run feasibility` ran 202.9 s, wrote `docs/feasibility-report.md`. Commit `50b11f0`. |
| 3. ExecutionEnvironment + adapter | implemented, green | typecheck 0; unit suite 47 passed / 1 skipped; real-guest test passes under Node 24. |

**Measured facts that shaped the design** (from `docs/feasibility-report.md`):

| Fact | Value |
| --- | --- |
| Boot Alpine from `alpine.erofs` | 613 ms |
| Guest | Alpine 3.24.4, kernel 7.3.4+, **aarch64** |
| `MemoryFs` over 9p | round-trips both directions, no remount |
| Guest networking | `wget http://example.com` → `OK` |
| Node in guest | `v26.13.1`, npm `11.20.0` — via a first-use shim, ~147 s, exits 127 on its first call |
| Bun (aarch64 musl) | **unusable** (`libstdc++.so.6`, C++ symbol relocations) → Node + Vite is the supported path |
| `apk` as guest uid 1000 | **unusable** (`Unable to open log: Permission denied`) |
| Browser networking | no `directBackend` in `unkernel/web` → **Wisp only** |

---

## 2. What goal 3 delivered

| File | What it does |
| --- | --- |
| `src/env/execution.ts` | The PRD §5.2 contract: `ExecutionEnvironment`, `ExecutionOptions`, `ExecutionResult`, `FileEntry`, `InitializeOptions`. No unkernel type in any signature. |
| `src/env/environment-errors.ts` | Typed failures with stable codes: `NotReadyError`, `BusyError`, `OutsideWorkspaceError`, `FileNotFoundError`, `ExecutionTimeoutError`, `ExecutionCancelledError`. |
| `src/env/paths.ts` | Workspace boundary (`resolveWorkspacePath`) and the guest→mounted mapping (`toMountedPath`). |
| `src/env/workspace-fs.ts` | Narrow `WorkspaceFs` (satisfied structurally by unkernel's `MemoryFs`) + `MemoryWorkspace`. |
| `src/env/unkernel-kernel.ts` | Structural declarations of the unkernel surface used, plus `browserKernelFactory` (`checkSupport()` first, Wisp spec, no `direct` in browsers). |
| `src/env/unkernel-environment.ts` | The adapter: PRD §5.3 lifecycle, ready-gating, streaming, timeout/cancel → `SIGKILL` with partial output, file ops through the mounted fs, idempotent `shutdown()`. |
| `src/env/fake-environment.ts` | `FakeEnvironment`: records every call in order, answers only scripted commands, exit 127 for unscripted ones. |
| `tests/unkernel-environment.test.ts` | 22 tests through an injectable fake kernel. |
| `tests/guest/environment.guest.test.ts` | Gated real-kernel test (`bun run test:guest`, Node 24 + JSPI). |

Design decisions worth remembering:

- `execute()` runs `sh -lc <command>` because the interface takes a command **string**;
  `executeArgv()` exists where quoting must not be reinterpreted.
- A non-zero exit is a **result**, not an exception — the agent has to read failed build
  logs. Only infrastructure problems throw.
- The workspace `MemoryFs` is mounted at `/workspace`, so its own root *is* the
  workspace: guest `/workspace/x` is `/x` inside the fs. That mapping lives in one
  function because getting it wrong is invisible on the host and wrong in the guest.
- `shutdown()` budgets are capped by `commandTimeoutMs`, so a wedged guest cannot make
  shutdown outlive the thing it is cancelling.

---

## 3. Verification actually run

```
bun run typecheck   → exit 0 (both tsconfigs)
bun run test        → 47 passed | 1 skipped (48)   [guest test skipped by design]
bun run test:guest  → 1 passed (1)                 [real Alpine kernel, Node 24]
bun run build       → dist/index.html + 226 kB js (gzip 71 kB), built in 5.86 s
```

The guest test is the one that caught a real defect the unit tests could not: the
adapter was writing to `/workspace/workspace/package.json` inside the mounted fs, so
`cat /workspace/package.json` in Linux returned nothing while the host-side probe
"passed". Fixing it (`toMountedPath`) is what makes the host and the guest agree.

**Browser check (Playwright, Chromium, dev server on :5173):**

```
WebAssembly JSPI            available  (supported)
Cross-origin isolation      isolated   (supported)
SharedArrayBuffer           available  (supported)
Linux image                 3.9 MiB served from /distros/alpine.erofs
                            alpine-3.24.4-e0d59c37c0882d76 ready
Linux: Not started          Kernel can boot
```

Screenshot evidence: `.agenthicc/browser-artifacts/…/871d22fd….png`. The app renders, the
isolation headers are in effect, and the status line reports `Not started` — it does not
claim a boot that has not happened.

---

## 4. Blockers

**None.** No credential, network or capability gap is in the way. The only constraints
are the measured ones in §1, and they are already encoded in code (Wisp-only in the
browser; Node as the runtime; nothing depends on `apk`) or queued as goal #6.

---

## 5. Next

1. **Goal #4 — browser boot and workspace mount.** Wire `UnkernelEnvironment` into the
   app shell with `browserKernelFactory` (worker mode, IndexedDB data disk via
   `openDataDisk`/`IdbStore`, 9p `/workspace`), show live status, and prove it with
   Playwright: boot → `uname -a` → write/read in `/workspace`, plus an explicit
   unsupported-browser path instead of a silent failure.
2. **Goal #6 — guest runtime bootstrap**: pre-warm the `node` shim once after boot,
   persist `~/.local` on the data disk, retry the first 127, and document why Bun is out.
3. Then scaffolding/install/build (goal #7) and the mandatory `netlify.toml`
   generator/validator (goal #8).

## 6. Repo state

- Branch `main`; last commit `50b11f0` (feasibility report).
- This goal's files are committed together with this file: `src/env/*`,
  `tests/unkernel-environment.test.ts`, `tests/guest/environment.guest.test.ts`,
  `tsconfig.node.json` (adds the `@/*` alias for Node-side tests), `package.json`
  (`test:guest`), `progress.md`.
- No placeholders: nothing claims support it does not have, and the unsupported paths
  (Bun, `apk`, browser `direct` networking) fail with a message that names the reason.
