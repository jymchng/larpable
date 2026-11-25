/**
 * What the Prod switch means, as a value.
 *
 * The switch is one bit, but it decides four things: whether the project is built, whether a
 * static server is started, what the preview is pointed at, and what the pane says. `mode.ts`
 * turns the bit into a plan, and these tests assert the plan — because "Prod off builds nothing"
 * is a claim about behaviour, and a claim about behaviour should be a value a test can read
 * rather than a sentence in a comment.
 */

import { describe, expect, it } from "vitest";

import { describePreviewMode, modeBuilds, previewPlan } from "../src/preview/mode";

describe("previewPlan", () => {
  it("attaches and nothing else when Prod is off", () => {
    const plan = previewPlan({ prod: false, port: 1234 });

    expect(plan.mode).toBe("dev");
    expect(plan.port).toBe(1234);
    // The whole point of the mode: no build step and no static server of the preview's own. A
    // defensive `["attach", "serve"]` would be a plan that starts a server on a port the user's
    // own server already holds.
    expect(plan.steps).toEqual(["attach"]);
    expect(modeBuilds(plan)).toBe(false);
  });

  it("builds before it serves when Prod is on", () => {
    const plan = previewPlan({ prod: true, port: 5173, buildDirectory: "build" });

    expect(plan.mode).toBe("prod");
    expect(plan.buildDirectory).toBe("build");
    // Order, not just membership: serving before the build finishes is how a preview shows the
    // previous build's bytes under the new build's URL.
    expect(plan.steps).toEqual(["build", "serve"]);
    expect(modeBuilds(plan)).toBe(true);
  });

  it("carries the same port into both modes, because one number is what a person means", () => {
    expect(previewPlan({ prod: false, port: 3000 }).port).toBe(3000);
    expect(previewPlan({ prod: true, port: 3000 }).port).toBe(3000);
  });

  it("names `dist` when no directory is given, rather than an empty one", () => {
    expect(previewPlan({ prod: true, port: 5173 }).buildDirectory).toBe("dist");
  });
});

describe("describePreviewMode", () => {
  it("says which server answers, in the mode's own words", () => {
    const dev = describePreviewMode(previewPlan({ prod: false, port: 1234 }));
    expect(dev).toContain("1234");
    // Dev is now the mode that *runs* something: the project's own script, whose output is then
    // what the pane shows. The old sentence said only that it attached, which was true when the
    // pane expected a server the user had already started and misleading once it did not.
    expect(dev).toContain("dev or start script");
    expect(dev).toContain("serves");
    expect(dev).toContain("no build");

    const prod = describePreviewMode(previewPlan({ prod: true, port: 1234, buildDirectory: "out" }));
    expect(prod).toContain("out");
    expect(prod).toContain("1234");
  });
});
