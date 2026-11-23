/**
 * The preview controller, narrowed to the port the agent's tools receive (§9.3).
 *
 * `ToolContext.preview` is what `preview_site` calls: refresh the published build, read its
 * URL, read its phase. The controller already has exactly those three methods, so this file
 * is a type-level adapter and nothing more — and that is the point. Writing a second
 * implementation (a wrapper that tracked its own phase, say) would give the status bar and
 * the tool two different answers to "is the preview up".
 *
 * The adapter exists at all because the tool layer must not import the controller: a tool is
 * allowed to see a guest and four ports, never the object graph of the UI.
 */

import type { PreviewPort } from "@/agent/tools/types";
import type { PreviewController } from "@/preview/controller";

export function createPreviewPort(controller: PreviewController): PreviewPort {
  return {
    refresh: (buildId) => controller.refresh(buildId),
    url: () => controller.url(),
    phase: () => controller.phase(),
  };
}
