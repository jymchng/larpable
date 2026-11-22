/**
 * A real round-trip check of a booted environment.
 *
 * "The VM booted" is a claim; this turns it into evidence a person or a test can read:
 * the guest's kernel is the one it says it is, a file written from the host is visible
 * to Linux, and a file written by Linux is readable from the host. That is the whole
 * 9p mount working in both directions, which is what every later feature depends on.
 *
 * It is part of the product, not the test suite: the diagnostics panel runs it, so a
 * user whose boot misbehaves can see which half failed.
 *
 * Every step is reported separately and failures are captured rather than thrown: a
 * step that throws must not hide the results of the steps that already passed.
 */

import type { ExecutionEnvironment } from "./execution";

export type SelfTestStepName = "guest-shell" | "host-to-guest" | "guest-to-host";

export interface SelfTestStep {
  name: SelfTestStepName;
  /** One line for the UI, e.g. "Write from the host, read in Linux". */
  label: string;
  ok: boolean;
  /** The measured value on success, the error text on failure. */
  detail: string;
}

export interface SelfTestResult {
  ok: boolean;
  steps: SelfTestStep[];
  durationMs: number;
  /** `uname -a` output when the guest answered, else null. */
  uname: string | null;
}

export interface SelfTestOptions {
  /** Workspace-relative directory for the probe files. Default `.larpable`. */
  directory?: string;
  /** Budget per command. Default 30 s: a booted guest answers in milliseconds. */
  timeoutMs?: number;
  /** Marker written into the probe files. Default: random, so stale files cannot pass. */
  token?: string;
  /** Injectable clock, so durations are deterministic in tests. */
  now?: () => number;
}

const DEFAULT_DIRECTORY = ".larpable";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A marker that is safe inside a single-quoted shell word and in a URL-free path.
 * Generated per run so a file left by an earlier run cannot make the test pass.
 */
function freshToken(now: () => number): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `larpable-${now().toString(36)}-${random}`.replace(/[^a-z0-9-]/g, "");
}

function controllerOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runEnvironmentSelfTest(
  environment: ExecutionEnvironment,
  options: SelfTestOptions = {},
): Promise<SelfTestResult> {
  const directory = (options.directory ?? DEFAULT_DIRECTORY).replace(/^\/+|\/+$/g, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const token = options.token ?? freshToken(now);
  const started = now();

  // Guest-absolute paths, because the commands run in the guest's shell.
  const hostToGuestPath = `${environment.workspacePath}/${directory}/host-to-guest.txt`;
  const guestToHostPath = `${environment.workspacePath}/${directory}/guest-to-host.txt`;

  const steps: SelfTestStep[] = [];
  let uname: string | null = null;

  try {
    const result = await environment.execute("uname -a", { timeoutMs });
    const output = result.stdout.trim();
    const ok = result.exitCode === 0 && output.length > 0;
    if (ok) uname = output;
    steps.push({
      name: "guest-shell",
      label: "Run a command in the guest",
      ok,
      detail: ok
        ? output
        : `uname -a exited ${String(result.exitCode)}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
    });
  } catch (error) {
    steps.push({
      name: "guest-shell",
      label: "Run a command in the guest",
      ok: false,
      detail: controllerOf(error),
    });
  }

  try {
    await environment.writeFile(hostToGuestPath, token);
    const readBack = await environment.execute(`cat ${hostToGuestPath}`, { timeoutMs });
    const seen = readBack.stdout.trim();
    const ok = readBack.exitCode === 0 && seen === token;
    steps.push({
      name: "host-to-guest",
      label: "Write from the host, read in Linux",
      ok,
      detail: ok
        ? `${hostToGuestPath} arrived intact`
        : `Linux read ${JSON.stringify(seen)} instead of ${JSON.stringify(token)}` +
          (readBack.stderr.trim() ? ` (${readBack.stderr.trim()})` : ""),
    });
  } catch (error) {
    steps.push({
      name: "host-to-guest",
      label: "Write from the host, read in Linux",
      ok: false,
      detail: controllerOf(error),
    });
  }

  try {
    const written = await environment.execute(
      `mkdir -p ${environment.workspacePath}/${directory} && printf '%s' '${token}g' > ${guestToHostPath}`,
      { timeoutMs },
    );
    if (written.exitCode !== 0) {
      throw new Error(`guest write exited ${String(written.exitCode)}: ${written.stderr.trim()}`);
    }
    const bytes = await environment.readFile(guestToHostPath);
    const seen = new TextDecoder().decode(bytes).trim();
    const expected = `${token}g`;
    const ok = seen === expected;
    steps.push({
      name: "guest-to-host",
      label: "Write in Linux, read on the host",
      ok,
      detail: ok
        ? `${guestToHostPath} arrived intact`
        : `the host read ${JSON.stringify(seen)} instead of ${JSON.stringify(expected)}`,
    });
  } catch (error) {
    steps.push({
      name: "guest-to-host",
      label: "Write in Linux, read on the host",
      ok: false,
      detail: controllerOf(error),
    });
  }

  return {
    ok: steps.every((step) => step.ok),
    steps,
    durationMs: now() - started,
    uname,
  };
}
