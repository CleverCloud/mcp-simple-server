#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createClient } from "./client/create-client.js";
import { getConfig } from "./config.js";
import { registerDocTool } from "./tools/doc.js";
import { registerExecuteTool } from "./tools/execute.js";
import { registerSearchTool } from "./tools/search.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
const { name, version } = JSON.parse(readFileSync(pkgPath, "utf-8"));

async function main() {
  const config = getConfig();
  const client = createClient(config);

  const server = new McpServer({ name, version });

  registerSearchTool(server);
  registerExecuteTool(server, client, config);
  await registerDocTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
