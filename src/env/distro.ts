/**
 * The Linux userland is not inside the unkernel npm package: the kernel is, the
 * distribution image is not. Larpable therefore serves the image from its own
 * origin, and the app has to know whether that image has actually been fetched
 * before it offers to boot anything.
 *
 * `scripts/fetch-distros.ts` downloads exactly what this module reads, from the
 * release pinned to the installed unkernel version, and verifies size + SHA-256.
 */

export interface DistroEntry {
  name: string;
  file: string;
  size: number;
  sha256: string;
  image: string;
}

export interface DistroManifest {
  abi: number;
  base: string;
  distros: DistroEntry[];
}

export interface DistroAssetStatus {
  entry: DistroEntry;
  url: string;
  present: boolean;
  /** Bytes reported by the server, when it reports them. */
  bytes: number | null;
}

export interface DistroSummary {
  state: "loading" | "missing" | "ready" | "error";
  head: string;
  detail: string;
}

export const DISTRO_MANIFEST_URL = "/distros/distros.json";

/**
 * The distribution this app boots: Debian 13, not Alpine.
 *
 * Alpine was the obvious first choice (a 4 MB image boots in well under a second) and it
 * is what goals #1-#8 were measured against. It is also the reason `curl` could never
 * work there: the image's `/usr/local/bin/curl` is a first-use *shim*, `apk` cannot run
 * as the guest's uid 1000, and the only copy of a real static curl that could be staged
 * still lost to the shim on `PATH`. Debian 13 ships a real userland, and unkernel's own
 * demo page boots exactly this image, so the environment is the one path known to work
 * rather than a smaller one plus workarounds.
 *
 * Named once, because three things must agree: `scripts/fetch-distros.ts` downloads this
 * file, the manifest check below looks for this name, and `boot.ts` builds the URL from
 * it. A mismatch is the failure mode where the app offers to boot an image nobody fetched.
 */
export const DEFAULT_DISTRO_NAME = "debian";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class DistroError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DistroError";
  }
}

function isDistroEntry(value: unknown): value is DistroEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    typeof entry.file === "string" &&
    typeof entry.size === "number" &&
    typeof entry.sha256 === "string" &&
    typeof entry.image === "string"
  );
}

/** Read and validate the manifest. A malformed manifest is an error, not a guess. */
export async function loadDistroManifest(
  fetchImpl: FetchLike = fetch,
  url: string = DISTRO_MANIFEST_URL,
): Promise<DistroManifest> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new DistroError(
      `Could not read ${url}. Run \`bun run fetch:distros\` to download the Linux image.`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new DistroError(
      `${url} returned HTTP ${response.status}. Run \`bun run fetch:distros\` to download the Linux image.`,
    );
  }

  // A 200 is not proof of JSON. Static hosts with a single-page-app fallback answer a
  // missing `/distros/distros.json` with index.html and a 200, and the browser's own
  // error ("Unexpected token '<'") says nothing about the cause. Name the cause.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new DistroError(
      `${url} returned an HTML page, not the distro manifest — this deployment is missing public/distros/. ` +
        "The images are git-ignored, so the build must run `bun run fetch:distros` before `bun run build`. " +
        "If the site was deployed with the images, the browser replayed an older response: reload " +
        "bypassing the cache.",
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new DistroError(`${url} is not valid JSON. Run \`bun run fetch:distros\` to regenerate it.`, {
      cause,
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { distros?: unknown }).distros) ||
    !(parsed as { distros: unknown[] }).distros.every(isDistroEntry)
  ) {
    throw new DistroError(`${url} is not a distro manifest.`);
  }

  const manifest = parsed as DistroManifest;
  return { abi: manifest.abi, base: manifest.base, distros: manifest.distros };
}

/**
 * Ask the server which images are actually downloadable. A `HEAD` is enough: the
 * browser reads the image itself later with range requests, so this must not
 * download 4 MB just to answer "is it here?".
 */
export async function probeDistroAsset(
  entry: DistroEntry,
  fetchImpl: FetchLike = fetch,
  baseUrl = "/distros/",
): Promise<DistroAssetStatus> {
  const url = `${baseUrl}${entry.file}`;

  let response: Response;
  try {
    response = await fetchImpl(url, { method: "HEAD" });
  } catch (cause) {
    throw new DistroError(`Could not check ${url}`, { cause });
  }

  if (response.status === 404) {
    return { entry, url, present: false, bytes: null };
  }

  if (!response.ok) {
    throw new DistroError(`${url} returned HTTP ${response.status}`);
  }

  // The same trap as the manifest: an SPA fallback answers a missing image with
  // index.html and a 200. A 1 KB "image" would fail deep inside the kernel boot; report
  // it here as "not deployed" instead.
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    return { entry, url, present: false, bytes: null };
  }

  const length = Number(response.headers.get("content-length"));
  const bytes = Number.isFinite(length) && length > 0 ? length : null;

  return { entry, url, present: true, bytes };
}

export function summarizeDistro(
  statuses: readonly DistroAssetStatus[] | null,
  error: string | null,
  distroName: string = DEFAULT_DISTRO_NAME,
): DistroSummary {
  if (error) {
    return {
      state: "error",
      head: "Image unavailable",
      detail: error,
    };
  }

  if (!statuses) {
    return { state: "loading", head: "Checking Linux image", detail: "Reading the distro manifest." };
  }

  const wanted = statuses.find((status) => status.entry.name === distroName);
  if (!wanted) {
    // Say which image was wanted *and* which ones the manifest has: "no distro" and "the
    // wrong distro" have different fixes, and the manifest is written by the fetch script.
    const available = statuses.map((status) => status.entry.name).join(", ");
    return {
      state: "error",
      head: `No ${distroName} image listed`,
      detail:
        `The distro manifest lists ${available || "nothing"}, not ${distroName}, so there ` +
        `is nothing to boot. Run \`LARPABLE_DISTROS=${distroName} bun run fetch:distros\`.`,
    };
  }

  if (!wanted.present) {
    return {
      state: "missing",
      head: `${wanted.entry.image} not downloaded`,
      detail: "Run `bun run fetch:distros` to place the image in public/distros/.",
    };
  }

  const mebibytes = ((wanted.bytes ?? wanted.entry.size) / (1024 * 1024)).toFixed(1);
  return {
    state: "ready",
    head: `${wanted.entry.image} ready`,
    detail: `${mebibytes} MiB served from ${wanted.url}`,
  };
}
