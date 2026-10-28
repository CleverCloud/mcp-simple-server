import { CcApiClient } from "@clevercloud/client/cc-api-client.js";
import { FileStore } from "@clevercloud/client/cc-api-file-store.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import type { Config } from "../config.ts";

export function createClient(config: Config): CcApiClient {
  // Resource ID cache belongs in XDG_CACHE_HOME, not config
  const cacheBase =
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const cacheDir = join(cacheBase, "mcp-simple-server");
  mkdirSync(cacheDir, { recursive: true });

  const storePath = join(cacheDir, "resource-id-cache.json");

  return new CcApiClient({
    authMethod: {
      type: "api-token",
      apiToken: config.apiToken,
    },
    resourceIdResolverStore: new FileStore(storePath),
  });
}
