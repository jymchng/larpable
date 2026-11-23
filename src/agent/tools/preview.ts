/**
 * Preview tools (PRD §9.3, "Preview"; §12 for the pipeline).
 *
 * The preview controller is the only thing that knows whether a build is actually being
 * served, so the tool asks it rather than describing an intention. That matters for
 * honesty: "the preview is up" is a claim about a service worker holding a specific build
 * id, and `publish_preview` reports the phase the controller reached — `ready` with a
 * build id, or `failed` with the reason — not the fact that it was called.
 */

import { clampText, defineTool, failure, success, type AgentTool } from "./types";
import type { PreviewPhase } from "@/preview/controller";

/** One sentence a model can act on, per phase. */
function describe(phase: PreviewPhase): string {
  switch (phase.kind) {
    case "idle":
      return "The preview is idle: nothing has been published yet.";
    case "starting":
      return `The preview is starting the guest's server: ${phase.detail}`;
    case "publishing":
      return `The preview is publishing build ${phase.buildId}: ${phase.detail}`;
    case "ready":
      return [
        `The preview is serving build ${phase.buildId} at ${phase.url} (${String(phase.files)} files, held by the ${phase.served === "worker" ? "service worker" : "guest"}).`,
        phase.note ?? "",
      ]
        .filter((line) => line.length > 0)
        .join(" ");
    case "failed":
      return `The preview failed: ${phase.message}`;
  }
}

export const publishPreviewTool: AgentTool = defineTool(
  {
    name: "publish_preview",
    description:
      "Publish the current build output to the preview pane and report the URL, or why it " +
      "could not be served. Call it after a successful build; a failed publish must be " +
      "reported to the user rather than described as working.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "publish_preview arguments",
      properties: {
        buildId: {
          type: "string",
          description: "Build id from build_project, so the preview is labelled with it.",
        },
      },
      required: [],
    },
  },
  async (args, context) => {
    if (context.preview === null) {
      return failure(
        "This run has no preview controller, so nothing was published. Do not tell the user the site is previewable.",
      );
    }

    const buildId = typeof args.buildId === "string" && args.buildId.length > 0 ? args.buildId : undefined;
    let phase: PreviewPhase;
    try {
      phase = await context.preview.refresh(buildId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure(`The preview could not be published: ${message}`);
    }

    const body = clampText(describe(phase));
    const data = {
      kind: phase.kind,
      ...(phase.kind === "ready" ? { buildId: phase.buildId, url: phase.url, files: phase.files } : {}),
    };
    return phase.kind === "ready" ? success(body, data) : failure(body, data);
  },
);

export const previewStatusTool: AgentTool = defineTool(
  {
    name: "preview_status",
    description: "Report what the preview pane is currently showing, without changing it.",
    readOnly: true,
    parameters: {
      type: "object",
      description: "preview_status arguments",
      properties: {},
      required: [],
    },
  },
  async (_args, context) => {
    if (context.preview === null) return success("This run has no preview controller, so there is no preview.");
    const phase = context.preview.phase();
    return success(describe(phase), { kind: phase.kind, url: context.preview.url() });
  },
);

export const PREVIEW_TOOLS: readonly AgentTool[] = [publishPreviewTool, previewStatusTool];
