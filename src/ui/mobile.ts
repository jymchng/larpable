/**
 * What a phone changes about booting Linux in a tab \u2014 in sentences, as data.
 *
 * The kernel's requirements do not care what device they are asked on, but the *failure* does.
 * A desktop browser that lacks WebAssembly JSPI is out of date; a phone browser that lacks it is
 * usually brand new and simply cannot have it, because every browser on iOS is WebKit and Safari
 * ships JSPI only in recent versions \u2014 so "use Chrome/Edge 137+", which is the right advice on
 * a laptop, sends an iPhone user to the App Store for a browser with the same engine. Two more
 * things are specific to handsets and worth saying before a user waits four minutes for a build:
 * the memory a guest plus an `npm install` needs, and the fact that a backgrounded mobile tab is
 * suspended (which looks exactly like a hung kernel).
 *
 * Everything here is a pure function of facts the caller passes, so the wording is testable
 * without a phone. `detectHandset` is the only impure part: it reads the window once.
 */

import type { SupportReport } from "@/env/support";
import { STAGE_BREAKPOINT_PX } from "@/ui/stage";

export type MobilePlatform = "ios" | "android" | "other";

export interface HandsetFacts {
  /** Viewport width in CSS pixels. */
  width: number;
  /** `navigator.userAgent`. */
  userAgent: string;
  /** `navigator.deviceMemory` in GB, or null when the browser does not report it (iOS does not). */
  deviceMemoryGb: number | null;
  /** True when the primary pointer is coarse \u2014 a finger, not a trackpad. */
  coarsePointer?: boolean;
}

export interface MobileNote {
  tone: "info" | "warn";
  text: string;
}

/**
 * Which engine a phone's browser is (or, on iOS, isn't) running.
 *
 * Ordered iOS first because an iPad's user agent says "Macintosh" and an iPhone's says
 * "iPhone"; the Android test is the plain `Android` token. A desktop UA falls through to
 * `other`, which gets the generic wording rather than a wrong platform claim.
 */
export function mobilePlatform(userAgent: string): MobilePlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

/**
 * Is this a handset-sized screen?
 *
 * Width is the deciding fact (it is what the layout reacts to), and the pointer is the
 * cross-check that keeps a narrow desktop window from being treated as a phone: a 390-px-wide
 * window on a laptop is a resized browser, and telling that user "update iOS" would be wrong.
 * The user agent only decides *which* sentence to print, never whether to print one.
 */
export function isHandset(facts: HandsetFacts): boolean {
  if (facts.width >= STAGE_BREAKPOINT_PX) return false;
  if (facts.coarsePointer === true) return true;
  return mobilePlatform(facts.userAgent) !== "other";
}

/**
 * The sentences a phone user should see before (or instead of) a boot.
 *
 * Three tiers, in the order they matter:
 *
 * 1. the kernel cannot boot here \u2014 the platform-specific reason and the one action that helps;
 * 2. it can boot, but this device may not finish a build \u2014 the memory sentence, only when
 *    the browser actually reports a small number (iOS reports nothing, which is not "0 GB");
 * 3. it can boot \u2014 the one habit that keeps a mobile boot alive (leave the tab in front).
 */
export function handsetNotes(report: SupportReport, facts: HandsetFacts): MobileNote[] {
  if (!isHandset(facts)) return [];

  const platform = mobilePlatform(facts.userAgent);
  const notes: MobileNote[] = [];

  if (!report.ok) {
    if (!report.probe.jspi) {
      notes.push({ tone: "warn", text: JSPI_ON_PHONE[platform] });
    }
    notes.push({
      tone: "warn",
      text: "Nothing you have built is lost by this: projects live in this browser's own storage on this device, and they are waiting the next time you open Larpable on a browser that can boot.",
    });
    return notes;
  }

  if (facts.deviceMemoryGb !== null && facts.deviceMemoryGb <= 4) {
    notes.push({
      tone: "warn",
      text: `This device reports about ${String(facts.deviceMemoryGb)} GB of memory. The guest needs most of a gigabyte before it runs anything, and an \`npm install\` needs more, so a build can fail with an out-of-memory error even though the kernel booted. The terminal prints the guest's own message when that happens.`,
    });
  }

  notes.push({
    tone: "info",
    text: "Keep this tab in front while the kernel boots and while a build runs. A phone suspends a backgrounded tab, and a suspended guest looks exactly like a hung one.",
  });

  return notes;
}

/**
 * The JSPI sentence per platform.
 *
 * The versions are the ones `src/env/support.ts` already states for the desktop case, and the
 * point of each is the action, not the version number: on iOS there is no second engine to try,
 * on Android there usually is (an in-app browser is not Chrome), and everywhere else a desktop
 * is the honest answer.
 */
const JSPI_ON_PHONE: Record<MobilePlatform, string> = {
  ios: "On an iPhone or iPad every browser is Safari under the hood, so Chrome and Firefox cannot add what Safari lacks: unkernel needs WebAssembly JSPI, which a current iOS ships and an older one does not. Updating iOS is the only fix on this device.",
  android:
    "On Android Chrome and Edge 137+ have the WebAssembly JSPI the kernel needs; a browser built into another app (a social app, a shopping app) usually does not. Opening this page in Chrome itself is often the whole fix.",
  other:
    "This phone's browser lacks WebAssembly JSPI, so the kernel cannot boot here. Larpable runs in a desktop browser; your projects stay on this device until you open it there.",
};

/**
 * Read the facts from a live window, defensively.
 *
 * `deviceMemory` is deliberately coarse (0.25, 0.5, 1, 2, 4, 8) and absent on iOS; both
 * "missing" and "nonsense" collapse to null so no note ever claims 0 GB.
 */
export function detectHandset(): HandsetFacts {
  if (typeof window === "undefined") {
    return { width: STAGE_BREAKPOINT_PX, userAgent: "", deviceMemoryGb: null };
  }
  const reported = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const memory = typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? reported : null;
  const coarse =
    typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)").matches : undefined;
  return {
    width: window.innerWidth,
    userAgent: navigator.userAgent,
    deviceMemoryGb: memory,
    ...(coarse === undefined ? {} : { coarsePointer: coarse }),
  };
}
