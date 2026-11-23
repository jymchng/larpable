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

- **The machine.** unkernel boots in a Web Worker from the Debian 13 image served from this
  origin, with an IndexedDB data disk (the root overlay survives a reload) and guest
  networking through a Wisp proxy. The kernel is lazily imported, so the 10.2 MB WebAssembly
  binary and its 533 kB loader are not in the entry bundle.
- **The environment contract.** `ExecutionEnvironment` (`src/env/execution.ts`) with one
  unkernel adapter: a `ready`-gated state machine, streamed output, a per-command time budget
  (`VITE_COMMAND_TIMEOUT_MS`), `SIGKILL` cancellation, an 8 MiB per-stream output cap, and
  typed errors for timeout, cancellation, not-ready and paths outside the workspace.
- **Guest toolchain.** Runtime detection (Bun when it works, Node + npm otherwise) with a
  first-use `node` shim that is warmed once, retried once, and cached in `~/.local` on the
  persistent disk — measured at 51.8 s cold and 15.8 s on the next boot.
- **Builds.** Scaffolding (React+TS, vanilla, Vue, Svelte), in-guest install and production
  build, real output-directory resolution, build ids, and classified failures
  (`missing-script`, `missing-dependency`, `compile`, `network`, `permission`, `timeout`,
  `out-of-memory`, `unknown`) that quote the guest's own log lines.
- **`netlify.toml`.** Generated from inspected project facts, kept current, and validated —
  including a cross-product test over every framework × package-manager pair.
- **Preview.** A guest HTTP server behind a host proxy, build-id routing that cannot serve a
  stale build, a service worker at `/__preview__/`, and a sandboxed iframe. The pane is
  dressed as a browser: a tab strip naming the build, back/forward, a read-only address bar
  that follows the frame's own navigation, reload, and a device toolbar — with disabled
  arrows that are genuinely disabled and no invented history.
- **Agent.** OpenAI-compatible, Anthropic, mock and demo providers; a tool-calling loop with
  multi-call turns, streamed text, cancellation, an iteration limit and build-claim checking;
  filesystem, shell, build, preview, project and Netlify tools with validated arguments; and
  a system prompt that encodes the create/modify/recover procedures.
- **UI.** Split agent/preview layout, streaming chat with inspectable tool rows, build strip
  with cancel, live environment panel, terminal with tabs, sticky modifiers and
  selection-accurate clipboard actions, settings for provider/model/key, and a status bar
  driven by real state.
- **Projects.** IndexedDB-backed project store and manager: create, open, rename, delete,
  session restore, rule-based Netlify config, per-project workspace roots.
- **A second provider path.** A "Default" option that talks to OpenRouter's free models
  through this app's own `/api/openrouter` proxy, so a deployment can supply the key
  server-side. The key is deliberately not `VITE_`-prefixed, never enters the bundle, and is
  never logged.
- **`install_dependencies`, and it runs Bun only.** The install is a tool again, for the
  reason it was removed: a model that sends `npm install` through `execute_command` and never
  reads the log can go on to "fix" a build that failed because `node_modules/` was empty. The
  tool makes one claim checkable — *installed, or here is the guest's own error* — and it
  never substitutes a package manager: on a machine whose runtime detection chose npm it
  refuses before running anything, and when `bun` itself is missing it returns the guest's 127
  instead of re-running with npm. `BuildManager` gained `packageManager`/`fallbackToNpm`
  (default off, so the tool's "Bun only" is the manager's default rather than a tool's private
  convention), and the pane's manager now prefers Bun because that is what the supported guest
  was measured to run (`docs/performance.md`).

### Changed

- **The machine boots with the page.** Opening Larpable no longer leaves an idle guest behind an
  instruction: `useAutoBoot` (`src/ui/use-autoboot.ts`) calls the environment's boot action once
  per mount, and a spinner appears beside the wordmark while it runs, driven by the
  environment's own status and stage rather than a timer. The rules are pure functions
  (`src/ui/autoboot.ts`): never on a browser the support probe rejected, never a second attempt
  (React 18 `StrictMode` mounts twice), never a restart of a machine that failed or was shut
  down, and no spinner left turning over a failure — an `error` shows the machine's own message
  and a retry. `boot()` also had to learn to tear a half-built machine down: it used to return
  early while the failed adapter was still in its ref, which made that retry a no-op. Measured in
  Chromium at 390 × 844 with no click: 11/11 checks, spinner named `Starting Linux` and animating,
  page load to `Ready` in 15.2 s (the app's own boot: 9.8 s), one image read with no range
  requested twice, `scrollWidth - clientWidth` 0, and `?simulateSupport=no-jspi` boots nothing —
  see `docs/autoboot.md` and `docs/evidence/autoboot-*.png`.
- **The provider settings are a popover, not a band.** The cog beside the Agent heading now
  opens a labelled dialog anchored to itself (`src/ui/components/popover.tsx`), carrying the
  same provider buttons, model field, key field and reset — so configuring the provider no
  longer pushes the prompt box down, which on a 360 px phone it always did. It starts closed,
  closes on Escape (returning focus to the cog) and on a press outside, and moves focus into
  the surface on open; the trigger's name stays "Provider settings" in both states and
  `aria-expanded` carries the state instead. The rules are pure functions
  (`src/ui/popover.ts`) asserted by `tests/popover.test.ts`; the markup by `tests/app.test.tsx`
  and `tests/settings-panel.test.tsx`; and the real events by `bun run acceptance:popover`,
  which measures them in Chromium at 390 × 844 (measured: 9/9 checks, surface 352 px wide
  inside a 390 px viewport, dialog right edge equal to the cog's, `scrollWidth - clientWidth` =
  0) and writes `docs/evidence/provider-popover-390.png` — see `docs/provider-popover.md`.
- **The debug information is one popover, and the status bar moved into it.** The six facts that
  ran as a band under the header (Linux, runtime, project, build, Netlify, preview) and the
  browser report that ran as a sheet under it are now a single labelled dialog behind the `d`
  beside the wordmark — `Popover`, so Escape, a press outside, focus in on open and focus back
  to the trigger come from the component that already did them for the provider settings. The
  body is shorter as well: the three requirement rows are one line (`3/3 met`, plus the problems
  and their browser-version advice only when something is missing, with every check still named
  in the line's tooltip and the dot's accessible name), the Linux image is one line, and the
  environment card is `compact` — it keeps the Boot / self-test / Shut down controls it owns and
  drops its title and description. Nothing is painted twice: there is exactly one
  `status-facts` list on the page. Measured in Chromium at 390 × 844 (`bun run acceptance:debug`):
  15/15 checks, six facts read inside the surface (`Linux=Ready | Runtime=node (guest shim) |
  Project=/workspace | Build=none | Netlify=not validated | Preview=none`), popover 352 px wide
  at `x=38..390`, `scrollWidth - clientWidth` 0 for the surface and the page, Escape closes it
  and returns focus to the `d`, a press outside closes it, and the same surface opens at 1440 px
  — see `docs/debug-popover.md` and `docs/evidence/debug-popover-390.png`.
- **Controls are pictograms, not sentences.** Every button in the chat box, the environment
  card, the build strip, the preview toolbar, the browser chrome, the settings panel and the
  terminal is now a lucide icon whose colour states what kind of action it is — green to run,
  red to stop or destroy, grey when it is secondary, plain foreground when it only moves you —
  through one `IconButton` (`src/ui/components/icon-button.tsx`) that cannot be built without
  an accessible name. The words are unpainted, not deleted: `aria-label` is the name and
  `title` is the tooltip, so a screen reader announces "Install & build" and a mouse user reads
  the same sentence on hover. The 32 px hit target, the visible focus ring and the
  name/tooltip pairing are asserted by `tests/icon-buttons.test.tsx`, which sweeps every button
  on thirteen rendered states and fails on an empty name; `scripts/icon-buttons-evidence.ts`
  repeats the audit against the running page in Chromium (measured: 33 buttons, 20 icon-only,
  0 unnamed, 0 untitled, 0 below the floor at 1440 px and at 390 px) and writes
  `docs/evidence/icon-buttons-desktop.png` / `-mobile.png`.
- The dev and preview servers bind to `127.0.0.1` by default; exposing them requires an
  explicit `LARPABLE_DEV_HOST`, because a Vite dev server can execute code. Permissive
  `Host` headers and CORS follow the same opt-in.
- The preview iframe's sandbox includes `allow-same-origin`, because a service worker cannot
  serve an opaque-origin frame — measured, with the consequence (the frame shares this
  origin's storage) documented in `docs/security.md` rather than glossed over.
- Guest images are pinned to the installed unkernel release and fetched by
  `bun run fetch:distros`; the runtime decisions that used to say "Alpine" now name the image
  they were measured on.
- **A published build no longer wears a green `worker` badge.** It appeared the moment the preview
  worker took a build — the *normal* outcome, painted in the colour `docs/toast.md` reserves for
  news, and it repeated the debug popover's `Preview` segment. The badge and the toolbar row that
  held it are gone (`src/ui/preview-pane.tsx`), so the row is absent rather than empty; the
  guest's amber `guest` badge stays, because a fallback is the case a debugging user needs, and
  the app preview keeps its own. The controller's answer is still machine-readable as
  `data-served` on the pane, which is what `scripts/preview-browser-acceptance.ts` reads for its
  "the preview worker holds the build" check. Asserted by `tests/preview-pane.test.tsx` and
  `tests/preview-chrome.test.tsx`.
- **An empty preview pane says so, and points at the hammer.** The pane used to be chrome and
  nothing else before the first build, which was a dead end for a first-time user (user request:
  *"when there is no preview show that there is no preview and a hint to click on the Hammer
  button"*). `PreviewPanel` now renders a placeholder for the idle state — "No preview yet." under
  a hammer glyph — and `PreviewPane` passes the hint that names the control, because that is the
  file that renders it: absent a build control the copy says only that a build has to be published,
  so the placeholder never names a button that is not on screen. Asserted by
  `tests/preview-frame.test.tsx` and `tests/preview-pane.test.tsx`.
- **The terminal's connection dot moved into the debug popover.** The panel's header painted one
  green `StatusDot` for "the shell is attached" (user request: *"remove the green dot from the
  terminal panel and move its information into the debug popover"*) — a fact only visible while the
  terminal was on screen, in the near-black palette of that strip. It is a seventh status segment
  (`Terminal`: `no shell` / `connecting` / `connected` / `exited` / `failed`, with how many shells
  are open and the guest's own error) fed from a callback the panel makes when its active tab
  changes, so the fact outlives the pane. The rule is unchanged and still asserted: green only when
  the shell is actually attached (`tests/status-bar.test.ts`, `tests/status-dot.test.tsx`).
- **Two placeholder texts got smaller.** The agent pane's empty-transcript hint is 12 px rather than
  13 px, so it reads as chrome beside the conversation instead of as the first message (user
  request: *"the placeholder text in the agent tab can be smaller"*); the same copy under the
  offline agent pane follows it. **And the `Shell N` tab lost its block padding**: it took
  `TOUCH_TARGET_BLOCK` — 36 px of ink for a 15 px line — so a two-tab strip stood 40 px high (user
  request: *"the Shell <N> tab in the terminal pane has too high a y padding around the Shell <B>
  text"*). It is now the same 24 px inline control as the `×` beside it (`data-inline`, WCAG
  2.5.8), which is the floor the browser audit applies to it.

### Fixed

- The guest terminal showed a bash `PS1` template verbatim (`\[\033[36m\]\w …`) because the
  shell was `dash`; it now spawns an interactive login bash with a POSIX-safe fallback.
- Copy/Cut in the terminal panel acted on the whole panel instead of the selection; the
  actions now read the terminal's own selection and paste targets the active tab only.
- The preview pane rendered blank for real builds: the frame needed `allow-same-origin` to be
  a worker client, and the proxied documents needed COOP/COEP to survive this app's
  cross-origin isolation. Both are asserted by test so they cannot regress quietly.
- A reload in the preview re-published whatever was in `dist/`; it now re-publishes the build
  on screen and loads a fresh document at the same URL.
- A guest killed by memory pressure was reported as "unknown"; it is now classified as
  `out-of-memory` with the memory budget and how to raise it, while a bare `SIGKILL` is still
  reported as what it is.

### Documentation

- `docs/definition-of-done.md` — PRD §21, item by item, with per-item evidence and an
  explicit list of what is still open.
- `docs/security.md` — the §15/§16 controls, the measured constraints, and five named
  limitations.
- `docs/performance.md` — measured boot, install, build and first-frame timings, the bundle
  split behind lazy loading, and the frame-gap measurement taken during a real build.
- README: current setup, the Wisp caveat with a self-hosted proxy option, the security
  summary, and a documentation index.
