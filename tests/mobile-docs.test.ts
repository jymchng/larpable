/**
 * The mobile page's claims, held to the code that makes them.
 *
 * `docs/mobile.md` exists because a number cannot state the limits a phone has, but prose is the
 * easiest thing in a repository to let rot. Two failure modes are worth a test:
 *
 * 1. **A citation to a file that is not there.** `src/ui/touch.ts`, `icon-button.tsx` and both
 *    mobile test files all name `scripts/mobile-acceptance.ts` as their browser proof; before
 *    that script existed the four comments described a run nobody could perform. The first test
 *    walks every `scripts/...` path mentioned in `src/` and `tests/` and fails on a dangling one,
 *    so the next comment that invents a script breaks the build instead of misleading a reader.
 * 2. **Drift between the page and the sentences it describes.** The JSPI advice on a phone is
 *    not the desktop advice, and the versions in the desktop sentence live in
 *    `src/env/support.ts`. The second test reads that string out of the source and requires the
 *    doc to quote it, and requires the doc to name each mechanism it claims (`handsetNotes`,
 *    `JSPI_ON_PHONE`, `detectHandset`) and each limit (iOS, in-app browsers, memory,
 *    suspended tab).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(root, "src");
const testsDir = join(root, "tests");

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) found.push(path);
  }
  return found;
}

/** `scripts/mobile-acceptance.ts` resolves; `scripts/lib/pty-channel` resolves as a `.ts` file. */
function resolves(citation: string): boolean {
  const candidates = [citation, `${citation}.ts`, `${citation}.tsx`, `${citation}.mjs`, `${citation}.js`];
  return candidates.some((candidate) => {
    try {
      return statSync(resolve(root, candidate)).isFile();
    } catch {
      return false;
    }
  });
}

describe("mobile documentation citations", () => {
  it("cites only scripts that exist", () => {
    const dangling: string[] = [];
    let checked = 0;
    for (const file of [...sourceFiles(srcDir), ...sourceFiles(testsDir)]) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/scripts\/[A-Za-z0-9_./-]+/g)) {
        const citation = match[0].replace(/[.,:;]+$/, "");
        // The regex literal above lives in this file too, so `scripts/` with nothing after it is
        // an artefact of the search, not a citation.
        if (citation === "scripts/" || citation.length <= "scripts/".length) continue;
        checked += 1;
        if (!resolves(citation)) dangling.push(`${file.slice(root.length + 1)} -> ${citation}`);
      }
    }

    // A vacuous pass would be the same bug with a green tick: these files are known to cite one.
    expect(checked).toBeGreaterThan(0);
    expect(dangling).toEqual([]);
    expect(resolves("scripts/mobile-acceptance.ts")).toBe(true);
  });

  it("names the file the four mobile comments point at, and the npm script that runs it", () => {
    for (const file of [
      "src/ui/touch.ts",
      "src/ui/components/icon-button.tsx",
      "tests/mobile-layout.test.tsx",
      "tests/mobile-stage.test.ts",
    ]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text, file).toContain("scripts/mobile-acceptance.ts");
      expect(text, file).toContain("bun run acceptance:mobile");
    }
  });

  it("states each phone limit next to where it is implemented", () => {
    const doc = readFileSync(join(root, "docs", "mobile.md"), "utf8");
    // The mechanisms it describes.
    for (const mechanism of [
      "src/ui/mobile.ts",
      "src/env/support.ts",
      "JSPI_ON_PHONE",
      "handsetNotes",
      "detectHandset",
      "src/ui/environment-panel.tsx",
    ]) {
      expect(doc, mechanism).toContain(mechanism);
    }
    // The four limits goal #26 asks for, one sentence each.
    expect(doc).toMatch(/updating iOS is the only fix/i);
    expect(doc).toMatch(/Chrome and Edge \(137\+\)|Chrome\/Edge 137\+/);
    expect(doc).toMatch(/built into another app|in another app/i);
    expect(doc).toMatch(/out-of-memory/i);
    expect(doc).toMatch(/backgrounded tab is suspended/i);
    // The 44 px floor is never claimed without its documented exception.
    expect(doc).toMatch(/data-inline/);
    expect(doc).toMatch(/2\.5\.8/);
  });

  it("quotes the desktop JSPI advice from support.ts verbatim", () => {
    const support = readFileSync(join(root, "src", "env", "support.ts"), "utf8");
    const advice = /use Chrome\/Edge 137\+, Firefox 153\+, or Safari 27\+/.exec(support);
    expect(advice, "support.ts no longer states the desktop browser versions").not.toBeNull();

    // The doc wraps its prose at 96 columns, so compare with runs of whitespace collapsed: the
    // words and versions have to match, the line breaks are the page's business.
    const collapse = (text: string): string => text.replace(/\s+/g, " ");
    const doc = collapse(readFileSync(join(root, "docs", "mobile.md"), "utf8"));
    expect(doc).toContain(collapse(advice?.[0] as string));
  });
});
