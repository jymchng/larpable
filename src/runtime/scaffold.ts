/**
 * Project scaffolding, written as files rather than delegated to `create-vite`.
 *
 * Two reasons not to shell out to a generator:
 *
 * - The generator is a package to download *before* the project that needs it exists,
 *   in a guest where the first `node` call is already a 50–150 s download. The agent
 *   gets a working project from a template that ships with the app instead.
 * - A generator writes whatever its current version decides. These templates are
 *   deliberately small, reviewed files, so `netlify.toml`, the build command and the
 *   output directory can be derived from the same facts that produced them.
 *
 * React + TypeScript + Vite is the default (PRD §7.2) and the only template with
 * TypeScript configured; Vue, Svelte and plain HTML/CSS/JS are the alternatives the
 * agent may choose. Every template builds with `vite build` into `dist/`, which is what
 * the build manager verifies and the preview serves.
 */

import type { ExecutionEnvironment } from "../env/execution";

import type { PackageManager } from "./detect";

export type Framework = "react-ts" | "vue" | "svelte" | "vanilla";

export const FRAMEWORKS: readonly Framework[] = ["react-ts", "vue", "svelte", "vanilla"];

export interface ScaffoldOptions {
  /** Default `react-ts`, the framework PRD §7.2 prioritises. */
  framework?: Framework;
  /** `name` in package.json and the page title. Default `my-site`. */
  name?: string;
  /** Decides the install command, not the files. Default `npm`. */
  packageManager?: PackageManager;
}

export interface ScaffoldedProject {
  framework: Framework;
  name: string;
  /** Workspace-relative path to contents. */
  files: Readonly<Record<string, string>>;
  packageJson: string;
  /** The command the build manager will run, e.g. `npm run build`. */
  buildCommand: string;
  installCommand: string;
  /** Where `vite build` writes, relative to the project root. */
  outputDir: string;
}

/** A package name that is safe in package.json and in a directory name. */
function safeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "my-site";
}

function packageJson(
  name: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      devDependencies,
    },
    null,
    2,
  )}\n`;
}

function indexHtml(name: string, entry: string, title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="${entry}"></script>
  </body>
</html>
`;
}

const SHARED_STYLE = `:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, system-ui, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: #0b0b0f;
  color: #f4f4f5;
}

#app {
  max-width: 46rem;
  margin: 0 auto;
  padding: 4rem 1.5rem;
}

h1 {
  font-size: clamp(2rem, 6vw, 3.25rem);
  line-height: 1.1;
  margin: 0 0 1rem;
}

p {
  color: #a1a1aa;
  line-height: 1.6;
}
`;

const README = (name: string) => `# ${name}

Scaffolded by Larpable and built inside Linux, in the browser.

- \`npm install\` — the guest installs the dependencies (nothing runs on the host)
- \`npm run build\` — writes the production site to \`dist/\`
- \`dist/\` — what the preview pane serves and what Netlify publishes

Extra dependencies are installed by the agent inside the guest, so this project never
needs Node on your machine.
`;

function reactFiles(name: string): Record<string, string> {
  return {
    "package.json": packageJson(
      name,
      { react: "^18.3.1", "react-dom": "^18.3.1" },
      {
        "@types/react": "^18.3.18",
        "@types/react-dom": "^18.3.5",
        "@vitejs/plugin-react": "^4.3.4",
        typescript: "^5.7.2",
        vite: "^5.4.11",
      },
    ),
    "index.html": indexHtml(name, "/src/main.tsx", name),
    "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
`,
    "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./style.css";

const root = document.getElementById("app");
if (!root) throw new Error("index.html has no #app element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    "src/App.tsx": `export function App() {
  return (
    <main>
      <h1>${name}</h1>
      <p>This React app was scaffolded, installed and built inside Linux, in your browser.</p>
    </main>
  );
}
`,
    "src/style.css": SHARED_STYLE,
    "README.md": README(name),
  };
}

function vueFiles(name: string): Record<string, string> {
  return {
    "package.json": packageJson(
      name,
      { vue: "^3.5.13" },
      { "@vitejs/plugin-vue": "^5.2.1", vite: "^5.4.11" },
    ),
    "index.html": indexHtml(name, "/src/main.js", name),
    "vite.config.js": `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
});
`,
    "src/main.js": `import { createApp } from "vue";

import App from "./App.vue";
import "./style.css";

createApp(App).mount("#app");
`,
    "src/App.vue": `<script setup>
const name = "${name}";
</script>

<template>
  <main>
    <h1>{{ name }}</h1>
    <p>This Vue app was scaffolded, installed and built inside Linux, in your browser.</p>
  </main>
</template>
`,
    "src/style.css": SHARED_STYLE,
    "README.md": README(name),
  };
}

function svelteFiles(name: string): Record<string, string> {
  return {
    "package.json": packageJson(
      name,
      { svelte: "^5.19.0" },
      { "@sveltejs/vite-plugin-svelte": "^5.0.3", vite: "^5.4.11" },
    ),
    "index.html": indexHtml(name, "/src/main.js", name),
    "vite.config.js": `import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
});
`,
    "src/main.js": `import { mount } from "svelte";

import App from "./App.svelte";
import "./style.css";

mount(App, { target: document.getElementById("app") });
`,
    "src/App.svelte": `<script>
  const name = "${name}";
</script>

<main>
  <h1>{name}</h1>
  <p>This Svelte app was scaffolded, installed and built inside Linux, in your browser.</p>
</main>
`,
    "src/style.css": SHARED_STYLE,
    "README.md": README(name),
  };
}

function vanillaFiles(name: string): Record<string, string> {
  return {
    "package.json": packageJson(name, {}, { vite: "^5.4.11" }),
    "index.html": indexHtml(name, "/src/main.js", name),
    "src/main.js": `import "./style.css";

const heading = document.createElement("h1");
heading.textContent = "${name}";

const message = document.createElement("p");
message.textContent =
  "This static site was installed and built inside Linux, in your browser.";

document.getElementById("app")?.append(heading, message);
`,
    "src/style.css": SHARED_STYLE,
    "README.md": README(name),
  };
}

/**
 * Build a project in memory. No guest, no filesystem, no network — which is what makes
 * the templates testable and the write step a separate, observable action.
 */
export function scaffoldProject(options: ScaffoldOptions = {}): ScaffoldedProject {
  const framework = options.framework ?? "react-ts";
  const name = safeName(options.name ?? "my-site");
  const packageManager = options.packageManager ?? "npm";
  const files =
    framework === "vue"
      ? vueFiles(name)
      : framework === "svelte"
        ? svelteFiles(name)
        : framework === "vanilla"
          ? vanillaFiles(name)
          : reactFiles(name);

  const json = files["package.json"] as string;
  return {
    framework,
    name,
    files,
    packageJson: json,
    buildCommand: packageManager === "bun" ? "bun run build" : "npm run build",
    installCommand: packageManager === "bun" ? "bun install" : "npm install --no-audit --no-fund",
    outputDir: "dist",
  };
}

/**
 * Write the project into the workspace, creating directories as needed.
 *
 * Returns the guest paths written, in a stable order, so a caller (or a test) can show
 * exactly what appeared rather than trusting a boolean.
 */
export async function writeScaffold(
  environment: ExecutionEnvironment,
  project: ScaffoldedProject,
  options: { root?: string } = {},
): Promise<string[]> {
  const root = options.root ?? environment.workspacePath;
  const written: string[] = [];

  for (const relative of Object.keys(project.files).sort()) {
    const content = project.files[relative] as string;
    const guestPath = `${root}/${relative}`;
    const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
    if (parent) await environment.createDirectory(`${root}/${parent}`);
    await environment.writeFile(guestPath, content);
    written.push(guestPath);
  }

  return written;
}
