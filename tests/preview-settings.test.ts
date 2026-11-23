/**
 * The preview settings' rules, before any of them reach a server.
 *
 * The point of testing this module rather than the panel is that every rule here is one a
 * keystroke can break: a port that is not a number, a directory that walks out of the
 * workspace, a stored value from a future version. Each one has a single honest answer, and
 * the answer is what keeps a half-typed field from becoming a running server's address.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUILD_DIRECTORY,
  DEFAULT_PREVIEW_SETTINGS_PORT,
  PREVIEW_HOST,
  PREVIEW_SETTINGS_STORAGE_KEY,
  baseUrlFor,
  defaultPreviewSettings,
  draftOf,
  draftProblem,
  normaliseBuildDirectory,
  parsePort,
  parseStoredPreviewSettings,
  serializePreviewSettings,
  settingsFromDraft,
  withBuildDirectory,
  withPort,
} from "../src/ui/preview-settings";

const defaults = defaultPreviewSettings();

describe("the defaults", () => {
  it("are Vite's port and `dist`, so the numbers a web developer already knows work", () => {
    expect(DEFAULT_PREVIEW_SETTINGS_PORT).toBe(5173);
    expect(DEFAULT_BUILD_DIRECTORY).toBe("dist");
    expect(defaults).toEqual({ port: 5173, buildDirectory: "dist", prod: false });
  });

  it("name a host that cannot be configured, only painted", () => {
    expect(PREVIEW_HOST).toBe("localhost");
    expect(baseUrlFor(defaults)).toBe("http://localhost:5173");
    expect(baseUrlFor({ port: 8080, buildDirectory: "build", prod: false })).toBe("http://localhost:8080");
  });

  it("draft the fields from the settings, so the inputs show the live pair", () => {
    expect(draftOf(defaults)).toEqual({ port: "5173", buildDirectory: "dist" });
  });
});

describe("the port", () => {
  it("is a number between 1 and 65535", () => {
    expect(parsePort("5173")).toBe(5173);
    expect(parsePort(" 80 ")).toBe(80);
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("")).toBeNull();
    expect(parsePort("81 73")).toBeNull();
    expect(parsePort("8o80")).toBeNull();
    expect(parsePort("-1")).toBeNull();
    expect(parsePort("5173.5")).toBeNull();
  });

  it("keeps the last good number while the field holds something that is not one", () => {
    // The hazard: an empty or malformed field must not start a server somewhere unintended.
    expect(withPort(defaults, "")).toBe(defaults);
    expect(withPort(defaults, "0")).toBe(defaults);
    expect(withPort(defaults, "5173x")).toBe(defaults);
    expect(withPort(defaults, "  ")).toBe(defaults);
    // A valid number replaces it, including a valid prefix: `5` *is* a port, and a field that
    // says 5 should not quietly mean 5173.
    expect(withPort(defaults, "5173")).toBe(defaults);
    expect(withPort(defaults, "8080")).toEqual({ port: 8080, buildDirectory: "dist" });
    expect(withPort(defaults, "5")).toEqual({ port: 5, buildDirectory: "dist" });
  });
});

describe("the build directory", () => {
  it("is workspace-relative and normalised, so `./build/` and `build` are one folder", () => {
    expect(normaliseBuildDirectory("build")).toBe("build");
    expect(normaliseBuildDirectory("./build/")).toBe("build");
    expect(normaliseBuildDirectory("  out/prod  ")).toBe("out/prod");
    expect(normaliseBuildDirectory("")).toBe("");
    expect(normaliseBuildDirectory("   ")).toBe("");
  });

  it("refuses a path that leaves the workspace rather than reinterpreting it", () => {
    expect(normaliseBuildDirectory("/etc")).toBe("");
    expect(normaliseBuildDirectory("../elsewhere")).toBe("");
    expect(normaliseBuildDirectory("dist/../../etc")).toBe("");
    expect(normaliseBuildDirectory("~/build")).toBe("");
    expect(normaliseBuildDirectory("dist//build")).toBe("");
  });

  it("keeps the last good folder while a new one is being typed", () => {
    expect(withBuildDirectory(defaults, "")).toBe(defaults);
    expect(withBuildDirectory(defaults, "/nope")).toBe(defaults);
    expect(withBuildDirectory(defaults, "dist")).toBe(defaults);
    expect(withBuildDirectory(defaults, "build/")).toEqual({
      port: 5173,
      buildDirectory: "build",
    });
  });
});

describe("the draft and the settings are different things", () => {
  it("adopts each field independently, so fixing one keeps the other", () => {
    const next = settingsFromDraft(defaults, { port: "8080", buildDirectory: "build" });
    expect(next).toEqual({ port: 8080, buildDirectory: "build" });

    const halfTyped = settingsFromDraft(defaults, { port: "", buildDirectory: "build" });
    expect(halfTyped).toEqual({ port: 5173, buildDirectory: "build" });
  });

  it("says what is wrong in the panel's own words, and nothing when it is right", () => {
    expect(draftProblem({ port: "5173", buildDirectory: "dist" })).toBeNull();
    expect(draftProblem({ port: "", buildDirectory: "dist" })).toBe(
      "The port must be a number between 1 and 65535.",
    );
    expect(draftProblem({ port: "5173", buildDirectory: "../x" })).toBe(
      "The build directory must be a folder inside the project, such as `dist` or `build`.",
    );
  });
});

describe("storage", () => {
  it("round-trips a pair", () => {
    const settings = { port: 3000, buildDirectory: "build", prod: true };
    expect(parseStoredPreviewSettings(serializePreviewSettings(settings))).toEqual(settings);
  });

  it("answers the defaults for nothing, for garbage, and for another shape", () => {
    expect(parseStoredPreviewSettings(null)).toEqual(defaults);
    expect(parseStoredPreviewSettings("not json")).toEqual(defaults);
    expect(parseStoredPreviewSettings("[]")).toEqual(defaults);
    expect(parseStoredPreviewSettings('{"port":"5173"}')).toEqual(defaults);
  });

  it("keeps the field that is still usable when the other one is not", () => {
    // A stored port that is no longer a number must not wipe the user's build directory.
    expect(parseStoredPreviewSettings('{"port":0,"buildDirectory":"build"}')).toEqual({
      port: 5173,
      buildDirectory: "build",
    });
    expect(parseStoredPreviewSettings('{"port":8080,"buildDirectory":"../escape"}')).toEqual({
      port: 8080,
      buildDirectory: "dist",
    });
  });

  it("names its own key, so it cannot collide with the provider's", () => {
    expect(PREVIEW_SETTINGS_STORAGE_KEY).toBe("larpable.preview");
  });
});
