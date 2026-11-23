import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { DEFAULT_WORKSPACE_PATH } from "@/env/default-project";
import { summarizeDistro } from "@/env/distro";
import { distroAssetsQueryOptions } from "@/env/queries";
import { applySupportSimulation, detectSupport } from "@/env/support";
import { Dashboard } from "@/ui/dashboard";
import { EnvironmentPanel } from "@/ui/environment-panel";
import { PreviewPanel } from "@/ui/preview-frame";
import { TerminalPanel } from "@/ui/terminal-panel";
import { useEnvironmentBoot } from "@/ui/use-environment";

/**
 * Container: owns the async reads and the booted environment, and hands plain values
 * to the dashboard. Keeping that here is what lets `Dashboard` and `EnvironmentPanel`
 * stay deterministic in tests.
 */
export function App() {
  const support = useMemo(
    () => applySupportSimulation(detectSupport(), window.location.search, import.meta.env.DEV),
    [],
  );
  const environment = useEnvironmentBoot();

  const distroQuery = useQuery(distroAssetsQueryOptions);
  const distro = summarizeDistro(
    distroQuery.data ?? null,
    distroQuery.error ? distroQuery.error.message : null,
  );

  return (
    <Dashboard
      version={__APP_VERSION__}
      support={support}
      environment={environment.snapshot}
      distro={distro}
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
    />
  );
}
