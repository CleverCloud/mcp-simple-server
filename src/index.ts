#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createClient } from "./client/create-client.ts";
import { getConfig } from "./config.ts";
import { registerDocTool } from "./tools/doc.ts";
import { registerExecuteTool } from "./tools/execute.ts";
import { createTextResult } from "./tools/result.ts";
import { registerSearchTool } from "./tools/search.ts";

const pkgPath = join(import.meta.dirname, "../package.json");
const { name, version } = JSON.parse(readFileSync(pkgPath, "utf-8"));

async function main() {
  const config = getConfig();
  const client = createClient(config);

  const server = new McpServer({ name, version });

  const textResult = createTextResult(config);
  registerSearchTool(server, textResult);
  registerExecuteTool(server, textResult, client, config);
  await registerDocTool(server, textResult);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
