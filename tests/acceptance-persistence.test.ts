/**
 * The persistence acceptance run's decisions, as tests.
 *
 * `scripts/browser-acceptance.ts` asks three questions it cannot answer by looking: did the
 * project reach the store, did the guest's bytes match the host's, and did the files come back
 * after a reload. Each answer is a rule about a string — the panel's "Saved 3 s ago", the guest's
 * `LARPABLE-SIZE` line, the read-back transcript — so each is tested here with the strings a run
 * actually produces, and the script only assembles the facts.
 *
 * The case worth naming: a fresh save is not the same as *a* save. Creating a project saves
 * immediately, so a run that reloads on the strength of "Saved just now" could be looking at the
 * creation save and lose the files written afterwards. `isFreshSave` is that distinction, and the
 * test that fails when it is loosened is "refuses a save that predates the writes".
 */

import { describe, expect, it } from "vitest";

import {
  READ_MARKER,
  isFreshSave,
  persistToken,
  persistenceChecks,
  persistenceSkipReason,
  persistedFiles,
  readCommand,
  savedAgeSeconds,
  type PersistenceFacts,
} from "../scripts/lib/persist-check.ts";

const TOKEN = persistToken(1_700_000_000_000);

function facts(overrides: Partial<PersistenceFacts> = {}): PersistenceFacts {
  const files = persistedFiles(TOKEN);
  const guestBytes: Record<string, number | null> = {};
  const readAfterReload: Record<string, string> = {};
  for (const file of files) {
    guestBytes[file.path] = file.bytes;
    readAfterReload[file.path] = `\u21d2 cat ${file.path}\r\n${file.content.split("\n")[0]}`;
  }
  return {
    projectName: "persist-abc123",
    files,
    rowsBeforeReload: ["my-site", "persist-abc123"],
    guestBytes,
    saveConfirmed: true,
    readAfterReload,
    rowsAfterReload: ["my-site", "persist-abc123"],
    activeAfterReload: "persist-abc123",
    ...overrides,
  };
}

describe("the token and the fixture", () => {
  it("builds a lower-case token that is safe in a shell word, a file name and a TOML comment", () => {
    // 1_700_000_000_000 in base36, pinned so a change of radix or case is a failing test.
    expect(TOKEN).toBe("larpable-persist-loyw3v28");
    expect(TOKEN).toMatch(/^[a-z0-9-]+$/);
  });

  it("writes a project file and a netlify.toml, each with its own mark", () => {
    const files = persistedFiles(TOKEN);
    expect(files.map((file) => file.path)).toEqual(["persist-check.txt", "netlify.toml"]);

    const [project, netlify] = files;
    expect(project!.marker).toBe(`${TOKEN}-file`);
    expect(netlify!.marker).toBe(`${TOKEN}-toml`);
    // Per-file marks, so the previous file's token still on screen cannot satisfy the next read.
    expect(project!.marker).not.toBe(netlify!.marker);
    expect(netlify!.content).toContain("[build]");
    expect(netlify!.content).toContain('publish = "dist"');
  });

  it("counts the bytes each file will occupy, so the guest's `wc -c` can be held to them", () => {
    for (const file of persistedFiles(TOKEN)) {
      expect(file.bytes).toBe(Buffer.byteLength(file.content, "utf8"));
      expect(file.bytes).toBeGreaterThan(0);
    }
  });

  it("ends a read-back with a marker, so a truncated `cat` cannot look like an absent file", () => {
    expect(readCommand("netlify.toml")).toBe(`cat netlify.toml; printf '%s\\n' '${READ_MARKER}'`);
  });
});

describe("the panel's save sentence", () => {
  it("decodes the buckets the panel prints", () => {
    expect(savedAgeSeconds("Saved just now")).toBe(0);
    expect(savedAgeSeconds("Saved 3 s ago")).toBe(3);
    expect(savedAgeSeconds("Saved 2 min ago")).toBe(120);
    expect(savedAgeSeconds("Saved 1 h ago")).toBe(3_600);
  });

  it("ignores the project name the panel appends after a middot", () => {
    expect(savedAgeSeconds("Saved just now \u00b7 persist-abc123")).toBe(0);
    expect(savedAgeSeconds("Saved 4 s ago \u00b7 persist-abc123")).toBe(4);
  });

  it("returns null for the states that are not a completed save", () => {
    expect(savedAgeSeconds("Saving\u2026 \u00b7 persist-abc123")).toBeNull();
    expect(savedAgeSeconds("Unsaved changes")).toBeNull();
    expect(savedAgeSeconds("Not saved yet")).toBeNull();
    expect(savedAgeSeconds("No project is open")).toBeNull();
    expect(savedAgeSeconds(null)).toBeNull();
  });

  it("accepts a save that finished after the writes", () => {
    expect(isFreshSave("Saved just now \u00b7 persist-abc123")).toBe(true);
    expect(isFreshSave("Saved 2 s ago \u00b7 persist-abc123")).toBe(true);
  });

  it("refuses a save that predates the writes \u2014 the creation save is not evidence", () => {
    expect(isFreshSave("Saved 12 s ago \u00b7 persist-abc123")).toBe(false);
    expect(isFreshSave("Saving\u2026 \u00b7 persist-abc123")).toBe(false);
    expect(isFreshSave(null)).toBe(false);
  });
});

describe("persistenceChecks", () => {
  it("passes every check on a run that really persisted both files", () => {
    const checks = persistenceChecks(facts());
    expect(checks.map((check) => check.name)).toEqual([
      "persistence: project created through the panel",
      "persistence: /workspace/persist-check.txt holds the bytes the host sent",
      "persistence: /workspace/netlify.toml holds the bytes the host sent",
      "persistence: a save finished after the guest's writes",
      "persistence: /workspace/persist-check.txt survived a full page reload",
      "persistence: /workspace/netlify.toml survived a full page reload",
      "persistence: the reloaded app still lists the project, and it is the open one",
    ]);
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it("fails when the panel never showed the project, and says what it did show", () => {
    const checks = persistenceChecks(facts({ rowsBeforeReload: ["my-site"] }));
    const created = checks[0]!;
    expect(created.ok).toBe(false);
    expect(created.detail).toContain("my-site");
  });

  it("fails when no save finished after the writes, even though the project was created", () => {
    // The creation save lists the project, so every other check can be satisfied by writing the
    // bytes into a workspace the reload throws away. This check is what says so.
    const stale = persistenceChecks(facts({ saveConfirmed: false }));
    const saved = stale.find((check) => check.name.includes("a save finished"))!;
    expect(saved.ok).toBe(false);
    expect(saved.detail).toContain("no save finished after the writes");
  });

  it("fails when the guest stored a truncated file, quoting both counts", () => {
    const files = persistedFiles(TOKEN);
    const checks = persistenceChecks(
      facts({ guestBytes: { [files[0]!.path]: 12, [files[1]!.path]: files[1]!.bytes } }),
    );
    const truncated = checks.find((check) => check.name.includes("persist-check.txt holds"))!;
    expect(truncated.ok).toBe(false);
    expect(truncated.detail).toContain("12 bytes");
    expect(truncated.detail).toContain(`${files[0]!.bytes} bytes`);
  });

  it("fails when the guest never answered the byte count", () => {
    const files = persistedFiles(TOKEN);
    const checks = persistenceChecks(
      facts({ guestBytes: { [files[0]!.path]: null, [files[1]!.path]: files[1]!.bytes } }),
    );
    expect(checks.find((check) => check.name.includes("persist-check.txt holds"))!.detail).toContain(
      "the guest never answered",
    );
  });

  it("fails the reload check when the read-back is missing, the token is absent, or it is only the command echo", () => {
    const files = persistedFiles(TOKEN);
    const [project, netlify] = files;

    const missing = persistenceChecks(facts({ readAfterReload: { [netlify!.path]: netlify!.content } }));
    const projectCheck = missing.find((check) => check.name.includes("persist-check.txt survived"))!;
    expect(projectCheck.ok).toBe(false);
    expect(projectCheck.detail).toContain("transcript tail: (empty)");

    // The typed `cat` command names the path but never the token, so an echo-only transcript
    // must fail: this is the "answered by its own instruction" failure the pty channel exists for.
    const echoed = persistenceChecks(
      facts({
        readAfterReload: {
          [project!.path]: `\u21d2 cat ${project!.path}; printf '%s\\n' '${READ_MARKER}'`,
          [netlify!.path]: netlify!.content,
        },
      }),
    );
    expect(echoed.find((check) => check.name.includes("persist-check.txt survived"))!.ok).toBe(false);
  });

  it("fails the panel check when the project is listed but is not the open one", () => {
    const checks = persistenceChecks(facts({ activeAfterReload: "my-site" }));
    const panel = checks.at(-1)!;
    expect(panel.ok).toBe(false);
    expect(panel.detail).toContain("open project: my-site");
  });

  it("fails the panel check when the reload lost the project altogether", () => {
    const checks = persistenceChecks(facts({ rowsAfterReload: ["my-site"], activeAfterReload: "my-site" }));
    const panel = checks.at(-1)!;
    expect(panel.ok).toBe(false);
    expect(panel.detail).toContain("rows after the reload: my-site");
  });
});

describe("persistenceSkipReason", () => {
  it("runs when the app rendered the projects control", () => {
    expect(persistenceSkipReason(1, false)).toBeNull();
    expect(persistenceSkipReason(1, true)).toBeNull();
  });

  it("names a deploy's age against a deployment, and a missing panel against a dev server", () => {
    expect(persistenceSkipReason(0, true)).toContain("predates the panel");
    expect(persistenceSkipReason(0, false)).toContain("no projects control");
  });
});
