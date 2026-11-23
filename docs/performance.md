# Performance

PRD §17 asks for a browser-native development machine that does not freeze the page it
runs in, and for benchmarks of initialisation, dependency installation and builds. This
document records the numbers that exist, where each one came from, and the design
decisions that produce them.

Nothing here is estimated. Every figure names the file it was read from, and each of those
files was written by a command that measured the thing it reports. Where a number is a
range, it is a range because the same step was measured more than once on different
images.

## The first paint does not carry a Linux machine

The kernel is a 10.2 MB WebAssembly blob and its JavaScript loader is another half
megabyte. Neither is useful to someone who opens the page and never boots anything, so
neither is on the critical path: `src/env/unkernel-kernel.ts` reaches the SDK with
`await import("unkernel/web")` inside the function that boots it, and the terminal loads
xterm the same way when its panel first opens.

Measured from a clean production build of this repository (`bun run build`, 2026-11-23):

| Asset | Size | Gzip | Loaded |
| --- | --- | --- | --- |
| `assets/index-*.js` | 487.90 kB | 151.08 kB | At first paint |
| `assets/index-*.css` | 37.35 kB | 7.42 kB | At first paint |
| `assets/web-*.js` (SDK loader) | 533.16 kB | 180.65 kB | On boot |
| `assets/unkernel-*.wasm` (kernel) | 10,165.32 kB | — | On boot |
| `assets/xterm-*.js` | 329.53 kB | 83.25 kB | When the terminal opens |
| `assets/xterm-*.css` | 5.18 kB | 1.91 kB | When the terminal opens |
| `assets/addon-fit-*.js` | 1.62 kB | 0.73 kB | When the terminal opens |

`dist/index.html` references exactly two of those files — the entry script and the entry
stylesheet. The rest are separate chunks fetched on demand.

That split survives only as long as nobody writes `import … from "unkernel/web"` at module
scope, so it is guarded: `tests/kernel-lazy-load.test.ts` fails if a static value import of
the SDK appears anywhere in `src/`. (`import type` is fine — types are erased.)

## Benchmarks

| Stage | Measured | Source |
| --- | --- | --- |
| Host app build (`bun run build`) | 13.91 s (12.57 s on a repeat run) | Measured 2026-11-23 on this machine (Vite's own `built in` line) |
| Guest boot to Ready — browser, Debian 13, 2 vCPU, 1024 MiB | 5,506 ms | `docs/evidence/ui-acceptance.txt`, run started 2026-11-23T08:23:37Z |
| Kernel boot — Node backend, Alpine, feasibility harness | 613 ms | `docs/feasibility-report.md` |
| Node shim first warm-up — cold data disk, Alpine | 51.8 s | `docs/evidence/runtime-bootstrap-guest.json` |
| Node shim first warm-up — cold data disk, Debian | 98.3 s | `docs/evidence/nextjs-guest.txt` (run 06:35:25Z) |
| Node shim second boot — same data disk, nothing downloaded | 15.8 s | `docs/evidence/runtime-bootstrap-guest.json` (`reused: true`, `downloaded: false`) |
| `bun --version`, first call through the shim | 28.4 s – 63.7 s | `docs/evidence/nextjs-guest.txt`, `docs/evidence/build-guest.json` |
| `bun install`, 67 packages (React + TS + Vite) | 41.9 s | `docs/evidence/build-guest.json` |
| `bun install`, 22 packages (Next.js 16) | 76.1 s – 141.4 s | `docs/evidence/nextjs-guest.txt` |
| Production build in the guest, scaffolded React + TS | 143.8 s | `docs/evidence/build-guest.json` (`vite build`, exit 0) |
| Production build in the guest, managed starter | 44.6 s | `docs/evidence/ui-acceptance.txt` |
| Publish → first painted frame in the preview | 5,690 ms | `docs/evidence/ui-acceptance.txt` |
| One chat turn with three `write_file` tool calls (demo provider) | 870 ms | `docs/evidence/ui-acceptance.txt` |

The two build figures are not a contradiction: they are different projects. The 143.8 s
build is a freshly scaffolded React + TypeScript app with its own dependency tree; the
44.6 s build is the starter demo the acceptance run writes by hand. A cold guest build is
dominated by the first-time `node`/`bun` warm-up, which is why it is measured separately.

## What keeps the page responsive while a build runs

- **The kernel is a Web Worker.** `resolveBrowserEnvironmentConfig()` defaults
  `VITE_LINUX_WORKER` to `true`, so compilation happens off the main thread. A build that
  froze the UI would be worse than a slow one.
- **Output streams.** `ExecutionResult` is assembled from `onOutput` deltas and a program
  that outlives its budget is killed, so the build log appears as it is produced rather
  than at the end.
- **Everything is cancellable.** `execute({ signal })` and the build controller cancel with
  `SIGKILL`; cancellation is reported as a cancellation, not as a failed build.

Measured during the build in `docs/evidence/ui-acceptance.txt` (a real 44.6 s build in the
guest, sampled with `requestAnimationFrame`):

```text
responsiveness during the build: 19258 frames, max gap 83 ms, 0 gaps over 250 ms,
58 long tasks (longest 75 ms)
```

Zero frame gaps over 250 ms, with the longest single task at 75 ms. That is the measurement
behind "the UI remains responsive during execution" in `docs/definition-of-done.md` — it is
not an assertion about the architecture.

## Reuse instead of repetition

- **The runtime is paid for once per project.** The first-use `node` shim installs Node into
  `~/.local`, which lives on the persistent IndexedDB data disk. The second boot measured
  15.8 s and downloaded nothing (`reused: true`), against 51.8 s cold.
- **`node_modules` survives.** The workspace is a real mount, not a copy, so an install
  performed once is still there for the next build — and for the next page load.
- **The kernel is not restarted to rebuild.** A build runs a command in the booted guest;
  only an explicit shutdown or a reload reboots it.
- **Boot is explicit, not implicit.** `createBrowserEnvironment()` constructs an environment
  without initialising it, so the page can render, show capability findings and wait for a
  click instead of booting on load.
- **Builds are addressed by id.** `src/preview/build-id.ts` and the routing layer serve
  `/__preview__/<buildId>/`, so a reload of a new build can never mix a stale HTML document
  with fresh assets.

## Reproducing these numbers

```bash
bun run build                     # host build; the asset table above comes from dist/
bun run test                      # includes the lazy-load guard
bun run acceptance:ui             # boots the guest, builds in it, samples frame gaps
bun run acceptance:preview        # publishes a guest build and times the first frame
LARPABLE_GUEST_TESTS=1 bun run test:guest   # the in-guest install/build timings
```

The guest-facing numbers require the Debian image (`bun run fetch:distros`) and a Node ≥ 24
host (`.tooling/node`, via `bun run fetch:node`).
