import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { DEFAULT_WORKSPACE_PATH } from "@/env/default-project";
import { summarizeDistro } from "@/env/distro";
import { distroAssetsQueryOptions } from "@/env/queries";
import { applySupportSimulation, detectSupport } from "@/env/support";
import { ChatPanel } from "@/ui/chat-panel";
import { ToastHost } from "@/ui/components/toast";
import { detectHandset } from "@/ui/mobile";
import { DEFAULT_STAGE, stageFromSearch } from "@/ui/stage";
import { Dashboard } from "@/ui/dashboard";
import { EnvironmentPanel } from "@/ui/environment-panel";
import { PreviewPane } from "@/ui/preview-pane";
import { ProjectSwitcher } from "@/ui/project-switcher";
import { SettingsPanel } from "@/ui/settings-panel";
import { StatusFacts } from "@/ui/status-bar-view";
import type { StatusInput } from "@/ui/status-bar";
import { TerminalPanel } from "@/ui/terminal-panel";
import { NO_TERMINAL, type TerminalStatus } from "@/ui/terminal-connection";
import { useAgentChat } from "@/ui/use-agent-chat";
import { useAutoBoot } from "@/ui/use-autoboot";
import { useBuild } from "@/ui/use-build";
import { useEnvironmentBoot } from "@/ui/use-environment";
import { useAppPreview } from "@/ui/use-app-preview";
import { useLlmSettings } from "@/ui/use-llm-settings";
import { usePreviewSettings } from "@/ui/use-preview-settings";
import { useNotifications } from "@/ui/use-notifications";
import { useNetlify } from "@/ui/use-netlify";
import { usePreview } from "@/ui/use-preview";
import { useProjects } from "@/ui/use-projects";
import { useToast } from "@/ui/use-toast";

/**
 * Container: owns the async reads and the booted environment, and hands plain values
 * to the dashboard. Keeping that here is what lets `Dashboard` and `EnvironmentPanel`
 * stay deterministic in tests.
 *
 * §13's two live surfaces are wired here and nowhere else: the provider settings (the
 * `localStorage` hook) and the conversation (the session hook), plus the six-fact status
 * bar derived from the objects that already know the answers. The pieces are separate files
 * because each is testable without a VM; this file is the one place that knows they exist.
 */
export function App() {
  const support = useMemo(
    () => applySupportSimulation(detectSupport(), window.location.search, import.meta.env.DEV),
    [],
  );
  // Which half of the app a phone opens on, from `?pane=preview` when a link says so. Read once:
  // the switcher owns the value afterwards, so a deep link does not fight the user's presses.
  const initialStage = useMemo(
    () => (typeof window === "undefined" ? DEFAULT_STAGE : stageFromSearch(window.location.search)),
    [],
  );
  // The device, read once: the handset notes are about the hardware, which does not change
  // during a session, and re-reading a user agent on every render buys nothing.
  const handset = useMemo(() => detectHandset(), []);
  const environment = useEnvironmentBoot();
  // The machine starts with the page. One attempt per mount, none on a browser that cannot
  // boot, and no second attempt after a failure or a shut-down: the retry is a person's press,
  // not a loop. The rules — and why the indicator is derived from status rather than a timer —
  // are in `src/ui/autoboot.ts`.
  useAutoBoot({
    supported: support.ok,
    status: environment.snapshot.status,
    boot: environment.boot,
  });
  // The preview shares the booted machine with the terminal: same kernel, one HTTP door.
  // It is created lazily and does nothing at all until the user asks for a build. The port and
  // the build directory are the user's (Settings → Preview): one port for both previews, and
  // the directory a static build is read from.
  const previewSettings = usePreviewSettings();
  const preview = usePreview({
    environment: environment.environment,
    http: environment.guestHttp,
    port: previewSettings.settings.port,
    root: previewSettings.settings.buildDirectory,
  });
  // The other preview: the project's own server (`next start`), for projects that have no
  // `dist/` because they render per request. It is idle until the user clicks "Run the app",
  // and it is torn down with the machine, so it never holds a port after shutdown. The same
  // port setting applies: the project's start script is *told* the port (see `startAppServer`),
  // so the number the pane knocks on and the number the app listens on cannot drift apart.
  const appPreview = useAppPreview({
    environment: environment.environment,
    http: environment.guestHttp,
    port: previewSettings.settings.port,
  });

  const settings = useLlmSettings();
  // Projects: the manager, the store that remembers them and the autosave watcher, bound to the
  // booted machine. Null until boot, because a project is files in `/workspace` and there is no
  // `/workspace` before the kernel is up \u2014 the hook says so rather than listing nothing.
  const projects = useProjects({ environment: environment.environment });
  const activeProjectName = projects.state.active?.name ?? null;
  // The build: one controller per machine, behind the warm-runtime gate, publishing into the
  // pane's strip and the status bar. Its successful id is what the preview publishes, so the
  // frame always shows exactly the bytes that were built.
  const build = useBuild({
    environment: environment.environment,
    onBuilt: (result) => preview.refresh(result.id),
  });
  // The agent's Netlify tool validates against the last successful build, read at call time;
  // the run's own verdict is what the status bar's Netlify segment renders.
  const netlify = useNetlify({
    environment: environment.environment,
    lastBuild: () => build.port?.lastSuccessfulBuild() ?? null,
  });
  // The tools receive the same objects the panes render: one build, one preview, one truth.
  const chat = useAgentChat({
    environment: environment.environment,
    settings: settings.settings,
    build: build.port,
    netlify: netlify.port,
    preview: preview.port,
  });

  // Everything the app has to *announce* is a toast (user request: "ALL NOTIFICATIONS SHOULD BE
  // TOASTS IN APPROPRIATE COLORS"). `notifications.ts` derives one notification per source from
  // the objects above — the machine, the build, the preview, the app server, the Netlify check —
  // and names its colour; this hook raises whatever is new and forgets whatever has gone quiet.
  //
  // One call site, on purpose: a second place that raised toasts would be a second place where the
  // colours, the ids and the durations could disagree.
  const toast = useToast();
  useNotifications(toast.raise, {
    environment: environment.snapshot,
    bootStage: environment.stage,
    build: build.status,
    preview: preview.phase,
    app: appPreview.state,
    netlify: netlify.status,
  });

  const distroQuery = useQuery(distroAssetsQueryOptions);
  const distro = summarizeDistro(
    distroQuery.data ?? null,
    distroQuery.error ? distroQuery.error.message : null,
  );

  // The terminal's own answer to "is my shell attached?", held here because the debug popover
  // outlives the panel: the panel is a sibling in the layout and unmounts on the preview stage,
  // and a fact that vanished with it would be worse than no fact. The panel reports through
  // `onConnectionChange`; this is the one place that state is stored (user request: "remove the
  // green dot from the terminal panel and move its information into the debug popover").
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>(NO_TERMINAL);

  // Every segment is derived from an object that owns the fact: the environment snapshot, the
  // build status the build hook publishes, the Netlify verdict the Netlify port reported for
  // the last run (unknown until one has), the preview controller's own phase, and the terminal's
  // connection state.
  const statusInput: StatusInput = {
    environment: environment.snapshot,
    project: { name: activeProjectName, root: DEFAULT_WORKSPACE_PATH },
    build: build.status,
    netlify: netlify.status,
    preview: preview.phase,
    terminal: terminalStatus,
  };

  return (
    <>
      <Dashboard
      version={__APP_VERSION__}
      support={support}
      environment={environment.snapshot}
      initialStage={initialStage}
      distro={distro}
      boot={{
        busy: environment.busy,
        stage: environment.stage,
        error: environment.error,
        onRetry: environment.boot,
      }}
      statusFacts={<StatusFacts input={statusInput} />}
      projects={
        <ProjectSwitcher
          state={projects.state}
          persistent={projects.persistent}
          unavailable={projects.unavailable}
          busy={projects.busy}
          error={projects.error ?? projects.state.error}
          onCreate={projects.create}
          onOpen={projects.open}
          onRename={projects.rename}
          onRemove={projects.remove}
        />
      }
      projectName={activeProjectName}
      settings={
        <SettingsPanel
          settings={settings.settings}
          onChange={settings.update}
          preview={previewSettings}
          problem={null}
        />
      }
      chat={
        <ChatPanel
          state={chat.state}
          onSend={chat.send}
          onStop={chat.stop}
          // `problem` is a *setting* gap (no key, no model) and is printed under the prompt;
          // `blockedReason` is the machine's half, which is a toast and only reaches the layout
          // as the send button's tooltip (user request: "DO NOT DUPLICATE: YOU ALREADY HAVE A
          // TOAST").
          unavailableReason={chat.problem}
          blocked={chat.blocked}
          blockedReason={chat.blockedReason}
        />
      }
      environmentPanel={
        <EnvironmentPanel
          support={support}
          snapshot={environment.snapshot}
          stage={environment.stage}
          busy={environment.busy}
          selfTest={environment.selfTest}
          selfTestBusy={environment.selfTestBusy}
          bootDurationMs={environment.bootDurationMs}
          error={environment.error}
          handset={handset}
          // It is the body of the debug popover, so it drops its own card framing and keeps
          // the controls.
          compact
          onBoot={environment.boot}
          onSelfTest={environment.runSelfTest}
          onShutdown={environment.shutdown}
        />
      }
      terminal={
        <TerminalPanel
          ready={environment.snapshot.status === "ready"}
          cwd={DEFAULT_WORKSPACE_PATH}
          openShell={environment.openShell}
          unavailableReason={environment.error}
        />
      }
      preview={
        <PreviewPane
          phase={preview.phase}
          // The reload arrow hands back the build id it is showing, so a reload re-publishes
          // that build rather than whatever happens to be in `dist/` now.
          onRefresh={(buildId) => preview.refresh(buildId)}
          available={preview.available}
          app={appPreview}
          build={build}
        />
      }
      />
      {/* Outside the shell, not inside it: the toast stack is `fixed`, and a `fixed` child of a
          container with `overflow-x-clip` would be clipped by it. */}
      <ToastHost toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  );
}
