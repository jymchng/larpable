# Security boundaries

PRD §15 lists ten things to implement and one thing not to do: do not assume that
WebAssembly isolation alone provides application security. This document states what is
enforced, what is merely a convention, and what is not protected at all. Where a control is
missing, it says so and names the work that would add it.

The short version: **generated code is untrusted, the guest is a sandbox, and the browser
origin is not.** The biggest measured weakness is that a previewed page shares this app's
origin, so it can read this app's origin storage — including a provider key the user asked
to save. That is written down in [Known limitations](#known-limitations) rather than left to
be discovered.

## 1. Sandboxed iframe rendering

The preview renders in an iframe with `sandbox="allow-scripts allow-forms allow-same-origin"`
(`src/preview/sandbox.ts`). No `allow-top-navigation`, no `allow-popups`, no
`allow-modals`, no `allow-downloads`: a previewed site cannot navigate the app away from
itself, open a window, block it with a dialog, or write into the downloads folder. The iframe
also carries `referrerPolicy="no-referrer"` and `allow=""`, so guest code gets no referrer and
no permission grants.

`allow-same-origin` is there because of a measured constraint, not an oversight: the preview
is served by a service worker at scope `/__preview__/`, and an opaque-origin frame is
**not** a service-worker client in Chromium 159, so `/__preview__/<id>/` never reaches the
worker. `docs/preview.md` records the measurement and the alternative that was rejected.

## 2. Restricted host application access

A previewed page has no access to the app's React state, its ports, or its build manager: the
only channel between them is HTTP through `/__preview__/<id>/`. It does have whatever the
browser gives any same-origin document — see the first known limitation.

## 3. Filesystem boundaries

The host-side filesystem API is confined to the workspace root: every path is resolved and a
path that escapes it raises `OutsideWorkspaceError` before any I/O happens
(`src/env/paths.ts`, `src/env/environment-errors.ts`; tests in `tests/fs-bridge.test.ts`).
The agent's `write_file`/`read_file` tools go through that API, so a path such as
`../../etc/passwd` is refused rather than sanitised into something surprising.

Inside the guest the shell has root, by design — it is a development machine, and `npm
install` needs to write where it wants. That root is inside the WebAssembly VM: the only host
path it can reach is the `/workspace` mount, and the whole VM disappears with the tab.

## 4. Command execution limits

- **Time budget.** `VITE_COMMAND_TIMEOUT_MS` (default 600,000 ms, clamped to 5,000–3,600,000)
  is the per-command budget, overridable per call (`execute({ timeoutMs })`).
- **Output budget.** Each stream is capped at 8 MiB by default; a program that exceeds it is
  killed and the result is marked `truncated: true`, so a runaway `yes` cannot exhaust memory
  through the log.
- **Cancellation.** `execute({ signal })` kills the foreground program with `SIGKILL`; the
  rejection carries whatever was printed, and cancellation is never reported as a failure.
- **No infinite retries.** The runtime warm-up retries once and then reports; the agent loop
  has an iteration limit and a per-turn timeout (`src/agent/loop.ts`).

## 5. Process timeouts

Same mechanism as above. A timed-out command raises `ExecutionTimeoutError` with the partial
result and the budget that expired, so the UI and the agent can both say what happened instead
of "the build failed".

## 6. Resource limits and out-of-memory reporting

Guest memory is fixed when the guest boots: `VITE_LINUX_MEMORY_MIB`, default **1024 MiB**,
clamped to 128–4096 (`src/env/boot.ts`). CPUs are likewise `VITE_LINUX_CPUS` (1–4, default 2).
There is no swap and no balloon driver; a step that needs more than the budget fails.

When a build or install dies of memory pressure, `classifyFailure()` reports it as
`out-of-memory` with the guest's own error lines and a hint naming the variable and its
ceiling (`src/build/plan.ts`, tests in `tests/build-plan.test.ts`). A bare `Killed` is **not**
classified as out-of-memory: a timeout and a user's `kill -9` end the same way, and guessing
"memory" from that word would blame the wrong thing confidently.

A silent OOM kill that prints nothing at all still reaches the user as "was killed by a
signal" with the captured output — accurate, if less specific.

## 7. Network access

The guest has no raw sockets; the browser does not offer them. Traffic goes through a
[Wisp](https://github.com/MercuryWorkshop/wisp-protocol) proxy:

- `VITE_LINUX_NETWORK=none` boots the guest with no network at all, which is the honest way
  to run untrusted installs.
- The default proxy is `wss://wisp.mercurywork.shop/` (`DEFAULT_WISP_SERVERS`), chosen
  because unkernel's own default (`wss://wisp.pi0.io:6680/`) refuses pages on other origins:
  from `https://larpable.netlify.app` its handshake fails with a bare WebSocket `error` while
  it opens for `http://localhost:5173`. The measurement and the constant are kept in the same
  comment in `src/env/boot.ts`, so the reason travels with the URL. The replacement proxy is
  proven by real traffic from the deployed guest — `curl https://example.com` →
  `HTTP=200 time=2.847935s`, `RC=0` in `docs/evidence/curl-production-transcript.md`, and the
  handshake itself in `docs/evidence/ui-acceptance.txt` (`wisp connected: … (handshake 507
  ms)`).
- Override it with `?wisp=wss://your-proxy/` (no rebuild) or `VITE_WISP_SERVERS` (a list, tried
  in order), so a deployment need not trust someone else's relay. A self-hosted proxy is a
  `wisp-server-node` deployment; nothing in this repository depends on the default host.

**What that means for trust:** the proxy operator can observe the plaintext of any
non-TLS traffic the guest sends, including registry requests. If that matters, host your own.

## 8. Tool argument validation

Every tool declares a JSON-schema-shaped contract and arguments are validated before the tool
runs (`src/agent/tools/types.ts`; tests in `tests/agent-tools.test.ts`). An invalid argument
comes back to the model as a typed error rather than reaching the filesystem or the shell as
a half-parsed string. The model is never trusted to have produced a valid path, a valid
command or a valid `netlify.toml`.

## 9. API key protection

Two different keys, two different arrangements:

- **The user's own key** (OpenAI, Anthropic, or their own OpenRouter key) lives in this
  browser's `localStorage` and is sent to exactly one origin — the provider's
  (`src/llm/settings.ts`). It is never passed to a tool, never written into a project file,
  and never reaches the guest: `tests/agent-tools.test.ts` ("never sends the key to the
  guest, the project, the transcript or the UI") asserts this by searching every place it
  could have leaked.
- **The deployment's key** (`LARPABLE_OPENROUTER_DEFAULT_API_KEY`) is server-side only. It is
  deliberately not `VITE_`-prefixed, so Vite cannot inline it into the bundle; the dev/preview
  server's proxy (`src/lib/openrouter-proxy.ts`, wired in `vite.config.ts`) adds the
  `authorization` header on the way to OpenRouter, and `describeOpenRouterProxy()` reports
  only *whether* a key is configured. The variable's name is in `.env.example`; the value
  belongs in `.env.local`, which is git-ignored. Verified: the key appears in no file in the
  tree except `.env.local`, and in no commit.

## 10. Explicit approval for sensitive operations

**Not implemented.** The agent runs shell commands and writes files without asking, in the
guest, under the limits above. This is a documented gap rather than an implied guarantee:
there is no confirmation dialog for `rm -rf`, for a deploy, or for spending tokens.

What limits the damage today: the guest is a disposable VM, the host filesystem API is bounded
to `/workspace`, the preview cannot navigate or download, and the community tooling has a
per-command time and output budget. What does *not* limit it: anything the user's own
credentials could do outside the guest. Approval gates are the work that would change this.

## Failure reporting (PRD §16)

| Failure | What the product does | Where |
| --- | --- | --- |
| VM initialisation failure | Status becomes `error`; the panel shows the boot's own message and a retry, never a spinner forever | `src/env/unkernel-environment.ts`, `src/ui/environment-panel.tsx` |
| Bun unavailable | Detects the runtime and falls back to Node + npm, recording the measured reason | `src/runtime/detect.ts`, `tests/runtime-detect.test.ts` |
| Dependency installation failure | Returns the guest's captured log to the agent, classified (`network`, `permission`, `missing-dependency`) | `src/build/manager.ts`, `src/build/plan.ts` |
| Build failure | Agent sees the classified failure and the log, and may fix and rebuild; a second failure is reported as still failing instead of looping | `tests/agent-workflows.test.ts` |
| Preview server failure | The pane shows the routing module's own message (503/409/404/502), not a blank frame | `src/preview/routing.ts`, `tests/preview-frame.test.tsx` |
| Filesystem failure | Typed error (`file-not-found`, `outside-workspace`); the tool returns it to the model | `src/env/environment-errors.ts` |
| LLM API failure | The provider's status and message are surfaced; the turn fails visibly and can be retried | `src/llm/openai.ts`, `src/llm/anthropic.ts` |
| Browser refresh | The project tree and the guest's data disk are restored from IndexedDB | `src/projects/`, `src/env/unkernel-environment.ts` |
| Out-of-memory failure | Classified as `out-of-memory` with the memory budget and how to raise it | `src/build/plan.ts` (this document, §6) |
| Network failure | Classified as `network`, with the Wisp proxy as the named cause and the override | `src/build/plan.ts` |
| Invalid Netlify configuration | The validator's issues go back to the agent, which corrects the file | `src/netlify/validator.ts`, `tests/netlify-flow.test.ts` |

## Known limitations

1. **A previewed page shares this app's origin, so it can read this app's origin storage.**
   `allow-same-origin` is required for the service worker to serve the preview
   (`docs/preview.md`), which means a generated site can read `localStorage` — where the user's
   own provider key is kept — and `indexedDB` (the project list). Nothing in the current build
   exfiltrates anything; the exposure is structural. The fix is to stop persisting the key in
   origin storage (keep it in memory for the session, or serve the preview from a separate
   origin), and it is tracked as work rather than described as done.
2. **No approval gate for sensitive operations** (§10 above).
3. **The Wisp proxy sees non-TLS guest traffic.** Self-host if that matters.
4. **WebAssembly isolation is not a security boundary.** It protects the host from the guest's
   syscalls well enough for a development machine, but it is not audited as a sandbox for
   hostile code, and this document does not claim otherwise.
5. **The dev server can execute code**, which is why it binds to loopback by default. Setting
   `LARPABLE_DEV_HOST=0.0.0.0` is an explicit decision to expose that to a network; the
   permissive `Host` header and CORS behaviour are gated behind the same opt-in
   (`src/lib/dev-server.ts`), and `tests/dev-server-access.test.ts` asserts the loopback
   default so it cannot drift back.
