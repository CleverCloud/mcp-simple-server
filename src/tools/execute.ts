import type { CcApiClient } from "@clevercloud/client/cc-api-client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { commands } from "../commands/command-registry.js";
import type { Config } from "../config.js";
import { textResult } from "./result.js";

export function registerExecuteTool(
  server: McpServer,
  client: CcApiClient,
  config: Config,
): void {
  const timeoutSec = Math.round(config.executionTimeoutMs / 1000);

  server.tool(
    "execute",
    `Execute JavaScript code against the Clever Cloud API using a pre-authenticated client.

Available in scope:
- client: CcApiClient instance (pre-authenticated with API token)
- commands: object with all command classes (e.g., commands.ListApplicationCommand)
- signal: AbortSignal that fires on timeout — pass to client.send(command, { signal }) for cancellable requests

Usage pattern:
  const apps = await client.send(new commands.ListApplicationCommand({ ownerId: "orga_xxx" }), { signal });
  return apps;

Notes:
- The code runs as an async function body. Use 'return' to return a result.
- ownerId is auto-resolved from applicationId/addonId — you can often omit it.
- Some commands take no parameters: new commands.GetProfileCommand()
- For stream commands, use client.stream() instead of client.send().
- Use the search tool first to discover available commands and their parameters.
- Timeout: ${timeoutSec}s.`,
    {
      code: z
        .string()
        .describe(
          "JavaScript code to execute. Runs as an async function body with client and commands in scope. Use 'return' to return a result.",
        ),
    },
    async ({ code }) => {
      const logs: string[] = [];
      const capturedConsole = {
        log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
        warn: (...args: unknown[]) =>
          logs.push(`[WARN] ${args.map(String).join(" ")}`),
        error: (...args: unknown[]) =>
          logs.push(`[ERROR] ${args.map(String).join(" ")}`),
      };

      // Signal is exposed to user code for clean cancellation of network requests.
      // The Promise.race below also enforces the timeout as a hard backstop, in case
      // the user code doesn't forward the signal to its async operations.
      const signal = AbortSignal.timeout(config.executionTimeoutMs);
      const timeoutPromise = new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      });

      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function(
          "client",
          "commands",
          "console",
          "signal",
          `return (async () => { ${code} })();`,
        ) as (
          client: CcApiClient,
          commands: Record<string, unknown>,
          console: typeof capturedConsole,
          signal: AbortSignal,
        ) => Promise<unknown>;

        const result = await Promise.race([
          fn(client, commands, capturedConsole, signal),
          timeoutPromise,
        ]);

        const json = JSON.stringify(result, null, 2);
        let resultStr = json !== undefined ? json : "undefined";

        if (resultStr.length > config.maxOutputLength) {
          resultStr =
            resultStr.slice(0, config.maxOutputLength) +
            `\n\n... (truncated, ${resultStr.length} total chars)`;
        }

        const output = [
          logs.length > 0 ? `Console output:\n${logs.join("\n")}\n\n` : "",
          `Result:\n${resultStr}`,
        ].join("");

        return textResult(output);
      } catch (error: unknown) {
        const isTimeout =
          error instanceof DOMException && error.name === "TimeoutError";
        const errorMessage = isTimeout
          ? `Execution timed out after ${config.executionTimeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
        const errorStack =
          !isTimeout && error instanceof Error ? error.stack : undefined;

        const output = [
          logs.length > 0 ? `Console output:\n${logs.join("\n")}\n\n` : "",
          `Error: ${errorMessage}`,
          errorStack ? `\nStack: ${errorStack}` : "",
        ].join("");

        return textResult(output, true);
      }
    },
  );
}
