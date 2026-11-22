# Larpable
## Browser-Native AI Website Development Environment

**Project codename:** Larpable  
**Product category:** AI-powered website development environment  
**Architecture:** WebAssembly + Linux + AI Agent + Browser Preview  
**Primary objective:** Build websites entirely inside the browser using a Linux environment powered by unkernel.

---

# 1. Mission

You are responsible for designing and implementing **Larpable**, a browser-native AI website development environment.

Larpable allows users to describe a website in natural language and have an autonomous AI coding agent create, modify, install dependencies, compile, and preview the website.

The entire development and build pipeline must run client-side inside the browser.

The core technology is [unkernel](https://unkernel.dev/), which provides a Linux environment running through WebAssembly.

The LLM interacts with this Linux environment through an agentic tool-calling architecture.

The intended workflow:

1. User describes a website.
2. LLM interprets the requirements.
3. LLM creates the project inside the Linux filesystem.
4. LLM generates the necessary source files.
5. LLM installs dependencies inside Linux.
6. LLM executes the production build using Bun or a compatible runtime.
7. Build artifacts are generated inside the Linux filesystem.
8. Host browser accesses the generated artifacts.
9. Website renders inside an isolated iframe.
10. LLM can inspect errors and iteratively improve the website.

**Fundamental product principle: The browser is the development machine.**

There must be no mandatory backend responsible for project creation, filesystem operations, dependency installation, compilation, or website preview.

An external LLM API may be used for inference.

---

# 2. Product Goals

Larpable must:

- Run a Linux user-space environment inside the browser.
- Provide the AI agent with shell and filesystem access.
- Support autonomous frontend development.
- Support modern frontend frameworks.
- Install npm dependencies inside the Linux environment.
- Compile production builds inside the Linux environment.
- Render generated websites in the browser.
- Support iterative AI-driven development.
- Persist projects between browser sessions.
- Generate Netlify-compatible production artifacts.
- Generate an appropriate `netlify.toml` for every project.
- Remain extensible for additional programming languages and build systems.

## 2.1 Non-Goals

The initial release does not need:

- Backend application hosting.
- Database hosting.
- Remote development containers.
- Docker support.
- Multi-user collaboration.
- Public website deployment orchestration.
- Universal compatibility with every npm package.

Netlify deployment configuration is required, but automatic deployment is not part of the initial scope.

---

# 3. Technology Stack

Use the following technologies as architectural preferences.

| Component | Preferred Technology |
|---|---|
| Linux environment | unkernel |
| Execution | WebAssembly |
| Linux filesystem | unkernel filesystem |
| Persistent storage | IndexedDB-backed persistent disk |
| JavaScript runtime | Bun |
| Runtime fallback | Node.js |
| Frontend framework | React |
| Language | TypeScript |
| Build tooling | Bun / Vite |
| AI agent | Custom agent runtime |
| LLM integration | OpenAI-compatible API / Anthropic |
| UI | Modern React application |
| Website preview | Sandboxed iframe |
| Preview delivery | HTTP bridge or filesystem bridge |
| Deployment target | Netlify |
| Deployment configuration | `netlify.toml` |

The implementation agent must validate the actual compatibility of every dependency.

Do not assume Bun works merely because Node.js works.

Do not invent unkernel SDK APIs.

Research the actual SDK and its implementation before integration.

---

# 4. System Architecture

Implement the following high-level architecture.

```text
┌─────────────────────────────────────────────────────────────┐
│                         BROWSER                             │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  LARPABLE APPLICATION                  │  │
│  │                                                       │  │
│  │  ┌──────────────────┐    ┌─────────────────────────┐   │  │
│  │  │                  │    │                         │   │  │
│  │  │   AI CHAT        │    │   WEBSITE PREVIEW       │   │  │
│  │  │                  │    │                         │   │  │
│  │  └────────┬─────────┘    └────────────▲────────────┘   │  │
│  │           │                           │                │  │
│  │           ▼                           │                │  │
│  │  ┌────────────────────────────────────────────────┐   │  │
│  │  │                  AI AGENT                       │   │  │
│  │  │                                                │   │  │
│  │  │  - LLM integration                             │   │  │
│  │  │  - Tool calling                                │   │  │
│  │  │  - Conversation management                     │   │  │
│  │  │  - Planning                                     │   │  │
│  │  │  - Error recovery                               │   │  │
│  │  └────────────────────┬───────────────────────────┘   │  │
│  │                       │                               │  │
│  │                       ▼                               │  │
│  │  ┌────────────────────────────────────────────────┐   │  │
│  │  │              ENVIRONMENT MANAGER               │   │  │
│  │  │                                                │   │  │
│  │  │  - VM lifecycle                                │   │  │
│  │  │  - Filesystem bridge                           │   │  │
│  │  │  - Shell execution                             │   │  │
│  │  │  - Process management                          │   │  │
│  │  │  - Build management                            │   │  │
│  │  │  - Preview management                           │   │  │
│  │  └────────────────────┬───────────────────────────┘   │  │
│  │                       │                               │  │
│  │                       ▼                               │  │
│  │  ┌────────────────────────────────────────────────┐   │  │
│  │  │                   UNKERNEL                     │   │  │
│  │  │                                                │   │  │
│  │  │               LINUX ENVIRONMENT                │   │  │
│  │  │                                                │   │  │
│  │  │  /workspace                                    │   │  │
│  │  │    ├── package.json                            │   │  │
│  │  │    ├── bun.lock                                │   │  │
│  │  │    ├── netlify.toml                            │   │  │
│  │  │    ├── index.html                              │   │  │
│  │  │    ├── src/                                    │   │  │
│  │  │    ├── public/                                 │   │  │
│  │  │    └── dist/                                   │   │  │
│  │  └────────────────────┬───────────────────────────┘   │  │
│  │                       │                               │  │
│  │                       ▼                               │  │
│  │               FILESYSTEM / HTTP BRIDGE                │  │
│  │                       │                               │  │
│  │                       ▼                               │  │
│  │                 SANDBOXED IFRAME                      │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 4.1 Architectural Separation

Separate the implementation into:

1. Application UI.
2. AI Agent Runtime.
3. LLM Provider Integration.
4. Tool Execution Framework.
5. Environment Manager.
6. Linux VM Integration.
7. Filesystem Adapter.
8. Shell Execution Adapter.
9. JavaScript Runtime Manager.
10. Build Manager.
11. Preview Server.
12. Browser Preview Renderer.
13. Persistence Manager.
14. Project Configuration Manager.
15. Netlify Configuration Generator.

The AI agent must interact with an abstract execution environment rather than directly depending on unkernel.

This is important for future support of other execution environments.

---

# 5. Linux Environment Integration

## 5.1 unkernel

Use unkernel as the primary Linux execution environment.

Official resources:

- https://unkernel.dev/
- https://github.com/pithings/unkernel

Before implementation, inspect its actual SDK and identify supported capabilities.

Investigate:

- VM initialization.
- VM lifecycle.
- Filesystem initialization.
- Filesystem mounting.
- Shell execution.
- Process spawning.
- Process termination.
- Network connectivity.
- Filesystem persistence.
- Host-to-guest communication.
- Guest-to-host communication.

Do not invent APIs.

Document any limitations discovered.

## 5.2 Execution Environment Interface

Implement an abstraction similar to:

```typescript
interface ExecutionEnvironment {
    initialize(): Promise<void>;

    execute(
        command: string,
        options?: ExecutionOptions
    ): Promise<ExecutionResult>;

    readFile(path: string): Promise<Uint8Array>;

    writeFile(
        path: string,
        content: Uint8Array
    ): Promise<void>;

    listFiles(path: string): Promise<FileEntry[]>;

    createDirectory(path: string): Promise<void>;

    removeFile(path: string): Promise<void>;

    shutdown(): Promise<void>;
}
```

Implement:

```typescript
class UnkernelEnvironment
    implements ExecutionEnvironment {
    // Actual unkernel SDK integration.
}
```

Extend the interface as required.

## 5.3 Environment Initialization

On startup:

1. Initialize unkernel.
2. Boot Linux.
3. Initialize the filesystem.
4. Create or mount `/workspace`.
5. Initialize shell access.
6. Verify filesystem operations.
7. Verify shell execution.
8. Test network connectivity if supported.
9. Detect available JavaScript runtimes.
10. Mark the environment ready.

Expose:

```typescript
type EnvironmentStatus =
    | "idle"
    | "initializing"
    | "booting"
    | "ready"
    | "error"
    | "stopped";
```

The AI agent must not execute commands before the environment is ready.

---

# 6. Project Workspace

All generated project source files must reside inside the Linux filesystem.

Default structure:

```text
/workspace/
    package.json
    bun.lock
    netlify.toml
    index.html

    src/
        main.tsx
        App.tsx
        components/

    public/

    node_modules/

    dist/
```

Do not hardcode this structure into the agent.

The agent must be capable of working with different project layouts.

---

# 7. JavaScript Runtime and Build Pipeline

## 7.1 Bun

Bun is the preferred runtime.

The implementation agent must validate Bun compatibility with the unkernel Linux environment.

Investigate:

- CPU architecture.
- Linux ABI compatibility.
- System calls.
- Binary execution.
- Threading.
- Networking.
- Memory requirements.

Test:

```bash
bun --version
bun install
bun run build
```

If Bun does not work, implement a compatible fallback using Node.js, Vite and esbuild.

Expose the active runtime and version in the UI.

## 7.2 Project Scaffolding

Support:

- Vanilla HTML/CSS/JavaScript.
- React.
- Vue.
- Svelte.
- TypeScript.
- Vite-based applications.

Prioritize React + TypeScript + Vite.

Allow the agent to select frameworks according to project requirements.

## 7.3 Dependency Installation

All dependencies must be installed inside the Linux environment.

Support:

```bash
bun install
```

or the equivalent command for the detected runtime.

Capture:

- Standard output.
- Standard error.
- Exit codes.
- Execution progress.

Support cancellation and timeout handling.

## 7.4 Production Build

The build manager must:

1. Identify the project's build command.
2. Execute the build inside Linux.
3. Capture output.
4. Detect failures.
5. Identify the output directory.
6. Verify the HTML entry point.
7. Notify the preview manager.
8. Record the build identifier.

Default output directory:

```text
/workspace/dist/
```

Do not assume every framework uses the same build configuration.

---

# 8. Netlify Configuration Generation

**This is a mandatory feature.**

Every website project created by Larpable must include a valid `netlify.toml` at its project root.

The AI agent must generate this file automatically during project scaffolding.

It must also maintain and update the file when the framework, build command, output directory or routing configuration changes.

## 8.1 Default Netlify Configuration

For a standard Vite + React application:

```toml
[build]
  command = "bun run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

This is the preferred configuration when Bun is supported by the selected Netlify build environment.

## 8.2 Runtime-Aware Configuration

The agent must not blindly use Bun in `netlify.toml`.

It must consider the deployment environment.

For example, if the project uses npm:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

If using pnpm:

```toml
[build]
  command = "pnpm build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

The generated configuration must match the actual project's package manager, build command and output directory.

Do not assume that Bun is available in Netlify's build environment simply because it works inside unkernel.

When Bun is selected, configure the required Netlify build environment appropriately, and ensure the Bun version is compatible with the deployment environment.

## 8.3 Framework-Specific Configuration

The agent must generate suitable configuration for different project types.

Examples:

| Framework | Build Command | Publish Directory |
|---|---|---|
| Vite + React | `bun run build` | `dist` |
| Vite + Vue | `bun run build` | `dist` |
| Vite + Svelte | `bun run build` | `dist` |
| Create React App | `npm run build` | `build` |
| Static HTML | No build required | `.` |
| Astro | `bun run build` | `dist` |

These are defaults, not hardcoded assumptions.

The agent must inspect the actual project configuration before generating deployment settings.

## 8.4 SPA Routing

For single-page applications using client-side routing, generate the appropriate fallback redirect:

```toml
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

Do not automatically add this redirect to applications that do not need SPA routing.

Preserve more specific application redirects and avoid shadowing API routes or static assets.

## 8.5 Netlify Functions

If the generated application requires serverless functions, configure the functions directory appropriately.

Example:

```toml
[functions]
  directory = "netlify/functions"
```

Do not generate unnecessary functions.

Remember that Netlify Functions are deployment-time/server-side functionality. They cannot execute inside the browser-hosted Linux environment as a substitute for a local backend.

## 8.6 Configuration Validation

Before declaring a project complete:

1. Verify `netlify.toml` exists.
2. Verify it is located at the project root.
3. Verify the build command matches `package.json`.
4. Verify the publish directory matches the actual build output.
5. Verify routing configuration.
6. Verify no unnecessary deployment settings were introduced.

Add tests for configuration generation.

## 8.7 Netlify Deployment Readiness

Larpable must produce a deployable static website.

The user should be able to download the complete project or at minimum its production artifacts.

Include:

- `netlify.toml`.
- `package.json`.
- Lockfile.
- Source files.
- Public assets.
- Build configuration.

The project must be structured so it can be deployed to Netlify without requiring Larpable's browser runtime.

Automatic Netlify deployment through OAuth or Netlify APIs is outside the initial scope.

---

# 9. AI Agent Runtime

## 9.1 Overview

Implement an autonomous coding agent capable of operating the Linux environment.

The agent must use explicit tool calling.

It must not merely generate code in chat responses.

## 9.2 LLM Provider Abstraction

Implement:

```typescript
interface LLMProvider {
    generate(
        messages: Message[],
        tools: ToolDefinition[]
    ): Promise<LLMResponse>;
}
```

Initially support:

- OpenAI-compatible APIs.
- Anthropic APIs.

Keep API keys outside the generated project and guest filesystem.

Support streaming responses.

## 9.3 Agent Tools

### Filesystem

| Tool | Purpose |
|---|---|
| `read_file` | Read files |
| `write_file` | Create or overwrite files |
| `edit_file` | Modify files |
| `list_files` | Explore directories |
| `search_files` | Search project files |
| `delete_file` | Delete files |
| `create_directory` | Create directories |

### Shell

| Tool | Purpose |
|---|---|
| `execute_command` | Execute Linux commands |
| `get_process_output` | Retrieve process output |
| `terminate_process` | Terminate processes |
| `install_dependencies` | Install dependencies |
| `build_project` | Build the application |

### Preview

| Tool | Purpose |
|---|---|
| `preview_website` | Trigger preview |
| `get_preview_status` | Retrieve preview status |
| `get_build_errors` | Retrieve build errors |

### Project Configuration

| Tool | Purpose |
|---|---|
| `inspect_project` | Inspect project structure and configuration |
| `generate_netlify_config` | Generate `netlify.toml` |
| `validate_netlify_config` | Validate deployment configuration |
| `get_project_metadata` | Retrieve project information |

All tools must have:

- Strict input schemas.
- Argument validation.
- Structured outputs.
- Explicit error handling.
- Appropriate execution timeouts.
- Observable execution events.

## 9.4 Agent Execution Loop

Implement:

```text
User message
     │
     ▼
Construct conversation context
     │
     ▼
Call LLM
     │
     ▼
LLM requests tools?
     │
     ├── No ──► Return response
     │
     ▼
Validate arguments
     │
     ▼
Execute tool
     │
     ▼
Return tool result
     │
     ▼
Call LLM again
     │
     ▼
Repeat until completion
```

Support:

- Multiple tool calls.
- Sequential execution.
- Safe parallel read-only operations.
- Streaming.
- Cancellation.
- Iteration limits.
- Error recovery.

---

# 10. Agent System Prompt

The default agent system prompt must establish the following behaviour.

You are Larpable's autonomous frontend development agent.

Your responsibility is to create complete, functional and deployable websites.

You have access to a Linux development environment through filesystem and shell tools.

All project source code, dependency installation and production builds must happen inside this Linux environment.

When creating a new project:

1. Understand the user's requirements.
2. Select an appropriate framework.
3. Scaffold the project.
4. Create the necessary source files.
5. Install dependencies.
6. Generate `netlify.toml`.
7. Verify the deployment configuration.
8. Execute the production build.
9. Inspect build output.
10. Fix errors autonomously.
11. Trigger website preview.
12. Confirm successful rendering where verification capabilities exist.

When modifying an existing project:

1. Inspect its existing architecture.
2. Understand its framework and dependencies.
3. Preserve existing functionality.
4. Modify only the necessary files.
5. Update `netlify.toml` if build or deployment settings change.
6. Rebuild the application.
7. Verify the preview.

Always ensure that the resulting project is deployable to Netlify as a standalone project.

Never claim that a build succeeded without receiving a successful build result.

Never claim that the website is deployment-ready if its Netlify configuration has not been validated.

Prefer maintainable, responsive, accessible and production-quality implementations.

---

# 11. Filesystem Bridge

Implement a bridge between:

- Host browser JavaScript.
- unkernel Linux filesystem.
- AI agent filesystem tools.

Investigate unkernel's actual filesystem APIs, including `MemoryFs` and supported mounting mechanisms.

Avoid unnecessary copying of project directories.

Support:

- File creation.
- File modification.
- File deletion.
- Directory traversal.
- Binary assets.
- Large files.
- Change notifications.

The preview manager must be notified when a new production build is available.

Do not assume filesystem modifications are automatically observable.

Implement explicit synchronization or notification mechanisms where necessary.

---

# 12. Website Preview

## 12.1 Objective

Render the actual production build generated inside the Linux environment.

Do not render a separate mock website or a host-generated approximation.

## 12.2 Preferred Architecture: HTTP Bridge

Investigate whether the Linux environment can run a static HTTP server.

Preferred flow:

```text
Linux Filesystem
       │
       ▼
/workspace/dist
       │
       ▼
Static HTTP Server
       │
       ▼
Host Browser Proxy
       │
       ▼
Sandboxed iframe
```

Support:

- HTML.
- JavaScript modules.
- CSS.
- Images.
- Fonts.
- Source maps.
- Nested paths.
- MIME types.
- Client-side routing.

If this architecture is not feasible, implement a filesystem-to-browser bridge.

Blob URLs may be used for suitable assets, but must not be treated as a universal replacement for HTTP serving.

## 12.3 Preview Isolation

Render the website inside an isolated iframe.

Use restrictive sandbox permissions.

Do not expose:

- LLM API keys.
- Host application credentials.
- Host local storage.
- Privileged application APIs.

Treat generated code as untrusted.

## 12.4 Preview Refresh

After a successful build:

1. Detect the new build.
2. Update the preview server.
3. Notify the iframe renderer.
4. Refresh the preview.
5. Preserve the viewport where possible.

Use build identifiers to prevent stale builds from replacing newer builds.

---

# 13. User Interface

## 13.1 Design Direction

Larpable should have a modern, polished developer-tool aesthetic.

The interface should feel like a combination of an AI coding environment and a browser-based IDE.

Prioritize usability and clarity over excessive visual effects.

## 13.2 Main Layout

```text
┌──────────────────────────────────────────────────────────────┐
│ LARPABLE                 Project Name             Settings   │
├───────────────────────────┬──────────────────────────────────┤
│                           │                                  │
│                           │                                  │
│                           │                                  │
│         AI CHAT            │         LIVE PREVIEW             │
│                           │                                  │
│                           │                                  │
│                           │                                  │
│                           │                                  │
│                           │                                  │
│                           │                                  │
│                           │                                  │
│                           │                                  │
├───────────────────────────┤                                  │
│                           │                                  │
│ Prompt Input              │                                  │
│                           │                                  │
├───────────────────────────┴──────────────────────────────────┤
│ Linux: Ready | Runtime: Bun | Build: Successful | Preview: On│
└──────────────────────────────────────────────────────────────┘
```

## 13.3 Chat Interface

Support:

- User messages.
- Streaming responses.
- Tool execution indicators.
- Tool output inspection.
- Build progress.
- Error notifications.
- Cancellation.
- Conversation history.

Example activity:

```text
Creating React application...
Installing dependencies...
Generating components...
Generating Netlify configuration...
Validating netlify.toml...
Building production application...
Build successful.
Refreshing preview...
```

## 13.4 Preview Interface

Provide:

- Desktop viewport.
- Tablet viewport.
- Mobile viewport.
- Refresh.
- Fullscreen.
- Separate-tab preview, where supported.
- Resizable split-pane layout.

## 13.5 Environment Status

Display actual runtime information.

Example:

```text
Linux: Ready
Runtime: Bun 1.x
Project: my-website
Build: Successful
Netlify: Configuration Valid
Preview: Running
```

Do not hardcode version numbers or status values.

---

# 14. Project Persistence

Persist project data across browser sessions.

Preferred implementation:

- unkernel persistent disk.
- IndexedDB-backed storage.

Support:

- Project creation.
- Project listing.
- Project opening.
- Project deletion.
- Session restoration.
- Conversation persistence.
- Project metadata.

Ensure that project files and configuration, including `netlify.toml`, survive browser refreshes.

---

# 15. Security

Implement:

1. Sandboxed iframe rendering.
2. Restricted host application access.
3. Filesystem boundaries.
4. Command execution limits.
5. Process timeouts.
6. Resource limits where supported.
7. Network access controls where supported.
8. Tool argument validation.
9. API key protection.
10. Explicit approval for sensitive operations.

Do not assume WebAssembly isolation alone provides complete application security.

Document actual security boundaries and limitations.

---

# 16. Error Handling

| Failure | Expected Behaviour |
|---|---|
| VM initialization failure | Display error |
| Bun unavailable | Use compatible fallback |
| Dependency installation failure | Return logs to agent |
| Build failure | Allow autonomous recovery |
| Preview server failure | Restart or report |
| Filesystem failure | Report operation failure |
| LLM API failure | Allow retry |
| Browser refresh | Restore project |
| Out-of-memory failure | Report resource limitations |
| Network failure | Report connectivity issue |
| Invalid Netlify configuration | Agent attempts correction |

Avoid infinite retry loops.

---

# 17. Performance

Optimize for browser execution.

Requirements:

- Lazy-load the Linux environment.
- Avoid unnecessary VM restarts.
- Reuse installed dependencies.
- Avoid unnecessary file transfers.
- Stream shell output.
- Support process cancellation.
- Avoid blocking the main thread.
- Use Web Workers where appropriate.
- Avoid unnecessary rebuilds.
- Maintain responsive UI during execution.

Establish performance benchmarks for initialization, dependency installation and builds.

---

# 18. Testing

Testing is mandatory.

## 18.1 Unit Tests

Test:

- Agent execution loop.
- LLM adapters.
- Tool validation.
- Filesystem operations.
- Shell execution.
- Runtime detection.
- Build manager.
- Preview manager.
- Netlify configuration generator.
- Netlify configuration validator.
- Persistence manager.

## 18.2 Integration Tests

Verify:

1. Initialize unkernel.
2. Boot Linux.
3. Create workspace.
4. Write files.
5. Execute shell commands.
6. Install dependencies.
7. Generate React application.
8. Generate `netlify.toml`.
9. Validate Netlify configuration.
10. Build production application.
11. Access generated artifacts.
12. Start preview server.
13. Render website.
14. Persist project.
15. Restore project.

## 18.3 End-to-End Test

User prompt:

"Create a modern landing page for an AI coding assistant. Use React, TypeScript and Tailwind CSS. Include a hero section, feature cards, pricing, testimonials and responsive navigation."

Expected result:

- Linux environment initializes.
- Agent scaffolds the project.
- Dependencies install.
- Source files are generated.
- `netlify.toml` is generated.
- Netlify configuration is validated.
- Production build succeeds.
- Preview server starts.
- Website renders correctly.
- User can interact with the website.

## 18.4 Modification Test

Prompt:

"Change the hero section to use a dark background and add an animated gradient."

Expected:

- Existing project is inspected.
- Relevant files are modified.
- Existing functionality is preserved.
- Build succeeds.
- Preview updates.

## 18.5 Build Recovery Test

Introduce a compilation error.

Expected:

- Build fails.
- Error logs are returned to the agent.
- Agent diagnoses the error.
- Agent fixes the source.
- Build succeeds.
- Preview updates.

## 18.6 Netlify Configuration Test

Create projects using different frameworks and package managers.

Verify:

- Correct build command.
- Correct publish directory.
- Correct package manager.
- Correct SPA fallback.
- Valid TOML syntax.
- Configuration located at project root.

---

# 19. Implementation Roadmap

Implementation must follow these phases.

## Phase 1 — unkernel Feasibility

- Inspect SDK.
- Integrate unkernel.
- Boot Linux.
- Verify shell.
- Verify filesystem.
- Verify persistence.
- Test networking.
- Test Node.js.
- Test Bun.

**Exit criterion:** Successfully execute Linux commands and manipulate files from the browser.

## Phase 2 — Build Environment

- Implement runtime detection.
- Install compatible runtime.
- Scaffold React + TypeScript.
- Install dependencies.
- Build production artifacts.
- Generate `netlify.toml`.
- Validate configuration.

**Exit criterion:** A complete frontend project can be generated and compiled inside Linux.

## Phase 3 — Preview

- Implement filesystem bridge.
- Implement HTTP bridge.
- Implement static serving.
- Implement iframe preview.
- Support assets.
- Support routing.
- Implement refresh.

**Exit criterion:** A production build generated inside Linux renders correctly in the host browser.

## Phase 4 — AI Agent

- Implement LLM abstraction.
- Implement tool calling.
- Implement filesystem tools.
- Implement shell tools.
- Implement build tools.
- Implement Netlify configuration tools.
- Implement streaming.
- Implement error recovery.

**Exit criterion:** The AI agent can autonomously create, build and preview websites.

## Phase 5 — User Interface

- Implement chat interface.
- Implement preview interface.
- Implement split-pane layout.
- Implement execution indicators.
- Implement environment status.
- Implement responsive layout.

**Exit criterion:** Complete usable Larpable application.

## Phase 6 — Persistence and Hardening

- Persist projects.
- Restore sessions.
- Improve performance.
- Implement security controls.
- Add comprehensive tests.
- Document compatibility.

**Exit criterion:** Production-quality implementation with documented limitations.

---

# 20. Engineering Standards

Treat this as a production software engineering project.

Mandatory practices:

1. Inspect the repository before modifying it.
2. Follow existing repository conventions.
3. Research unkernel SDK capabilities.
4. Validate runtime compatibility experimentally.
5. Keep environment integration abstracted.
6. Use strongly typed interfaces.
7. Write tests alongside implementation.
8. Handle errors explicitly.
9. Document architectural decisions.
10. Avoid unnecessary dependencies.
11. Avoid placeholder implementations.
12. Do not leave core features as TODOs.
13. Do not claim functionality works without testing.
14. Maintain a changelog.
15. Keep README documentation current.

If the repository has existing conventions, preserve them unless there is a compelling architectural reason to change them.

---

# 21. Definition of Done

Larpable is complete when:

- [ ] unkernel boots successfully.
- [ ] Linux commands execute.
- [ ] Filesystem operations work.
- [ ] JavaScript runtime works.
- [ ] Bun works or a documented fallback exists.
- [ ] Dependencies install inside Linux.
- [ ] React applications can be generated.
- [ ] Production builds execute inside Linux.
- [ ] Build artifacts are accessible to the browser.
- [ ] Website previews render in a sandboxed iframe.
- [ ] JavaScript modules load correctly.
- [ ] CSS and assets load correctly.
- [ ] Client-side routing works.
- [ ] LLM can autonomously create websites.
- [ ] LLM can modify existing websites.
- [ ] LLM can recover from build failures.
- [ ] Preview refreshes after successful builds.
- [ ] `netlify.toml` is generated automatically.
- [ ] Netlify configuration matches the actual project.
- [ ] Netlify configuration validation works.
- [ ] Projects persist across sessions.
- [ ] UI remains responsive during execution.
- [ ] Unit tests pass.
- [ ] Integration tests pass.
- [ ] End-to-end tests pass.
- [ ] Security limitations are documented.
- [ ] README and changelog are updated.

---

# 22. Final Instructions to the Implementation Agent

You are building Larpable from the existing repository.

Do not treat this document as a suggestion list. Treat it as the product and engineering specification.

Your first responsibility is to understand the existing codebase and identify the appropriate implementation strategy.

Do not immediately start implementing the UI.

First, investigate the technical feasibility of the underlying execution environment.

In particular, establish:

1. Can unkernel boot successfully in the target browser?
2. Can it execute Linux shell commands?
3. Can it execute Bun?
4. If Bun cannot execute, what is the best compatible alternative?
5. Can the guest filesystem be accessed efficiently from host JavaScript?
6. Can a guest HTTP server be exposed to the browser?
7. Can the generated website be rendered without copying the entire build directory unnecessarily?
8. Can project files persist across sessions?

Implement the smallest working vertical slice before expanding the system.

The first milestone must demonstrate:

```text
Browser
   │
   ▼
unkernel
   │
   ▼
Linux
   │
   ▼
JavaScript Runtime
   │
   ▼
React Application
   │
   ▼
Production Build
   │
   ▼
dist/
   │
   ▼
Browser Preview
```

Once this works, implement the AI agent.

The AI agent must be able to:

```text
Natural Language Prompt
        │
        ▼
      LLM
        │
        ▼
   Agent Tool Calls
        │
        ▼
   Linux Filesystem
        │
        ▼
   Dependency Installation
        │
        ▼
   Source Code Generation
        │
        ▼
   netlify.toml Generation
        │
        ▼
   Production Build
        │
        ▼
   Preview
```

The final product must be a complete, functional browser-native AI website development environment.

**The defining characteristic of Larpable is that the LLM does not merely generate website code: it operates a real Linux development environment running inside the user's browser, builds the application there, and renders the resulting website locally.**
