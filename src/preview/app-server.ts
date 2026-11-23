/**
 * A *running* app inside the guest, started and watched like a person would start it.
 *
 * The preview pipeline was built for a static build: `dist/` is a directory of files, the
 * guest serves it, and the host publishes a snapshot. A Next.js (or Vite dev, or Express)
 * app is not that: it has no `dist/index.html`, it decides its own routes, and the only way
 * to see it is to *run* it and speak HTTP to the port it listens on.
 *
 * So this module does the three things that make that usable, and nothing else:
 *
 * 1. **Run the user's own command**, in the project directory, through the same
 *    `ExecutionEnvironment` the agent uses. `bun run start` means what it means.
 * 2. **Wait for the port to answer HTTP**, by asking the guest — not by sleeping and hoping.
 *    A green "ready" that no socket backs is the exact failure this project keeps having to
 *    remove, so readiness is the guest's answer and the first answer's URL is reported.
 * 3. **Report a process that died.** A dev server that exits with `Cannot find module 'next'`
 *    must fail here, with its output, instead of being polled until a timeout hides the
 *    reason.
 *
 * The server is stopped by aborting the execution, which is the environment's own
 * cancellation path (SIGKILL to the guest process), so no orphan listens after the pane
 * closes.
 */

import type { ExecutionEnvironment } from "@/env/execution";

/** A `fetch` shaped like the kernel's door into the guest, or a browser test's. */
export type GuestFetch = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<Response>;

export type AppServerFailure = "no-http" | "exited" | "timeout" | "cancelled" | "denied";

export interface AppServerStart {
  ok: boolean;
  /** The running server, when `ok`. */
  session: AppServerSession | null;
  /** Why it did not start, when not ok. */
  reason: AppServerFailure | null;
  message: string;
}

export interface AppServerSession {
  /** Guest port the app listens on. */
  port: number;
  /** The command that was run, exactly as the user would type it. */
  command: string;
  /** The first URL that answered, e.g. `http://127.0.0.1:3000/`. */
  url: string;
  /** The HTTP status of that first answer. */
  status: number;
  /** Everything the app printed so far, tail-first when long. */
  output(): string;
  /** True while the process is still running. */
  running(): boolean;
  /** Abort the process and wait for it to die. Idempotent. */
  stop(): Promise<void>;
}

export interface AppServerOptions {
  environment: ExecutionEnvironment;
  /** e.g. `bun run start`. Run through `sh -lc` by the environment. */
  command: string;
  /** Guest directory. Defaults to the environment's workspace. */
  root?: string;
  /** Guest port. Default 3000, Next's own default. */
  port?: number;
  /** HTTP into the guest. Without it, the server can start but never be confirmed. */
  fetch: GuestFetch | null;
  /** Budget until the app answers. Default 240 s: a Next dev server compiles on first request. */
  timeoutMs?: number;
  /** Poll interval. Default 500 ms. */
  intervalMs?: number;
  /** Live progress for the pane ("waiting for the app to answer"). */
  onStage?: (message: string) => void;
  /** Injectable clock and sleep, so a test measures decisions rather than wall time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The last `limit` characters of a log, because the error is at the end. */
export function outputTail(text: string, limit = 1_200): string {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
  return clean.length <= limit ? clean : `…\n${clean.slice(clean.length - limit)}`;
}

/**
 * Start an app in the guest and wait until it answers.
 *
 * The failure order is deliberate: an exited process is checked *before* the clock, because a
 * server that died of a missing module is a different problem from one that is merely slow,
 * and the message that says so is the whole value of this function.
 */
export async function startAppServer(options: AppServerOptions): Promise<AppServerStart> {
  const port = options.port ?? 3000;
  const root = options.root ?? options.environment.workspacePath;
  const fetchGuest = options.fetch;
  const timeoutMs = options.timeoutMs ?? 240_000;
  const intervalMs = options.intervalMs ?? 500;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (options.environment.status() !== "ready") {
    return {
      ok: false,
      session: null,
      reason: "denied",
      message: "The Linux environment is not running, so there is nothing to start the app in.",
    };
  }
  if (fetchGuest === null) {
    return {
      ok: false,
      session: null,
      reason: "no-http",
      message:
        "This guest cannot be reached over HTTP, so a running app could not be shown. " +
        "A kernel without fetch() (a test double) has no loopback to talk to.",
    };
  }

  const controller = new AbortController();
  let output = "";
  let exited = false;
  let cancelled = false;

  const execution = options.environment
    .execute(options.command, {
      cwd: root,
      // The port is *told* to the app, not merely probed: `next start`, `vite preview`, Express
      // and most other servers read `PORT`, so the number the user chose in Settings is the
      // number the server listens on and the number this function knocks on.
      env: { PORT: String(port) },
      signal: controller.signal,
      // A server does not exit; the budget belongs to the caller's own timeout below.
      timeoutMs: Math.max(timeoutMs, 60_000),
      onOutput: (chunk) => {
        output += chunk.text;
        // Bounded: a dev server that compiles logs megabytes.
        if (output.length > 64_000) output = output.slice(-32_000);
      },
    })
    .then(() => {
      exited = true;
    })
    .catch((error: unknown) => {
      cancelled = controller.signal.aborted;
      if (!cancelled) {
        exited = true;
        if (error instanceof Error) output += `\n${error.message}`;
      }
    });

  const deadline = now() + timeoutMs;
  let url = `http://127.0.0.1:${String(port)}/`;
  let status = 0;

  while (now() < deadline) {
    if (exited) {
      return {
        ok: false,
        session: null,
        reason: "exited",
        message: `\`${options.command}\` exited before it answered on port ${String(port)}.`,
      };
    }
    try {
      const response = await fetchGuest(url, { method: "GET" });
      status = response.status;
      // Any HTTP answer means the socket is open and the app is speaking: 404 from an app's
      // unknown path is still a running app.
      if (status > 0) {
        options.onStage?.(`${options.command} answered ${String(status)} on port ${String(port)}.`);
        return {
          ok: true,
          reason: null,
          message: `Running \`${options.command}\` on port ${String(port)}.`,
          session: {
            port,
            command: options.command,
            url,
            status,
            output: () => outputTail(output),
            running: () => !exited && !cancelled,
            async stop() {
              controller.abort();
              await execution;
            },
          },
        };
      }
    } catch {
      // Not listening yet. That is the expected answer while a dev server compiles.
    }
    options.onStage?.(`Waiting for ${options.command} to answer on port ${String(port)}…`);
    await sleep(intervalMs);
  }

  controller.abort();
  await execution;
  return {
    ok: false,
    session: null,
    reason: "timeout",
    message: `\`${options.command}\` did not answer on port ${String(port)} within ${String(Math.round(timeoutMs / 1000))} s.`,
  };
}

/**
 * The command a project's own `package.json` says to run.
 *
 * Read rather than guessed: `scripts.start` is the project's statement of how it starts, and
 * a project without one has no start. A Next project created by `create-next-app` always has
 * `"dev": "next dev"` and `"start": "next start"`, which is why this product can offer a
 * "run the app" control at all.
 */
export function startCommandFor(options: {
  packageManager: "npm" | "bun" | "pnpm" | "yarn";
  /** `scripts.start`, if the project has one. */
  startScript: string | null;
}): string | null {
  if (options.startScript === null || options.startScript.trim().length === 0) return null;
  return managerCommand(options.packageManager, "start");
}

/** How each package manager spells "run a script". Mirrors `src/build/plan.ts`. */
export function managerCommand(
  manager: "npm" | "bun" | "pnpm" | "yarn",
  script: string,
): string {
  switch (manager) {
    case "npm":
      return `npm run ${script}`;
    case "bun":
      return `bun run ${script}`;
    case "pnpm":
      return `pnpm ${script}`;
    case "yarn":
      return `yarn ${script}`;
  }
}
