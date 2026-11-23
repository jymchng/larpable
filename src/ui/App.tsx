import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { DEFAULT_WORKSPACE_PATH } from "@/env/default-project";
import { summarizeDistro } from "@/env/distro";
import { distroAssetsQueryOptions } from "@/env/queries";
import { applySupportSimulation, detectSupport } from "@/env/support";
import { initialBuild } from "@/ui/build-state";
import { ChatPanel } from "@/ui/chat-panel";
import { Dashboard } from "@/ui/dashboard";
import { EnvironmentPanel } from "@/ui/environment-panel";
import { PreviewPane } from "@/ui/preview-pane";
import { SettingsPanel } from "@/ui/settings-panel";
import { StatusBar } from "@/ui/status-bar-view";
import type { StatusInput } from "@/ui/status-bar";
import { TerminalPanel } from "@/ui/terminal-panel";
import { useAgentChat } from "@/ui/use-agent-chat";
import { useEnvironmentBoot } from "@/ui/use-environment";
import { useAppPreview } from "@/ui/use-app-preview";
import { useLlmSettings } from "@/ui/use-llm-settings";
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
  // No build manager is constructed here yet, so the session's build/netlify/preview ports
  // are absent and the tools that need them say so in their own words rather than pretending.
  const chat = useAgentChat({
    environment: environment.environment,
    settings: settings.settings,
  });

  const distroQuery = useQuery(distroAssetsQueryOptions);
  const distro = summarizeDistro(
    distroQuery.data ?? null,
    distroQuery.error ? distroQuery.error.message : null,
  );

  // Every segment is derived from an object that owns the fact: the environment snapshot, the
  // build status the build hook publishes (no build has run here yet), the Netlify verdict the
  // session recorded (none yet) and the preview controller's own phase.
  const statusInput: StatusInput = {
    environment: environment.snapshot,
    project: { name: null, root: DEFAULT_WORKSPACE_PATH },
    build: initialBuild(),
    netlify: { kind: "unknown" },
    preview: preview.phase,
  };

  return (
    <Dashboard
      version={__APP_VERSION__}
      support={support}
      environment={environment.snapshot}
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
          onRefresh={() => preview.refresh()}
          available={preview.available}
          app={appPreview}
        />
      }
    />
  );
}
