import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { DEFAULT_WORKSPACE_PATH } from "@/env/default-project";
import { summarizeDistro } from "@/env/distro";
import { distroAssetsQueryOptions } from "@/env/queries";
import { applySupportSimulation, detectSupport } from "@/env/support";
import { ChatPanel } from "@/ui/chat-panel";
import { detectHandset } from "@/ui/mobile";
import { DEFAULT_STAGE, stageFromSearch } from "@/ui/stage";
import { Dashboard } from "@/ui/dashboard";
import { EnvironmentPanel } from "@/ui/environment-panel";
import { PreviewPane } from "@/ui/preview-pane";
import { SettingsPanel } from "@/ui/settings-panel";
import { StatusBar } from "@/ui/status-bar-view";
import type { StatusInput } from "@/ui/status-bar";
import { TerminalPanel } from "@/ui/terminal-panel";
import { useAgentChat } from "@/ui/use-agent-chat";
import { useBuild } from "@/ui/use-build";
import { useEnvironmentBoot } from "@/ui/use-environment";
import { useAppPreview } from "@/ui/use-app-preview";
import { useLlmSettings } from "@/ui/use-llm-settings";
import { useNetlify } from "@/ui/use-netlify";
import { usePreview } from "@/ui/use-preview";

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
  // The preview shares the booted machine with the terminal: same kernel, one HTTP door.
  // It is created lazily and does nothing at all until the user asks for a build.
  const preview = usePreview({
    environment: environment.environment,
    http: environment.guestHttp,
  });
  // The other preview: the project's own server (`next start`), for projects that have no
  // `dist/` because they render per request. It is idle until the user clicks "Run the app",
  // and it is torn down with the machine, so it never holds a port after shutdown.
  const appPreview = useAppPreview({
    environment: environment.environment,
    http: environment.guestHttp,
  });

  const settings = useLlmSettings();
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

  const distroQuery = useQuery(distroAssetsQueryOptions);
  const distro = summarizeDistro(
    distroQuery.data ?? null,
    distroQuery.error ? distroQuery.error.message : null,
  );

  // Every segment is derived from an object that owns the fact: the environment snapshot, the
  // build status the build hook publishes, the Netlify verdict the Netlify port reported for
  // the last run (unknown until one has), and the preview controller's own phase.
  const statusInput: StatusInput = {
    environment: environment.snapshot,
    project: { name: null, root: DEFAULT_WORKSPACE_PATH },
    build: build.status,
    netlify: netlify.status,
    preview: preview.phase,
  };

  return (
    <Dashboard
      version={__APP_VERSION__}
      support={support}
      environment={environment.snapshot}
      initialStage={initialStage}
      distro={distro}
      statusBar={<StatusBar input={statusInput} />}
      settings={
        <SettingsPanel
          settings={settings.settings}
          onChange={settings.update}
          problem={null}
        />
      }
      chat={
        <ChatPanel
          state={chat.state}
          onSend={chat.send}
          onStop={chat.stop}
          unavailableReason={chat.problem}
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
  );
}
