import { describe, expect, it } from "vitest";

import { evaluateSupport } from "../src/env/support";

describe("evaluateSupport", () => {
  it("reports ok when JSPI, isolation and SharedArrayBuffer are all present", () => {
    const report = evaluateSupport({
      crossOriginIsolated: true,
      jspi: true,
      sharedArrayBuffer: true,
    });

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it("names JSPI as the blocker when the browser is too old", () => {
    const report = evaluateSupport({
      crossOriginIsolated: true,
      jspi: false,
      sharedArrayBuffer: true,
    });

    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/JSPI/);
    expect(report.problems[0]).toMatch(/Chrome\/Edge 137\+/);
  });

  it("distinguishes missing isolation from a missing SharedArrayBuffer", () => {
    const report = evaluateSupport({
      crossOriginIsolated: false,
      jspi: true,
      sharedArrayBuffer: false,
    });

    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(2);
    expect(report.problems[0]).toMatch(/cross-origin isolated/);
    expect(report.problems[1]).toMatch(/SharedArrayBuffer/);
  });

  it("keeps the probe in the report so the UI can show raw values", () => {
    const probe = { crossOriginIsolated: false, jspi: true, sharedArrayBuffer: false };
    expect(evaluateSupport(probe).probe).toEqual(probe);
  });
});
