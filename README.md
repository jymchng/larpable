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
`docs/definition-of-done.md` once that document exists.

Nothing in this README claims a capability that is not implemented and measured. Where
a limitation is known, it is written down rather than worked around.

## Requirements

- **Bun** ≥ 1.2 (build, install, scripts).
- A browser with **WebAssembly JSPI** and cross-origin isolation:
  Chrome/Edge 137+, Firefox 153+, or Safari 27+. The app detects this on load and
  explains what is missing instead of failing mid-boot.
- The first boot downloads a Linux distro image (~4 MB for Alpine). It is served from
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
  llm/         LLMProvider implementations (OpenAI-compatible, Anthropic, mock)
  tools/       Tool definitions and argument validation
  runtime/     Guest runtime detection (Bun, else Node) and scaffolding
  build/       Dependency installation and production builds
  preview/     Guest HTTP server, host proxy, iframe renderer
  persistence/ IndexedDB projects, session restore, conversation history
  netlify/     netlify.toml generation and validation
```

Three design decisions are worth knowing up front:

- **The guest is aarch64 Linux.** unkernel runs unmodified arm64 binaries, so every
  tool used inside the guest must be an arm64 build (`bun-linux-aarch64-musl` for
  Alpine, `nodejs` from apk).
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
[Wisp](https://github.com/MercuryWorkshop/wisp-protocol) proxy. The default proxy
accepts a fixed list of origins, so `bun install` inside the guest only works when the
app is served from an allowed origin or from a proxy you host yourself. This is a
real constraint on a client-side npm install, not something the UI pretends away.

## Security boundaries

Generated code is untrusted. The preview renders in a sandboxed iframe without access
to the host origin, its storage or its credentials; API keys stay in the app's own
storage and are never written into the guest filesystem or a generated project.
WebAssembly isolation is not treated as a complete security boundary — the precise
limits are documented with the hardening work rather than implied here.

## License

MIT.
