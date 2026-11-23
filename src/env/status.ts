/**
 * Environment status shared by the environment manager, the agent and the UI.
 *
 * The lifecycle mirrors PRD §5.3: the agent must not run commands before the
 * environment reports `ready`, and the UI shows the same states the manager
 * transitions through, so a status line can never claim more than the manager
 * knows.
 */

export type EnvironmentStatus =
  | "idle"
  | "initializing"
  | "booting"
  | "ready"
  | "error"
  | "stopped";

export interface EnvironmentSnapshot {
  status: EnvironmentStatus;
  /** Guest runtime reported by the runtime manager, e.g. `bun 1.4.5`. */
  runtime: string | null;
  /** Distribution booted in the guest, e.g. `debian`. */
  distro: string | null;
  /** CPUs the guest actually got, and guest memory in MiB. */
  cpus: number | null;
  memoryMiB: number | null;
  /** Populated when `status` is `error`. */
  error: string | null;
}

export const INITIAL_ENVIRONMENT: EnvironmentSnapshot = {
  status: "idle",
  runtime: null,
  distro: null,
  cpus: null,
  memoryMiB: null,
  error: null,
};

const STATUS_LABELS: Record<EnvironmentStatus, string> = {
  idle: "Not started",
  initializing: "Initializing",
  booting: "Booting",
  ready: "Ready",
  error: "Error",
  stopped: "Stopped",
};

export function statusLabel(status: EnvironmentStatus): string {
  return STATUS_LABELS[status];
}

/** One-line summary for the status bar; never invents values it does not have. */
export function describeEnvironment(snapshot: EnvironmentSnapshot): string {
  const parts = [`Linux: ${statusLabel(snapshot.status)}`];

  if (snapshot.distro) parts.push(`Distro: ${snapshot.distro}`);
  if (snapshot.runtime) parts.push(`Runtime: ${snapshot.runtime}`);
  if (snapshot.cpus !== null) parts.push(`CPUs: ${snapshot.cpus}`);
  if (snapshot.memoryMiB !== null) parts.push(`Memory: ${snapshot.memoryMiB} MiB`);
  if (snapshot.error) parts.push(`Error: ${snapshot.error}`);

  return parts.join(" | ");
}
