import { describe, expect, it } from "vitest";

import {
  DEFAULT_CPUS,
  DEFAULT_DISTRO_URL,
  DEFAULT_MEMORY_MIB,
  DEFAULT_WISP_SERVERS,
  resolveBrowserEnvironmentConfig,
} from "@/env/boot";
import { DEFAULT_PROJECT_TREE, DEFAULT_WORKSPACE_PATH, defaultProjectFiles } from "@/env/default-project";

describe("default project", () => {
  it("is a real Vite site, not an empty workspace", () => {
    expect(Object.keys(DEFAULT_PROJECT_TREE).sort()).toEqual([
      "README.md",
      "index.html",
      "package.json",
      "src/main.ts",
      "src/style.css",
    ]);

    const pkg = JSON.parse(DEFAULT_PROJECT_TREE["package.json"] ?? "{}") as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.scripts?.build).toBe("vite build");
    expect(pkg.devDependencies?.vite).toBeTruthy();
    expect(DEFAULT_PROJECT_TREE["index.html"]).toContain("/src/main.ts");
  });

  it("returns a copy, so a caller cannot mutate the shipped starter", () => {
    const files = defaultProjectFiles();
    files["package.json"] = "{}";
    expect(DEFAULT_PROJECT_TREE["package.json"]).toContain("\"name\": \"my-site\"");
  });
});

describe("resolveBrowserEnvironmentConfig", () => {
  it("uses the values the acceptance run boots with", () => {
    const config = resolveBrowserEnvironmentConfig({}, {});

    expect(config).toEqual({
      distroUrl: DEFAULT_DISTRO_URL,
      workspacePath: DEFAULT_WORKSPACE_PATH,
      memoryMiB: DEFAULT_MEMORY_MIB,
      cpus: DEFAULT_CPUS,
      network: "wisp",
      // Not `[]`: an empty list hands the choice to unkernel's default proxy, which
      // refuses every origin but localhost, so the deployed guest has no network at all.
      wispServers: [...DEFAULT_WISP_SERVERS],
      wispServer: DEFAULT_WISP_SERVERS[0],
      worker: true,
      persistentDataDisk: true,
      commandTimeoutMs: 600_000,
    });
  });

  it("defaults to a Wisp proxy that accepts a deployment origin, not unkernel's", () => {
    // Measured from https://larpable.netlify.app: `wss://wisp.pi0.io:6680/` errors on the
    // handshake, `wss://wisp.mercurywork.shop/` opens. With pi0.io the guest boots and
    // looks healthy but `curl` fails with error 7 for every URL.
    expect(DEFAULT_WISP_SERVERS.length).toBeGreaterThan(0);
    expect(DEFAULT_WISP_SERVERS).not.toContain("wss://wisp.pi0.io:6680/");
    expect(DEFAULT_WISP_SERVERS[0]).toBe("wss://wisp.mercurywork.shop/");
    for (const server of DEFAULT_WISP_SERVERS) expect(server.startsWith("wss://")).toBe(true);
  });

  it("lets ?wisp= in the address bar replace the default", () => {
    // The escape hatch that unblocked the deployed app before this default existed: one
    // URL, editable in the address bar, no rebuild.
    const config = resolveBrowserEnvironmentConfig({}, {}, "?wisp=wss://self.example/");

    expect(config.wispServers).toEqual(["wss://self.example/"]);
    expect(config.wispServer).toBe("wss://self.example/");
  });

  it("accepts a comma-separated proxy list from the environment, in order", () => {
    const config = resolveBrowserEnvironmentConfig(
      {},
      { VITE_WISP_SERVERS: "wss://a.example/, wss://b.example/" },
    );

    expect(config.wispServers).toEqual(["wss://a.example/", "wss://b.example/"]);
    expect(config.wispServer).toBe("wss://a.example/");
  });

  it("prefers ?wisp= over VITE_WISP_SERVERS, so a URL can rescue a bad build", () => {
    const config = resolveBrowserEnvironmentConfig(
      {},
      { VITE_WISP_SERVERS: "wss://build.example/" },
      "?wisp=wss://bar.example/",
    );

    expect(config.wispServers).toEqual(["wss://bar.example/"]);
  });

  it("lets deployment variables override every default", () => {
    const config = resolveBrowserEnvironmentConfig(
      {},
      {
        VITE_DISTRO_URL: "/distros/custom.erofs",
        VITE_LINUX_MEMORY_MIB: "512",
        VITE_LINUX_CPUS: "4",
        VITE_LINUX_NETWORK: "0",
        VITE_WISP_SERVER: "wss://wisp.example.com/",
        VITE_LINUX_WORKER: "0",
        VITE_LINUX_DATA_DISK: "no",
        VITE_COMMAND_TIMEOUT_MS: "90000",
      },
    );

    expect(config).toMatchObject({
      distroUrl: "/distros/custom.erofs",
      memoryMiB: 512,
      cpus: 4,
      network: "none",
      wispServer: "wss://wisp.example.com/",
      worker: false,
      persistentDataDisk: false,
      commandTimeoutMs: 90_000,
    });
  });

  it("clamps nonsense instead of booting a machine with 0 MiB", () => {
    const config = resolveBrowserEnvironmentConfig(
      {},
      { VITE_LINUX_MEMORY_MIB: "1", VITE_LINUX_CPUS: "99", VITE_COMMAND_TIMEOUT_MS: "soon" },
    );

    expect(config.memoryMiB).toBe(128);
    expect(config.cpus).toBe(4);
    expect(config.commandTimeoutMs).toBe(600_000);
  });

  it("prefers an explicit override over the environment", () => {
    const config = resolveBrowserEnvironmentConfig(
      { cpus: 1, network: "none", wispServer: "wss://mine.example/" },
      { VITE_LINUX_CPUS: "4", VITE_LINUX_NETWORK: "1" },
    );

    expect(config.cpus).toBe(1);
    expect(config.network).toBe("none");
    expect(config.wispServer).toBe("wss://mine.example/");
  });
});
