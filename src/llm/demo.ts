/**
 * A deterministic provider that writes a real, renderable site — no key, no network.
 *
 * Everything in this product can be exercised without an LLM account except the LLM itself:
 * the guest boots, the tools run, the preview publishes. What is missing for a person who
 * opens the app without a key is a way to *see* that, and what is missing for an acceptance
 * run is a conversation whose tool calls are identical every time.
 *
 * So this is a scripted conversation, not a stub response: it asks for three real
 * `write_file` calls that put a Vite-shaped `dist/` into the guest (a root-absolute stylesheet,
 * a root-absolute ES module that reads `location.pathname`, and the HTML entry that references
 * both), then stops. Those are the same bytes the preview acceptance run writes by typing
 * base64 into the pty — here they travel through the agent's own filesystem tool, which is
 * both the more reliable channel and the thing the UI is supposed to show.
 *
 * Two deliberate properties:
 *
 * - **The fixture is Vite-shaped, not preview-shaped.** Root-absolute `/assets/…` URLs are what
 *   a real build emits, so a preview that renders this has done the rebasing a real build needs.
 * - **It is a `MockProvider`.** Same class the unit tests use, so "deterministic" is a property
 *   already tested rather than a promise made by a second implementation.
 */

import { MockProvider, type MockTurn } from "./mock";

/** The HTML entry the demo writes. Its title is what the acceptance run reads back. */
export const DEMO_INDEX_HTML = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8">',
  "<title>Demo build</title>",
  '<link rel="stylesheet" href="/assets/index-abc123.css">',
  "</head><body>",
  '<div id="answer"></div>',
  '<div id="route"></div>',
  "</body></html>",
  "",
].join("\n");

/** The stylesheet. `#123456` is the colour the acceptance run asserts was *applied*. */
export const DEMO_STYLESHEET = [
  "body { margin: 0; background: #123456; color: #ffffff; font-family: monospace; }",
  "#answer::before { content: 'answer='; }",
  "#route::before { content: 'route='; }",
  "",
].join("\n");

/** The module. It writes `42` and the pathname, which is how "the script ran" is measured. */
export const DEMO_MODULE = [
  "const answer = document.getElementById('answer');",
  "const route = document.getElementById('route');",
  "answer.textContent = '42';",
  "route.textContent = window.location.pathname;",
  "document.title = 'demo-js-ran';",
  "",
].join("\n");

/** The scripted conversation. Exported so a test can assert it without constructing a provider. */
export const DEMO_TURNS: readonly MockTurn[] = [
  {
    text:
      "I will write a small site straight into dist/ so the preview has a real build to " +
      "publish: an entry document, a stylesheet and one ES module.\n",
    toolCalls: [
      { name: "write_file", arguments: { path: "dist/index.html", content: DEMO_INDEX_HTML }, id: "demo-write-index" },
      {
        name: "write_file",
        arguments: { path: "dist/assets/index-abc123.css", content: DEMO_STYLESHEET },
        id: "demo-write-css",
      },
      { name: "write_file", arguments: { path: "dist/assets/index-def456.js", content: DEMO_MODULE }, id: "demo-write-js" },
    ],
  },
  {
    text:
      "Done — dist/ holds the entry document, one stylesheet and one module. " +
      "Press “Preview build” to publish it and the pane will render the real files.",
  },
];

/**
 * The provider the `demo` setting resolves to.
 *
 * A fresh instance per session: `MockProvider` counts turns, so sharing one between two
 * sessions would make the second conversation start mid-script.
 */
export function createDemoProvider(): MockProvider {
  return new MockProvider({ turns: DEMO_TURNS, model: "demo-1" });
}
