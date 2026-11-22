import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { summarizeDistro } from "@/env/distro";
import { distroAssetsQueryOptions } from "@/env/queries";
import { INITIAL_ENVIRONMENT } from "@/env/status";
import { detectSupport } from "@/env/support";
import { Dashboard } from "@/ui/dashboard";

/**
 * Container: owns the async reads and hands plain values to the dashboard.
 * Keeping the fetch here is what lets `Dashboard` stay deterministic in tests.
 */
export function App() {
  const support = useMemo(() => detectSupport(), []);
  const environment = INITIAL_ENVIRONMENT;

  const distroQuery = useQuery(distroAssetsQueryOptions);
  const distro = summarizeDistro(
    distroQuery.data ?? null,
    distroQuery.error ? distroQuery.error.message : null,
  );

  return (
    <Dashboard
      version={__APP_VERSION__}
      support={support}
      environment={environment}
      distro={distro}
    />
  );
}
