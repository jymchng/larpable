import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

import { createQueryClient } from "@/ui/query";

export function AppProviders({ children }: { children: ReactNode }) {
  // Created lazily once per mount: a new client on every render would restart
  // every in-flight query, including the environment probes.
  const [client] = useState(createQueryClient);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
