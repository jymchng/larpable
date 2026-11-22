/**
 * What `/workspace` contains the first time a browser boots the guest.
 *
 * The tree is deliberately a *working* Vite site rather than an empty directory: the
 * file-system bridge, the preview and the agent all need something real to look at,
 * and a placeholder would hide mistakes (an empty `/workspace` renders as "nothing
 * happened" whether the mount works or not).
 *
 * It has no dependencies installed. Installing them is the runtime manager's job
 * (PRD §7), because installation needs the guest's package manager, a network and a
 * cancellable progress stream — none of which belong to "boot the VM".
 *
 * The richer framework templates (vanilla, Vue, Svelte, Astro) live with that runtime
 * manager; this is the single starter every project begins from.
 */

/** Where the project lives in the guest. One name, imported by the boot wiring and the tests. */
export const DEFAULT_WORKSPACE_PATH = "/workspace";

/** The starter site, keyed by workspace-relative path. */
export const DEFAULT_PROJECT_TREE: Readonly<Record<string, string>> = {
  "package.json": `{
  "name": "my-site",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "devDependencies": {
    "vite": "^5.4.11"
  }
}
`,
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My Site</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <main>
      <h1>Hello from Linux</h1>
      <p data-message>This page runs on a real Linux machine inside your browser.</p>
    </main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
  "src/main.ts": `const message = "Built by Larpable inside Linux, in your browser.";

const target = document.querySelector<HTMLElement>("[data-message]");
if (target) {
  target.textContent = message;
}
`,
  "src/style.css": `:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, system-ui, sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #0b0b0f;
  color: #f4f4f5;
}

main {
  max-width: 42rem;
  padding: 2rem;
  text-align: center;
}

h1 {
  font-size: clamp(2rem, 6vw, 3.5rem);
  margin: 0 0 0.75rem;
}

p {
  color: #a1a1aa;
  line-height: 1.6;
}
`,
  "README.md": `# My Site

A starter site. Larpable scaffolds it into \`/workspace\` when the Linux environment
boots, then installs dependencies and builds it inside the guest.

- \`npm install\` (or the package manager the runtime manager detects)
- \`npm run build\` writes the production site to \`dist/\`
- \`dist/\` is what the preview pane serves

The guest's shell, not your host's, runs those commands: the project never leaves the
browser.
`,
};

/** Expand the starter tree into a map of guest paths to contents, for a boot tree. */
export function defaultProjectFiles(
  tree: Readonly<Record<string, string>> = DEFAULT_PROJECT_TREE,
): Record<string, string> {
  return { ...tree };
}
