/**
 * Dev or Prod: what the preview does, decided in one place and with no guest in sight.
 *
 * There are two honest ways to show a site, and they differ in *who runs the server*:
 *
 * - **dev** (the switch off): the user runs their own server — `bun run dev -- -p 1234` in the
 *   terminal — and the preview does nothing but attach to it on the port in Settings. No build,
 *   no static server of ours, no snapshot: a request for `localhost:1234/app` is forwarded to
 *   whatever is listening there, which is the whole point of previewing a dev server (hot
 *   reload, server routes, the app's real HTML).
 * - **prod** (the default, for now): the older behaviour. The project is built, its output
 *   directory is read out of the guest and served statically on the same port — the bytes that
 *   would ship.
 *
 * Both are needed because they answer different questions. A user editing a component wants the
 * dev server's response; a user checking what Netlify will serve wants the build output. Before
 * this module the product only had the second, so a project whose server ran on 1234 and a
 * preview that insisted on serving `dist/` on 1234 fought over the port.
 *
 * The decision is a value (`PreviewPlan`) so that the pane can say what the current choice means
 * — in the empty state's hint and in the reload arrow's tooltip — without asking the controller,
 * and so a test can assert "Prod off builds nothing" by reading a plan rather than by reading
 * prose. Running the plan is `src/preview/controller.ts` (which attaches or publishes) and
 * `src/ui/build-controller.ts` (which builds), each of which already owns its own half.
 */

/** Which of the two previews a plan describes. */
export type PreviewMode = "dev" | "prod";

/** One thing a plan asks for, in the order it has to happen. */
export type PreviewStep = "build" | "serve" | "attach";

/** What the preview will do, as data. */
export interface PreviewPlan {
  mode: PreviewMode;
  /** The guest port the preview attaches to (dev) or serves on (prod). */
  port: number;
  /** The directory a prod preview reads. Carried for messages; unused in dev. */
  buildDirectory: string;
  /** The steps, in order. Both modes name at least one. */
  steps: readonly PreviewStep[];
}

/** Just the two fields the decision depends on, so a test needs no whole settings object. */
export interface PreviewChoice {
  prod: boolean;
  port: number;
  buildDirectory?: string;
}

/**
 * The plan for a settings pair.
 *
 * Prod is `build` then `serve`, in that order and not the other way round: serving before the
 * build has finished is how a preview shows the previous build's bytes under the new build's
 * URL, which is the one failure mode `routing.ts` spends a whole section preventing. Dev is
 * `attach` alone — deliberately not `["attach", "serve"]` or anything defensive: a step that
 * does not belong to the mode is not in the plan, so it cannot be run by accident.
 */
export function previewPlan(choice: PreviewChoice): PreviewPlan {
  const buildDirectory = choice.buildDirectory ?? "dist";
  return choice.prod
    ? { mode: "prod", port: choice.port, buildDirectory, steps: ["build", "serve"] }
    : { mode: "dev", port: choice.port, buildDirectory, steps: ["attach"] };
}

/** One sentence naming what the mode does, for the pane's own hint and tooltip. */
export function describePreviewMode(plan: PreviewPlan): string {
  return plan.mode === "prod"
    ? `Serving the built ${plan.buildDirectory} statically on port ${String(plan.port)}.`
    : `Attaching to whatever answers on guest port ${String(plan.port)} — no build, and no server of the preview's own.`;
}

/** True when the mode reads a build at all. The hammer is only useful in that mode. */
export function modeBuilds(plan: PreviewPlan): boolean {
  return plan.steps.includes("build");
}
