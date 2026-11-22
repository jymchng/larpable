import { QueryClient } from "@tanstack/react-query";

/**
 * One client for the whole app. Agent runs, builds and environment probing are all
 * async requests against the same guest, so retries are deliberately conservative:
 * a failed VM call is usually a real error, not a network blip.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4_000),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
