/**
 * The Netlify verdict, from the run that produced it to the segment that renders it.
 *
 * Before this existed, the status bar's Netlify segment was a hard-coded `{ kind: "unknown" }`
 * in `src/ui/App.tsx`: the agent could validate a `netlify.toml` and the bar would still say
 * "not validated" forever. The fix is a projection — `ensure`'s own result in, `NetlifyStatus`
 * out — and this file tests the projection rather than the pixels, because the pixels were
 * already asserted by `tests/status-bar.test.ts`.
 *
 * Two things are worth stating because they are the honest-but-subtle cases:
 *
 * - **A failure is not "unknown".** After a run that did not pass, the segment is red with the
 *   run's own reasons. Only "nothing has been attempted" is grey.
 * - **The reasons come from the file that was written.** Validation errors name concrete
 *   settings; a blocked sync has no file to validate, so its planner's reason is the sentence.
 */

import { describe, expect, it } from "vitest";

import { FakeEnvironment } from "@/env/fake-environment";
import { INITIAL_ENVIRONMENT } from "@/env/status";
import type { EnsureNetlifyConfigResult } from "@/netlify/flow";
import { createNetlifyPort, netlifyErrors, netlifyVerdict } from "@/ui/netlify-port";
import { deriveStatusSegments, type NetlifyStatus } from "@/ui/status-bar";

const PACKAGE = JSON.stringify({
  name: "site",
  scripts: { build: "vite build" },
  dependencies: { react: "^18" },
});

const VITE_REACT_TREE = {
  "package.json": PACKAGE,
  "vite.config.ts": "export default {};",
  "index.html": "<div id=app>",
  "src/main.tsx": "export {};",
};

async function environment(tree: Record<string, string>): Promise<FakeEnvironment> {
  const env = new FakeEnvironment({ tree });
  await env.initialize();
  return env;
}

/**
 * A result with only the fields the projection reads.
 *
 * The cast is deliberate: a hand-built `ProjectFacts` would be nine tenths fixture and one
 * tenth subject, and a test that accidentally asserted on the fixture would be worse than
 * this. The cases below are exactly the combinations `ensure` can produce.
 */
function synthetic(overrides: {
  ok: boolean;
  action?: "written" | "unchanged" | "preserved" | "blocked";
  reason?: string;
  issues?: readonly { severity: "error" | "warning"; message: string }[];
  summary?: string;
}): EnsureNetlifyConfigResult {
  return {
    ok: overrides.ok,
    facts: {},
    sync: {
      action: overrides.action ?? "written",
      path: "/workspace/netlify.toml",
      reason: overrides.reason ?? "",
    },
    validation: {
      ok: overrides.ok,
      issues: overrides.issues ?? [],
      settings: null,
      summary: overrides.summary ?? "validated",
    },
    decisions: [],
    path: "/workspace/netlify.toml",
  } as unknown as EnsureNetlifyConfigResult;
}

/** The status bar's Netlify segment for a verdict, with nothing else in the way. */
function netlifySegmentFor(netlify: NetlifyStatus) {
  const segments = deriveStatusSegments({
    environment: INITIAL_ENVIRONMENT,
    project: { name: null, root: "/workspace" },
    build: { kind: "none" },
    netlify,
    preview: { kind: "idle" },
  });
  const segment = segments.find((candidate) => candidate.key === "netlify");
  if (segment === undefined) throw new Error("the status bar has no Netlify segment");
  return segment;
}

describe("netlifyVerdict", () => {
  it("reports a passing run as `ok`, so the segment can be green", () => {
    expect(netlifyVerdict(synthetic({ ok: true }))).toEqual({ kind: "ok" });
    expect(netlifySegmentFor({ kind: "ok" })).toMatchObject({ value: "valid", tone: "green" });
  });

  it("carries every validation error, in the file's order", () => {
    const result = synthetic({
      ok: false,
      issues: [
        { severity: "error", message: "publish = \"build\" but the build wrote dist." },
        { severity: "warning", message: "no lockfile, so npm install instead of npm ci." },
        { severity: "error", message: "the catch-all redirect is shadowed by /app/*." },
      ],
    });

    expect(netlifyErrors(result)).toEqual([
      "publish = \"build\" but the build wrote dist.",
      "the catch-all redirect is shadowed by /app/*.",
    ]);
    expect(netlifyVerdict(result)).toEqual({
      kind: "invalid",
      errors: [
        "publish = \"build\" but the build wrote dist.",
        "the catch-all redirect is shadowed by /app/*.",
      ],
    });
    expect(netlifySegmentFor(netlifyVerdict(result))).toMatchObject({
      value: "2 errors",
      tone: "red",
    });
  });

  it("uses the planner's reason when the sync was blocked and there was no file to validate", () => {
    const result = synthetic({
      ok: false,
      action: "blocked",
      reason: "Nothing was written: no framework and no build script were found.",
      summary: "there is no netlify.toml at the project root",
    });

    expect(netlifyErrors(result)).toEqual([
      "Nothing was written: no framework and no build script were found.",
    ]);
  });

  it("falls back to the validator's own sentence when a failure names no issue", () => {
    const result = synthetic({
      ok: false,
      action: "preserved",
      summary: "the file has settings Larpable does not own, so validation was skipped",
    });

    expect(netlifyErrors(result)).toEqual([
      "the file has settings Larpable does not own, so validation was skipped",
    ]);
    expect(netlifyVerdict(result)).toEqual({
      kind: "invalid",
      errors: ["the file has settings Larpable does not own, so validation was skipped"],
    });
  });

  it("says nothing rather than inventing a reason for a passing run", () => {
    expect(netlifyErrors(synthetic({ ok: true }))).toEqual([]);
  });
});

describe("createNetlifyPort", () => {
  it("publishes the run's verdict, and publishes nothing before a run", async () => {
    const env = await environment(VITE_REACT_TREE);
    const verdicts: NetlifyStatus[] = [];
    const port = createNetlifyPort({
      environment: env,
      onVerdict: (verdict) => verdicts.push(verdict),
    });

    expect(verdicts).toEqual([]);

    const result = await port.ensure();

    expect(result.ok).toBe(true);
    expect(verdicts).toEqual([{ kind: "ok" }]);
  });

  it("reports a real failing run as invalid with the validator's reasons", async () => {
    // A tree with no package.json and no build script: the planner cannot justify a config.
    const env = await environment({ "README.md": "hello" });
    const verdicts: NetlifyStatus[] = [];
    const port = createNetlifyPort({
      environment: env,
      onVerdict: (verdict) => verdicts.push(verdict),
    });

    const result = await port.ensure();

    expect(result.ok).toBe(false);
    expect(verdicts).toHaveLength(1);
    const verdict = verdicts[0];
    expect(verdict?.kind).toBe("invalid");
    if (verdict?.kind === "invalid") {
      expect(verdict.errors.length).toBeGreaterThan(0);
      expect(verdict.errors.every((error) => error.length > 0)).toBe(true);
    }
    expect(netlifySegmentFor(verdict ?? { kind: "unknown" }).tone).toBe("red");
  });

  it("reads the build at call time, not at construction", async () => {
    const env = await environment(VITE_REACT_TREE);
    let builds = 0;
    const port = createNetlifyPort({
      environment: env,
      lastBuild: () => {
        builds += 1;
        return null;
      },
    });

    expect(builds).toBe(0);
    await port.ensure();
    expect(builds).toBe(1);
    await port.ensure();
    expect(builds).toBe(2);
  });
});
