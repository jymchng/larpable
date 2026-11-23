/**
 * The machine's status, as React state — including "there is no machine".
 *
 * `environment.status()` is a method, not a signal: reading it during render is always current,
 * but nothing re-renders when it changes. That is how the prompt box stayed disabled after the
 * guest booted (measured in `bun run acceptance:ui`: the guest reported Ready in 5.6 s and the
 * textarea still said "The agent is not available yet."). This hook turns the environment's own
 * `onStatus` subscription into state, so every control that derives "can I act?" from the
 * machine re-renders at the moment the machine changes.
 *
 * `missing` is a distinct value because "there is no machine" and "the machine is idle" are
 * different sentences, and the first one is what the page shows before a boot is attempted.
 *
 * The subscribe/unsubscribe pair is an effect for the same reason as everywhere else: a
 * component that unmounts mid-boot must not keep writing into a dead tree.
 */

import { useEffect, useState } from "react";

import type { ExecutionEnvironment } from "@/env/execution";
import { machineStatusOf, type MachineStatus } from "@/ui/availability";

export function useMachineStatus(environment: ExecutionEnvironment | null): MachineStatus {
  const [status, setStatus] = useState<MachineStatus>(() => machineStatusOf(environment));

  useEffect(() => {
    if (environment === null) {
      setStatus("missing");
      return;
    }
    setStatus(environment.status());
    return environment.onStatus((snapshot) => setStatus(snapshot.status));
  }, [environment]);

  return status;
}
