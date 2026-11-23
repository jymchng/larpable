/**
 * What build the preview is about to show, decided on the host, from the guest's output.
 *
 * The preview URL contains a build id (`/__preview__/b-7f3a/…`), and everything downstream
 * depends on that id being *true*: the service worker refuses a request whose id is not the
 * current one (`409`), the proxy refuses it before it reaches the guest, and the iframe's
 * `key` changes when the id changes. An id that stays the same across a rebuild would make
 * the stale-build protection useless — the pane would show old bytes under a fresh-looking
 * label — and an id that changes on every keystroke would reload the iframe for nothing.
 *
 * So the id is derived from the publish directory itself:
 *
 * - **the full recursive listing**, with sizes. A build tool that hashes its output — Vite,
 *   Next, Astro, Parcel — renames every asset whose bytes changed, and a tool that does not
 *   still changes a size when a byte changes. Either way a rebuilt site produces a different
 *   listing.
 * - **not the mtimes**, even though they are the obvious signal: a guest clock can jump, a
 *   checkout resets them, and two different builds can carry identical timestamps.
 * - **not the file contents**, because reading every file twice (once to hash, once over
 *   HTTP for the snapshot) doubles the cost of publishing a build for no extra protection:
 *   the realistic change that survives a listing check is "same paths, same sizes, different
 *   bytes", which is not what a site build produces.
 *
 * This is a *fallback*. When the app knows the real build id — `BuildResult.id` from
 * `src/build/manager.ts` — it passes it in and none of this runs.
 */

import type { ExecutionEnvironment } from "@/env/execution";

/** One file of the publish directory, `/`-prefixed so it is also a preview URL path. */
export interface PublishFile {
  path: string;
  size: number;
}

/**
 * The id for a publish directory listing, or null when there is nothing to preview.
 *
 * `b-` prefix plus a 32-bit FNV-1a hash in base 36: short enough for a URL, wide enough
 * that the two builds a user is likely to compare in one session cannot collide. The
 * prefix exists because the id is also a path segment, and a purely numeric one looks like
 * a sequence (`/__preview__/17/…`), which invites reading it as "build number 17".
 */
export function deriveBuildId(files: readonly PublishFile[]): string | null {
  if (files.length === 0) return null;

  // Sorted, so the same build directory produces the same id regardless of the order the
  // guest's filesystem hands entries back in.
  const listing = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let hash = 0x811c9dc5;
  for (const file of listing) {
    const line = `${file.path}:${String(file.size)}\n`;
    for (let index = 0; index < line.length; index += 1) {
      hash ^= line.charCodeAt(index);
      // FNV's 32-bit prime, as a multiply that stays inside a 32-bit integer.
      hash = Math.imul(hash, 0x01000193);
    }
  }

  const unsigned = hash >>> 0;
  return `b-${unsigned.toString(36).padStart(7, "0")}`;
}

/**
 * Every file under the publish directory, as preview paths.
 *
 * Read through `ExecutionEnvironment.listFiles()` — the same 9p-mounted view the rest of
 * the app uses — rather than by running `find` in the guest: a command would be another
 * thing that can be missing, need quoting, or print a format we then parse.
 *
 * A missing or unreadable directory returns an empty list rather than throwing. "There is
 * no build" is the state the pane has to explain (`state.kind: "idle"` / a 404 message), and
 * an exception here would turn a first-run empty project into an error dialog.
 */
export async function listPublishFiles(
  environment: ExecutionEnvironment,
  root = "dist",
): Promise<PublishFile[]> {
  const files: PublishFile[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await environment.listFiles(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.kind === "directory") {
        await walk(entry.path, `${prefix}${entry.name}/`);
      } else if (entry.kind === "file") {
        files.push({ path: `${prefix}${entry.name}`, size: entry.size });
      }
      // Symlinks are skipped: a vite build can emit them, and following one out of the
      // publish directory would put a path in the manifest that the guest's server
      // (which serves only its own root) would then answer 404 for.
    }
  }

  await walk(root, "/");
  return files;
}
