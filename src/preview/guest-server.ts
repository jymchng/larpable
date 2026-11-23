/**
 * The guest half of the preview: a static file server inside Linux.
 *
 * Why a server in the guest at all, when the host can already `readFile` every byte? Two
 * reasons, both about honesty:
 *
 * 1. the host should see the build the way a browser will — through HTTP, with a status
 *    code, a `Content-Type` the server actually chose, and the failure modes of a real
 *    server (`404`, a path that is a directory, a file that vanished mid-request);
 * 2. the preview must read the *guest's* file system, so a build that wrote its output
 *    somewhere unexpected is visible here rather than papered over by a cached read.
 *
 * The image decides the implementation. Measured in the Debian guest
 * (`scripts/probe-guest-http.mjs`): `python3`, `python`, `busybox`, `php` and `ruby` are
 * all absent, and `node` is the first-use shim at `/usr/lib/kw/bin/node`, which
 * `RuntimeBootstrap` already warms. So the server is a Node script, written into the
 * workspace, started once and reused until the build changes or the guest stops.
 *
 * The script is deliberately dumb: it serves bytes and lists them. Every decision a
 * preview can get *wrong* — MIME types, SPA fallback, staleness — lives on the host in
 * `routing.ts`, where it is unit-tested without a guest.
 */

import type { ExecutionEnvironment, ExecutionResult } from "../env/execution";
import { joinGuestPath } from "../env/paths";

/** Where the script is written, relative to the workspace: dot-prefixed, so it reads as tooling. */
export const PREVIEW_SERVER_DIR = ".larpable";
export const PREVIEW_SERVER_SCRIPT = "preview-server.mjs";

/** The line the script prints once `listen()` has succeeded. Nothing else is a signal. */
export const PREVIEW_LISTEN_MARKER = "LARPABLE-PREVIEW-LISTENING";

/** Where a client asks for the file list. Reserved inside the build by a leading `__`. */
export const PREVIEW_MANIFEST_PATH = "/__larpable__/manifest.json";

/** Default port. High and unusual: the guest's own dev servers start at 5173. */
export const DEFAULT_PREVIEW_PORT = 8123;

/**
 * The server, as the guest will run it.
 *
 * Written as a string because it has to be a *file inside the guest*: the guest's Node
 * cannot import from the host bundle, and sending it over stdin would make every start
 * depend on stdin staying open.
 */
export function previewServerSource(): string {
  return `// Written by Larpable for the preview. Regenerated on every start; edits are lost.
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const port = Number(process.argv[2] ?? ${DEFAULT_PREVIEW_PORT});
const root = resolve(process.argv[3] ?? process.cwd());
const manifestPath = ${JSON.stringify(PREVIEW_MANIFEST_PATH)};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

function contentType(path) {
  const dot = extname(path).toLowerCase();
  return TYPES[dot] ?? "application/octet-stream";
}

/** Reject anything that leaves the publish directory; resolve() has already normalised it. */
function insideRoot(path) {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) ? true : rel === "";
}

async function walk(dir, prefix, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = prefix + "/" + entry.name;
    if (entry.isDirectory()) {
      await walk(full, rel, out);
    } else if (entry.isFile()) {
      const info = await stat(full);
      out.push({ path: rel, size: info.size });
    }
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === manifestPath) {
      const files = [];
      await walk(root, "", files);
      const body = JSON.stringify({ root, files });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }

    // Trailing slash means "the index of this directory", exactly as a static host does.
    const wanted = resolve(join(root, pathname));
    const target = pathname.endsWith("/") ? resolve(join(wanted, "index.html")) : wanted;
    if (!insideRoot(target)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("outside the publish directory");
      return;
    }

    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": contentType(target),
      "content-length": body.byteLength,
      "cache-control": "no-store",
    });
    response.end(body);
  } catch (error) {
    const code = error && error.code === "ENOENT" ? 404 : 500;
    if (!response.headersSent) {
      response.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end(code === 404 ? "not found" : String(error && error.message));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(\`${PREVIEW_LISTEN_MARKER} \${port} \${root}\`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
`;
}

/** A running guest server. */
export interface GuestPreviewServer {
  /** The port it answered on. */
  port: number;
  /** The directory it serves, guest-absolute. */
  root: string;
  /** Files the server reports, as `/`-prefixed paths relative to `root`. */
  listFiles(): Promise<{ path: string; size: number }[]>;
  /** Fetch one file's bytes as the server delivers them. */
  readFile(path: string): Promise<{ status: number; body: Uint8Array; contentType: string | null }>;
  /** Stop the server. Idempotent. */
  stop(): Promise<void>;
}

/** How the host reaches the server. Injected: the browser has a kernel, tests do not. */
export type GuestFetch = (url: string, init?: { method?: string }) => Promise<Response>;

export interface StartPreviewServerOptions {
  /** Directory to serve, guest-absolute or workspace-relative. Default `<workspace>/dist`. */
  root?: string;
  port?: number;
  /** How long to wait for the listen marker. The guest's `node` can be a first-use shim. */
  timeoutMs?: number;
  /** Extra argv, for a runtime that needs it (`node <script>` is the default). */
  command?: { file: string; args?: readonly string[] };
  /**
   * How to reach `127.0.0.1:<port>`. In the browser this is the kernel's HTTP client;
   * in a test it is a stub. Injected because the host that owns the guest also owns the
   * only way to talk to it, and this module must not assume either.
   */
  fetch?: GuestFetch;
}

/**
 * Write the script and start it.
 *
 * The barrier is the script's own listen marker rather than a sleep: a fixed delay either
 * wastes seconds on every build or is too short on the first, where the guest's `node`
 * shim may still be downloading the runtime. A process that *exits* before the marker is
 * a failure with its output attached, because "the preview stayed blank" is not a
 * diagnosis.
 */
export async function startPreviewServer(
  environment: ExecutionEnvironment,
  options: StartPreviewServerOptions = {},
): Promise<GuestPreviewServer> {
  const root = options.root
    ? joinGuestPath(environment.workspacePath, options.root)
    : joinGuestPath(environment.workspacePath, "dist");
  const port = options.port ?? DEFAULT_PREVIEW_PORT;
  const scriptPath = joinGuestPath(
    joinGuestPath(environment.workspacePath, PREVIEW_SERVER_DIR),
    PREVIEW_SERVER_SCRIPT,
  );

  await environment.createDirectory(
    joinGuestPath(environment.workspacePath, PREVIEW_SERVER_DIR),
  ).catch(() => undefined);
  await environment.writeFile(scriptPath, previewServerSource());

  const controller = new AbortController();
  const file = options.command?.file ?? "node";
  const argv = [...(options.command?.args ?? []), scriptPath, String(port), root];

  let output = "";
  let listening = false;
  let exited: ExecutionResult | null = null;

  const running = environment
    .executeArgv(file, argv, {
      cwd: environment.workspacePath,
      signal: controller.signal,
      timeoutMs: 0,
      onOutput: (chunk) => {
        output += chunk.text;
        if (chunk.text.includes(PREVIEW_LISTEN_MARKER)) listening = true;
      },
    })
    .then((result) => {
      exited = result;
      return result;
    })
    .catch((error: unknown) => {
      exited = {
        command: `${file} ${argv.join(" ")}`,
        argv: [file, ...argv],
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
        signal: null,
        durationMs: 0,
        truncated: false,
      };
      return exited;
    });

  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  // Read through a call: the assignment happens in a callback the compiler cannot see, so
  // a direct `exited !== null` would be narrowed to `never` and the failure message below
  // would be unreachable code that never type-checks.
  const exitedSoFar = (): ExecutionResult | null => exited;
  while (!listening) {
    const exit = exitedSoFar();
    if (exit !== null) {
      throw new Error(
        `The preview server exited before it was listening (exit ${String(exit.exitCode)}): ` +
          `${(exit.stderr + exit.stdout).trim() || "no output"}`,
      );
    }
    if (Date.now() > deadline) {
      controller.abort();
      await running.catch(() => undefined);
      throw new Error(
        `The preview server was not listening after ${String(options.timeoutMs ?? 120_000)} ms: ` +
          `${output.trim().split("\n").slice(-5).join(" | ") || "no output"}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  return {
    port,
    root,
    async listFiles() {
      const manifest = await fetchJson(`${baseUrl(port)}${PREVIEW_MANIFEST_PATH}`);
      return (manifest.files ?? []) as { path: string; size: number }[];
    },
    async readFile(path: string) {
      const response = await (options.fetch ?? globalThisFetch)(`${baseUrl(port)}${path}`, {
        method: "GET",
      });
      return {
        status: response.status,
        body: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type"),
      };
    },
    async stop() {
      controller.abort();
      await running.catch(() => undefined);
    },
  };

  // `listFiles` needs the injectable fetch too, but it runs after start; the closure keeps
  // that dependency explicit instead of reaching for a global that tests would have to
  // stub.
  async function fetchJson(url: string): Promise<{ files?: { path: string; size: number }[] }> {
    const response = await (options.fetch ?? globalThisFetch)(url, { method: "GET" });
    if (!response.ok) throw new Error(`manifest answered ${String(response.status)}`);
    return (await response.json()) as { files?: { path: string; size: number }[] };
  }
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

/** `fetch` in whatever environment this runs in, so a missing one fails loudly. */
const globalThisFetch: GuestFetch = (url, init) => {
  const implementation = (globalThis as { fetch?: GuestFetch }).fetch;
  if (implementation === undefined) {
    throw new Error("no global fetch; pass one in `StartPreviewServerOptions.fetch`");
  }
  return implementation(url, init);
};
