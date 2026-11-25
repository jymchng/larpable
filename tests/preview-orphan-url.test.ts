/**
 * A preview address opened on its own (docs/preview.md): it is not a page, so it must say so
 * instead of booting a Linux machine behind a URL that promised a preview.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import {
  isOrphanPreviewVisit,
  orphanPreviewMessage,
  renderOrphanPreviewVisit,
} from "../src/preview/orphan-url";

describe("isOrphanPreviewVisit", () => {
  it("is a preview address when nothing is controlling the document", () => {
    expect(isOrphanPreviewVisit("/__preview__/dev-6/", false)).toBe(true);
    expect(isOrphanPreviewVisit("/__preview__/dev-6/src/main.tsx", false)).toBe(true);
  });

  it("is not, while the pane's worker is answering the document", () => {
    // Inside the iframe the worker *does* control the document: that is a working preview.
    expect(isOrphanPreviewVisit("/__preview__/dev-6/", true)).toBe(false);
  });

  it("is not, for the app's own addresses", () => {
    expect(isOrphanPreviewVisit("/", false)).toBe(false);
    expect(isOrphanPreviewVisit("/__preview__", false)).toBe(false);
    expect(isOrphanPreviewVisit("/settings", false)).toBe(false);
  });
});

describe("orphanPreviewMessage", () => {
  it("names the session and says the id changes on every reload", () => {
    const message = orphanPreviewMessage("/__preview__/dev-6/");
    expect(message).toContain("not a page of its own");
    expect(message).toContain("`dev-6`");
    expect(message).toContain("changes every time the pane reloads");
    expect(message).toContain("Open Larpable");
  });

  it("says the same thing without inventing a session when the path has none", () => {
    const message = orphanPreviewMessage("/__preview__/");
    expect(message).not.toContain("``");
    expect(message).toContain("changes every time the pane reloads");
  });

  it("decodes a percent-encoded id rather than showing the escapes", () => {
    expect(orphanPreviewMessage("/__preview__/dev%2D6/")).toContain("`dev-6`");
  });
});

describe("renderOrphanPreviewVisit", () => {
  it("paints a heading, the sentence and one way back to the app", () => {
    const root = document.createElement("div");
    renderOrphanPreviewVisit(root, "/__preview__/dev-6/");

    const page = root.querySelector("[data-testid=preview-orphan]");
    expect(page).not.toBeNull();
    expect(root.textContent).toContain("This preview lives inside Larpable");
    expect(root.textContent).toContain("`dev-6`");
    const link = root.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/");
    expect(link?.textContent).toBe("Open Larpable");
  });

  it("replaces whatever was already in the root, so no half-booted app shows", () => {
    const root = document.createElement("div");
    root.innerHTML = "<div id='half-booted'>app</div>";
    renderOrphanPreviewVisit(root, "/__preview__/dev-1/");

    expect(root.querySelector("#half-booted")).toBeNull();
    expect(root.children).toHaveLength(1);
  });

  it("cannot be made to render markup from the path", () => {
    const root = document.createElement("div");
    // A preview id is percent-encoded by `previewBasePath`, but this page must never trust it.
    renderOrphanPreviewVisit(root, "/__preview__/%3Cimg%20src%3Dx%3E/");

    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x>");
  });
});
