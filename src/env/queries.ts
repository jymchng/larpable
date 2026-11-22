import { queryOptions } from "@tanstack/react-query";

import {
  loadDistroManifest,
  probeDistroAsset,
  type DistroAssetStatus,
} from "@/env/distro";

/**
 * Which Linux images this deployment can actually serve. Checked with `HEAD`
 * requests, so opening the app never downloads a 4 MB image by accident.
 */
export const distroAssetsQueryOptions = queryOptions<DistroAssetStatus[], Error>({
  queryKey: ["distro", "assets"],
  queryFn: async () => {
    const manifest = await loadDistroManifest();
    return Promise.all(manifest.distros.map((entry) => probeDistroAsset(entry)));
  },
  staleTime: 5 * 60_000,
  retry: 0,
});
