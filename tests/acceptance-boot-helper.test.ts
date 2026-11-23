/**
 * The boot helper's decisions, without a browser.
 *
 * `scripts/lib/boot.ts` exists because every acceptance script used to click
 * `[data-testid=boot-button]`: a control that auto-boot disabled and that the debug popover
 * hid, so the click either hung on a hidden element or pressed a dead button. The rule that
 * replaced it is pure — footer text plus support verdict in, action out — which is exactly
 * the sort of rule that belongs in the unit suite rather than being rediscovered by a
 * ten-minute run against production.
 *
 * The `ensureBooted` cases below drive the helper with a fake `Page` so the *side effects*
 * are asserted too: no click when the machine is already up, one popover press and one Boot
 * press when it is idle, and none at all on a browser that cannot boot.
 */

import { describe, expect, it } from "vitest";

import type { Page } from "playwright-core";

import {
  BOOT_BUTTON,
  BootHelperError,
  DIAGNOSTICS_SURFACE,
  DIAGNOSTICS_TOGGLE,
  FOOTER_STATUS,
  SUPPORT_PROBLEMS,
  bootDecision,
  ensureBooted,
  machineStateFromFooter,
  readStatusText,
} from "../scripts/lib/boot";

describe("machineStateFromFooter", () => {
  it("reads every status the footer can print", () => {
    expect(machineStateFromFooter("Linux: Ready | Distro: debian | CPUs: 4")).toBe("ready");
    expect(machineStateFromFooter("Linux: Booting")).toBe("booting");
    expect(machineStateFromFooter("Linux: Initializing")).toBe("booting");
    expect(machineStateFromFooter("Linux: Not started")).toBe("idle");
    expect(machineStateFromFooter("Linux: Stopped")).toBe("idle");
    expect(machineStateFromFooter("Linux: Error | Error: no JSPI")).toBe("failed");
  });

  it("does not guess a state out of unrelated text", () => {
    expect(machineStateFromFooter("")).toBe("unknown");
    expect(machineStateFromFooter("Kernel can boot")).toBe("unknown");
  });
});

describe("bootDecision", () => {
  it("does nothing when the footer already says Ready", () => {
    const decision = bootDecision({ supported: true, footer: "Linux: Ready | Distro: debian" });
    expect(decision).toMatchObject({ action: "none", state: "ready" });
    expect(decision.reason).toContain("Linux: Ready");
  });

  it("waits while the auto-boot is in flight instead of booting twice", () => {
    expect(bootDecision({ supported: true, footer: "Linux: Booting" })).toMatchObject({
      action: "wait",
      state: "booting",
    });
    expect(bootDecision({ supported: true, footer: "" })).toMatchObject({
      action: "wait",
      state: "unknown",
    });
  });

  it("presses Boot when the machine is genuinely idle", () => {
    expect(bootDecision({ supported: true, footer: "Linux: Not started" })).toMatchObject({
      action: "press-boot",
      state: "idle",
    });
    // A shutdown machine is idle, not broken: asking for it should start it again.
    expect(bootDecision({ supported: true, footer: "Linux: Stopped" })).toMatchObject({
      action: "press-boot",
    });
    // A failed boot offers a retry through the same control.
    expect(bootDecision({ supported: true, footer: "Linux: Error | Error: boom" })).toMatchObject({
      action: "press-boot",
      state: "failed",
    });
  });

  it("never presses anything on a browser the support probe rejected", () => {
    const decision = bootDecision({ supported: false, footer: "Linux: Not started" });
    expect(decision.action).toBe("none");
    expect(decision.reason).toContain("support probe");
  });
});

/**
 * The slice of `Page` the helper touches, so a test can watch every click.
 *
 * `staleCandidates` models the reason `FOOTER_STATUS` is a selector *list*: a page can hold
 * more than one node that looks like the summary, and the first one can be an empty span (a
 * closed popover, or a build that predates the live region). Each candidate read advances the
 * footer sequence, exactly as one poll of a real page would.
 */
function fakePage(options: {
  footers: string[];
  problems?: number;
  surfaceState?: "open" | "closed";
  /** Candidates before the real sentence, each returning `""` (an empty status node). */
  staleCandidates?: number;
  /** Whether the Boot control is enabled *now* — `false` models a boot already in flight. */
  bootEnabled?: () => boolean;
}): { page: Page; clicks: string[] } {
  const clicks: string[] = [];
  let index = 0;
  let surfaceState = options.surfaceState ?? "closed";

  const footerAt = (): string => {
    const value = options.footers[Math.min(index, options.footers.length - 1)] ?? "";
    index += 1;
    return value;
  };

  const page = {
    locator(selector: string) {
      if (selector === FOOTER_STATUS) {
        const stale = options.staleCandidates ?? 0;
        const candidates = Array.from({ length: stale + 1 }, (_, position) => ({
          textContent: async (): Promise<string> => (position < stale ? "" : footerAt()),
        }));
        return {
          count: async () => candidates.length,
          first: () => candidates[0] as { textContent: () => Promise<string> },
          nth: (position: number) => candidates[position] as { textContent: () => Promise<string> },
        };
      }
      if (selector === SUPPORT_PROBLEMS) {
        return { count: async () => options.problems ?? 0 };
      }
      if (selector === DIAGNOSTICS_SURFACE) {
        return {
          getAttribute: async () => surfaceState,
          waitFor: async () => {
            if (surfaceState !== "open") throw new Error("surface never became visible");
          },
        };
      }
      if (selector === DIAGNOSTICS_TOGGLE) {
        return {
          click: async () => {
            clicks.push("toggle");
            surfaceState = "open";
          },
        };
      }
      if (selector === BOOT_BUTTON) {
        return {
          isEnabled: async () => options.bootEnabled?.() ?? true,
          click: async (clickOptions?: { timeout?: number }) => {
            if (options.bootEnabled !== undefined && !options.bootEnabled()) {
              throw new Error(
                `click: Timeout ${String(clickOptions?.timeout ?? 30_000)}ms exceeded: element is not enabled`,
              );
            }
            clicks.push("boot");
          },
        };
      }
      throw new Error(`unexpected selector ${selector}`);
    },
  } as unknown as Page;

  return { page, clicks };
}

describe("ensureBooted", () => {
  it("returns without touching a single control when the machine is already up", async () => {
    const { page, clicks } = fakePage({ footers: ["Linux: Ready | Distro: debian"] });

    const result = await ensureBooted(page, { pollMs: 1 });

    expect(result.path).toBe("already ready");
    expect(result.openedDiagnostics).toBe(false);
    expect(clicks).toEqual([]);
  });

  it("opens the popover and presses Boot once when the machine is idle", async () => {
    const { page, clicks } = fakePage({
      footers: ["Linux: Not started", "Linux: Booting", "Linux: Ready | Distro: debian"],
      surfaceState: "open",
    });

    const result = await ensureBooted(page, { pollMs: 1 });

    expect(result.path).toBe("pressed boot in the debug popover");
    // The surface was already open in this fixture, so only the boot press happened.
    expect(clicks).toEqual(["boot"]);
    expect(result.openedDiagnostics).toBe(false);
    expect(result.footer).toContain("Linux: Ready");
  });

  it("reports that it opened the popover when the surface was closed", async () => {
    const { page, clicks } = fakePage({
      footers: ["Linux: Not started", "Linux: Ready"],
    });

    const result = await ensureBooted(page, { pollMs: 1 });

    expect(clicks).toEqual(["toggle", "boot"]);
    expect(result.openedDiagnostics).toBe(true);
  });

  it("refuses to press anything on an unsupported browser, and says why", async () => {
    const { page, clicks } = fakePage({ footers: ["Linux: Not started"], problems: 2 });

    await expect(ensureBooted(page, { pollMs: 1 })).rejects.toThrow(BootHelperError);
    await expect(ensureBooted(page, { pollMs: 1 })).rejects.toThrow(/support probe/);
    expect(clicks).toEqual([]);
  });

  it("fails with the last footer text rather than hanging", async () => {
    const { page } = fakePage({ footers: ["Linux: Booting"] });

    await expect(ensureBooted(page, { timeoutMs: 20, pollMs: 5 })).rejects.toThrow(
      /did not reach Ready .*Linux: Booting/,
    );
  });

  /*
   * The live-deployment failure, reproduced: the footer still reads `Not started` when the
   * decision is made, so the helper goes to press Boot — but the auto-boot has already begun and
   * the button is `disabled`. Before this guard, Playwright retried the click for 30 s and the run
   * reported a broken deploy for a machine that was booting normally.
   */
  it("does not press a Boot button the auto-boot disabled, and waits instead", async () => {
    const { page, clicks } = fakePage({
      footers: ["Linux: Not started", "Linux: Booting", "Linux: Ready | Distro: debian"],
      // The machine started itself between the two reads; the control stays dead for the run.
      bootEnabled: () => false,
    });

    const result = await ensureBooted(page, { pollMs: 1 });

    expect(result.path).toBe("already ready");
    expect(clicks).toEqual(["toggle"]);
    expect(result.footer).toContain("Linux: Ready");
  });

  it("swallows a press that the auto-boot disables mid-click", async () => {
    let enabled = true;
    const { page, clicks } = fakePage({
      footers: ["Linux: Not started", "Linux: Booting", "Linux: Ready"],
      // Enabled when asked, disabled by the time the click lands: the exact race.
      bootEnabled: () => {
        const answer = enabled;
        enabled = false;
        return answer;
      },
    });

    await ensureBooted(page, { pollMs: 1 });

    expect(clicks).toEqual(["toggle"]);
  });

  /*
   * The regression that made a working deployment look broken: the live site's footer said
   * `Linux: Ready | Distro: debian …` while the probe, looking only for today's hidden
   * `environment-summary` span, read `""` and timed out after 180 s. The summary has to be found
   * wherever a build keeps it, and an empty node must not shadow it.
   */
  it("reads the summary past an empty candidate and treats the machine as ready", async () => {
    const { page, clicks } = fakePage({
      footers: ["Linux: Ready | Distro: debian | CPUs: 2"],
      staleCandidates: 2,
    });

    const result = await ensureBooted(page, { pollMs: 1 });

    expect(result.path).toBe("already ready");
    expect(result.footer).toContain("Distro: debian");
    expect(clicks).toEqual([]);
    expect(await readStatusText(page)).toContain("Linux: Ready");
  });
});
