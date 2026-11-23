# Larpable

**A browser-native AI website development environment.** Describe a website, and an
autonomous agent builds it inside a real Linux machine running in your browser —
installing dependencies, compiling a production build, and rendering that build in a
sandboxed preview.

The browser *is* the development machine. There is no backend doing project creation,
filesystem work, dependency installation, compilation or preview serving. Only LLM
inference leaves the page.

## Status

This repository is under active construction against
[`prds/01-whole-prd.md`](prds/01-whole-prd.md). The scaffolding, environment
abstraction and agent runtime land first; the PRD's §21 Definition of Done is the
acceptance list, and the current evidence for each item lives in
[`docs/definition-of-done.md`](docs/definition-of-done.md) — one line per requirement, the
file or test that proves it, and an explicit list of what is still open.

Nothing in this README claims a capability that is not implemented and measured. Where
a limitation is known, it is written down rather than worked around.

## Requirements

- **Bun** ≥ 1.2 (build, install, scripts).
- A browser with **WebAssembly JSPI** and cross-origin isolation:
  Chrome/Edge 137+, Firefox 153+, or Safari 27+. The app detects this on load and
  explains what is missing instead of failing mid-boot.
- The first boot downloads a Linux distro image (69.2 MiB for Debian 13). It is served from
  this app's own origin; see [Distro images](#distro-images).

## Getting started

```bash
bun install
bun run dev        # http://localhost:5173, with cross-origin isolation headers
```

Other scripts:

| Command | What it does |
| --- | --- |
| `bun run build` | Production build of the app into `dist/` |
| `bun run preview` | Serve that build locally (same isolation headers) |
| `bun run typecheck` | `tsc --noEmit` for the app and for Node-side scripts |
| `bun run test` | Vitest unit suite |
| `bun run fetch:distros` | Download the pinned Linux images into `public/distros/` |
| `bun run fetch:node` | Download a Node ≥ 24 binary into `.tooling/` for Node-only scripts |
| `bun run feasibility` | Run the measured unkernel feasibility probes |

## Architecture

The implementation keeps PRD §4.1's boundaries, so the Linux environment can be
swapped without touching the agent:

```text
src/
  ui/          React application: chat, preview, status
  env/         ExecutionEnvironment abstraction + unkernel adapter
  agent/       Tool-calling loop, system prompt, conversation state
  agent/tools/ Tool definitions and argument validation
  llm/         LLMProvider implementations (OpenAI-compatible, Anthropic, mock, demo)
  runtime/     Guest runtime detection (Bun, else Node) and scaffolding
  build/       Dependency installation and production builds
  preview/     Guest HTTP server, host proxy, iframe renderer
  projects/    IndexedDB projects, session restore, conversation history
  netlify/     netlify.toml generation and validation
```

Three design decisions are worth knowing up front:

- **The guest is aarch64 Linux, booted from a Debian 13 image.** Alpine was tried first
  (4 MB instead of 69.2 MiB) and dropped: its `curl` is a first-use shim, `apk` cannot
  install anything for the guest's unprivileged uid 1000, and a staged static curl still
  lost to the shim on `PATH`. Debian is also the image unkernel's own demo page boots, so
  this is the environment known to work rather than the smaller one plus workarounds.
  Goals #2-#8 were measured on Alpine; those reports stay as historical evidence, and the
  guest tests now boot `/distros/debian.erofs`.
- **The toolchain is Node + npm**, from the image's own first-use shim (`node --version`
  downloads Node once, then it is cached in `~/.local` on the persistent data disk). Bun
  is probed rather than assumed, because the answer depends on the image: on Alpine it
  exited 127 (`libstdc++.so.6`), on Debian it answers `1.4.5`, installs 67 packages in
  33 s and builds a scaffolded React project in 203 s. `src/runtime/detect.ts` measures it
  at boot and records the reason it was or was not selected; `vite build` runs Node
  tooling either way, so Bun is the preferred *package manager*, not a replacement for the
  Node shim.
- **Filesystem access goes through one bridge.** The guest `/workspace` is a 9p
  host mount backed by `MemoryFs`, so writes propagate in both directions and the
  agent, the build manager and the UI all see the same files.
- **The preview is served, not synthesised.** A static HTTP server runs in the guest
  and the host proxies to it over vsock, so JavaScript modules, CSS, fonts, source
  maps and client-side routing behave as they would on a real host.

## Distro images

unkernel's kernel is in the npm package; the Linux userland is not. The images are
pinned to the installed unkernel release and downloaded by
`bun run fetch:distros` into `public/distros/` (git-ignored). They are then served
from the app's own origin, which keeps them working under `Cross-Origin-Embedder-Policy:
require-corp` and under strict proxy rules.

## Networking inside the guest

Browsers cannot open raw TCP sockets, so the guest reaches the network through a
[Wisp](https://github.com/MercuryWorkshop/wisp-protocol) proxy. This app defaults to
`wss://wisp.mercurywork.shop/` rather than unkernel's built-in default, because that one
rejects pages on other origins — measured from the deployed site as a bare WebSocket error
on the handshake, which leaves the guest with no network while looking perfectly healthy.

Point it somewhere else without a rebuild:

| Override | Scope |
| --- | --- |
| `?wisp=wss://your-proxy/` in the URL | One page load, no rebuild |
| `VITE_WISP_SERVERS=wss://a/,wss://b/` | A deployment, tried in order |
| `VITE_LINUX_NETWORK=none` | Boots the guest with no network at all |

Any Wisp server works, including one you host yourself (`wisp-server-node`) — nothing here
depends on the default host staying up. The operator of whichever proxy you use can see
non-TLS guest traffic, which is one more reason to host your own if that matters.

## Security boundaries

Generated code is untrusted. The preview renders in a sandboxed iframe with no top
navigation, no popups, no modals and no downloads; API keys are never written into the
guest filesystem or a generated project; the host-side filesystem API refuses any path that
escapes `/workspace`; and every command has a time budget, an output cap and a cancel that
kills it.

The precise boundaries — including the ones this app does **not** have, such as an approval
gate before destructive commands, and the fact that a previewed page shares this app's origin
and can therefore read its `localStorage` — are written down in
[`docs/security.md`](docs/security.md). WebAssembly isolation is not treated as a complete
security boundary.

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/definition-of-done.md`](docs/definition-of-done.md) | PRD §21, item by item, with the evidence for each and what is still open |
| [`docs/security.md`](docs/security.md) | §15/§16: sandbox, filesystem and command limits, keys, network, known limitations |
| [`docs/performance.md`](docs/performance.md) | §17: measured boot/install/build timings, bundle split, responsiveness |
| [`docs/preview.md`](docs/preview.md) | How the preview is served, and why the iframe needs `allow-same-origin` |
| [`docs/deploy-report.md`](docs/deploy-report.md) | Production deployment measurements and headers |
| [`docs/feasibility-report.md`](docs/feasibility-report.md) | The measured unkernel probes behind every runtime decision |
| [`docs/toast.md`](docs/toast.md) | Notifications: every message the app announces is a coloured, dismissible toast, and where the sentences that used to live in the panes went |
| [`docs/mobile.md`](docs/mobile.md) | What a phone changes: one pane at a time, 44 px targets, and the limits a handset browser has when it cannot boot the kernel |

## License

MIT.
