/**
 * What `/workspace` contains the first time a browser boots the guest.
 *
 * The tree is deliberately a *working* Vite site rather than an empty directory: the
 * file-system bridge, the preview and the agent all need something real to look at,
 * and a placeholder would hide mistakes (an empty `/workspace` renders as "nothing
 * happened" whether the mount works or not).
 *
 * It is also deliberately *interactive*: a page that only prints a sentence looks identical
 * whether its JavaScript ran or not, so a broken build, a stripped module or a preview that
 * serves a stale `dist/` all look like success. The clock ticks every second and the counter
 * changes on a click, which makes "the module executed" something a person can see and an
 * acceptance run can assert. Both are plain DOM code in `src/main.ts` — no framework, no
 * dependency — so a cold `npm install` is still only Vite.
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
    <title>My Site — built inside Linux</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <main>
      <header class="hero">
        <p class="eyebrow">Runs inside Linux, in your browser</p>
        <h1>Hello from Linux</h1>
        <p class="lede" data-message>This page runs on a real Linux machine inside your browser.</p>
      </header>

      <div class="cards">
        <section class="card" aria-labelledby="clock-heading">
          <h2 id="clock-heading">Live clock</h2>
          <p class="clock" data-clock data-testid="clock">--:--:--</p>
          <p class="clock-detail" data-clock-date>&nbsp;</p>
          <p class="clock-detail" data-clock-zone>&nbsp;</p>
          <p class="hint">Ticks every second from <code>setInterval</code> in the built bundle.</p>
        </section>

        <section class="card" aria-labelledby="counter-heading">
          <h2 id="counter-heading">Counter</h2>
          <div class="counter-row">
            <button type="button" class="counter-button" data-counter-decrement aria-label="Decrease the counter">−</button>
            <output class="counter-value" data-counter aria-live="polite">0</output>
            <button type="button" class="counter-button" data-counter-increment aria-label="Increase the counter">+</button>
          </div>
          <div class="counter-actions">
            <button type="button" data-counter-step>Step: <span data-counter-step-value>1</span></button>
            <button type="button" data-counter-reset>Reset</button>
          </div>
          <p class="hint" data-counter-note>Every click is handled in this page, not on a server.</p>
        </section>
      </div>

      <footer class="footer">
        <p>Built by Larpable inside the guest, served from <code>dist/</code>.</p>
      </footer>
    </main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
  "src/main.ts": `/**
 * The starter page's behaviour: a live clock and a counter.
 *
 * Both write to the DOM the page already contains, so the module has no build step beyond
 * TypeScript itself and no dependency to resolve. The two pieces of state are local: the
 * clock re-reads \`Date.now()\` on every tick (so it never drifts), and the counter keeps one
 * number and renders it.
 */

const message = "Built by Larpable inside Linux, in your browser.";

const messageTarget = document.querySelector<HTMLElement>("[data-message]");
if (messageTarget) {
  messageTarget.textContent = message;
}

/* ---------------------------------------------------------------- clock */

const clock = document.querySelector<HTMLElement>("[data-clock]");
const clockDate = document.querySelector<HTMLElement>("[data-clock-date]");
const clockZone = document.querySelector<HTMLElement>("[data-clock-zone]");

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});

function renderClock(): void {
  const now = new Date();
  // textContent, not innerHTML: the clock is data, and data is never markup.
  if (clock) clock.textContent = timeFormat.format(now);
  if (clockDate) clockDate.textContent = dateFormat.format(now);
  if (clockZone) clockZone.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
}

if (clock) {
  renderClock();
  // Align the first tick to the next whole second, then hold a steady one-second cadence, so
  // the display changes when the wall clock does rather than a fraction of a second later.
  window.setTimeout(function startTicking() {
    renderClock();
    window.setInterval(renderClock, 1000);
  }, 1000 - (Date.now() % 1000));
}

/* -------------------------------------------------------------- counter */

const counter = document.querySelector<HTMLElement>("[data-counter]");
const counterNote = document.querySelector<HTMLElement>("[data-counter-note]");
const increment = document.querySelector<HTMLButtonElement>("[data-counter-increment]");
const decrement = document.querySelector<HTMLButtonElement>("[data-counter-decrement]");
const reset = document.querySelector<HTMLButtonElement>("[data-counter-reset]");
const stepButton = document.querySelector<HTMLButtonElement>("[data-counter-step]");
const stepValue = document.querySelector<HTMLElement>("[data-counter-step-value]");

/** The steps a click walks through. One button cycles them, so the actions stay two. */
const STEPS = [1, 5, 10] as const;

let value = 0;
let stepIndex = 0;

function step(): number {
  return STEPS[stepIndex] ?? 1;
}

function renderCounter(): void {
  if (counter) counter.textContent = String(value);
  if (counterNote) {
    counterNote.textContent =
      value === 0
        ? "Every click is handled in this page, not on a server."
        : "Value: " + String(value) + " (" + (value === 1 ? "1 step" : String(Math.abs(value)) + " steps") + ")";
  }
  if (decrement) decrement.disabled = false;
}

function change(by: number): void {
  value += by;
  renderCounter();
}

increment?.addEventListener("click", function onIncrement() {
  change(step());
  increment.animate?.(
    [{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }],
    { duration: 140, easing: "ease-out" },
  );
});

decrement?.addEventListener("click", function onDecrement() {
  change(-step());
  decrement.animate?.(
    [{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }],
    { duration: 140, easing: "ease-out" },
  );
});

reset?.addEventListener("click", function onReset() {
  value = 0;
  renderCounter();
});

stepButton?.addEventListener("click", function onStep() {
  stepIndex = (stepIndex + 1) % STEPS.length;
  const next = step();
  if (stepValue) stepValue.textContent = String(next);
  stepButton.setAttribute("aria-label", "Change the step size, currently " + String(next));
});

// The keyboard shortcuts a counter is expected to have when it is the focused control.
document.addEventListener("keydown", function onKeyDown(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === "+" || event.key === "ArrowUp") {
    change(step());
    event.preventDefault();
  } else if (event.key === "-" || event.key === "ArrowDown") {
    change(-step());
    event.preventDefault();
  } else if (event.key === "0") {
    value = 0;
    renderCounter();
  }
});

renderCounter();
`,
  "src/style.css": `:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --bg: #0b0b0f;
  --panel: #13131a;
  --line: #24242f;
  --ink: #f4f4f5;
  --muted: #a1a1aa;
  --accent: #7dd3fc;
  --accent-ink: #04121a;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem 1.25rem;
  background:
    radial-gradient(60rem 30rem at 50% -10%, #1b2b3a 0%, transparent 60%),
    var(--bg);
  color: var(--ink);
}

main {
  width: 100%;
  max-width: 52rem;
}

.hero {
  text-align: center;
  margin-bottom: 2rem;
}

.eyebrow {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent);
}

h1 {
  font-size: clamp(2rem, 6vw, 3.25rem);
  line-height: 1.05;
  margin: 0 0 0.75rem;
  letter-spacing: -0.02em;
}

.lede {
  margin: 0;
  color: var(--muted);
  line-height: 1.6;
}

.cards {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
}

.card {
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid var(--line);
  border-radius: 1rem;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

h2 {
  margin: 0;
  font-size: 0.75rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 600;
}

.clock {
  margin: 0.25rem 0 0;
  font-size: clamp(2.25rem, 9vw, 3.5rem);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  line-height: 1;
}

.clock-detail {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
}

.hint {
  margin: 0;
  margin-top: auto;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1.5;
}

.hint code,
.footer code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--ink);
}

.counter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0.25rem 0;
}

.counter-value {
  font-size: clamp(2rem, 8vw, 3rem);
  font-variant-numeric: tabular-nums;
  min-width: 4ch;
  text-align: center;
}

.counter-button {
  width: 3rem;
  height: 3rem;
  border-radius: 0.75rem;
  border: 1px solid var(--line);
  background: #1c1c26;
  color: var(--ink);
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
}

.counter-button:hover {
  background: #23232f;
  border-color: #34343f;
}

.counter-button:active {
  background: var(--accent);
  color: var(--accent-ink);
}

.counter-actions {
  display: flex;
  gap: 0.5rem;
}

.counter-actions button {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border-radius: 0.6rem;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.counter-actions button:hover {
  color: var(--ink);
  border-color: #34343f;
}

button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.footer {
  margin-top: 2rem;
  text-align: center;
  color: var(--muted);
  font-size: 0.8rem;
}
`,
  "README.md": `# My Site

A starter site with a live clock and a counter. Larpable scaffolds it into \`/workspace\`
when the Linux environment boots, then installs dependencies and builds it inside the guest.

- \`npm install\` (or the package manager the runtime manager detects)
- \`npm run build\` writes the production site to \`dist/\`
- \`dist/\` is what the preview pane serves

Edit \`src/main.ts\` to change the behaviour and \`src/style.css\` to change the look: the
clock ticks every second and the counter's +/− buttons keep their state in the page, so a
stale build or a module that never ran is visible immediately.

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
