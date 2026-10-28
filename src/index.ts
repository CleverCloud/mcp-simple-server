#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createClient } from "./client/create-client.ts";
import { getConfig } from "./config.ts";
import { registerDocTool } from "./tools/doc.ts";
import { registerExecuteTool } from "./tools/execute.ts";
import { createTextResult, inspectSafely, maskToken } from "./tools/result.ts";
import { registerSearchTool } from "./tools/search.ts";

const pkgPath = join(import.meta.dirname, "../package.json");
const { name, version } = JSON.parse(readFileSync(pkgPath, "utf-8"));

async function main() {
  const config = getConfig();
  const client = createClient(config);

  // Code run by the execute tool may leave rejected promises behind, for instance
  // once it timed out: they are logged rather than allowed to stop the server
  process.on("unhandledRejection", (reason) => {
    const description = maskToken(inspectSafely(reason), config.apiToken);
    console.error(`Ignored unhandled rejection: ${description.slice(0, 2_000)}`);
  });

  const server = new McpServer({ name, version });

  const textResult = createTextResult(config);
  registerSearchTool(server, textResult);
  registerExecuteTool(server, textResult, client, config);
  registerDocTool(server, textResult, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
