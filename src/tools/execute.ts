import { formatWithOptions } from "node:util";

import type { CcApiClient } from "@clevercloud/client/cc-api-client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createExecutionClient } from "../client/execution-client.ts";
import { commands } from "../commands/command-registry.ts";
import type { Config } from "../config.ts";
import { INSPECT_OPTIONS, inspectSafely, maskToken, type TextResult } from "./result.ts";

const AsyncFunction = async function () {}.constructor as new (
  ...params: string[]
) => (...args: unknown[]) => Promise<unknown>;

export function registerExecuteTool(
  server: McpServer,
  textResult: TextResult,
  client: CcApiClient,
  config: Config,
): void {
  server.registerTool(
    "execute",
    {
      title: "Run code against the Clever Cloud API",
      description: `Run JavaScript against the Clever Cloud API with a pre-authenticated client. The code is the body of an async function: \`return\` the result, it is sent back as JSON.

In scope:
- client.send(command): runs an API command, resolves to its result
- client.stream(command): opens a stream command (see below)
- commands: every command class, e.g. commands.ListApplicationCommand; find them and their params with the search tool
- console: its output is sent back with the result
- signal: aborts on timeout or cancellation; the client requests already use it

Example:
  const apps = await client.send(new commands.ListApplicationCommand({ ownerId: "orga_xxx" }));
  return apps.map(({ id, name, state }) => ({ id, name, state }));

Streams are closed once the execution ends:
  const stream = await client.stream(new commands.StreamApplicationRuntimeLogCommand({ applicationId: "app_xxx" }));
  const logs = [];
  stream.onLog((log) => { logs.push(log); if (logs.length === 20) stream.close(); });
  await stream.start(); // resolves once the stream is closed
  return logs;

Notes:
- ownerId is resolved from applicationId or addonId when omitted.
- Commands without params: new commands.GetProfileCommand()
- Times out after ${config.executionTimeoutMs / 1000}s. A timed out or cancelled run may already have changed things: check before retrying.`,
      inputSchema: {
        code: z
          .string()
          .describe(
            "Body of an async function, with client, commands, console and signal in scope. Use `return` to send back a result.",
          ),
      },
      // The code can call any API command, including destructive ones
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ code }, { signal: cancellation }) => {
      const signal = AbortSignal.any([cancellation, AbortSignal.timeout(config.executionTimeoutMs)]);
      const output = createConsole(config.maxOutputLength, (text) => maskToken(text, config.apiToken));
      const execution = createExecutionClient(client, signal);
      const aborted = Promise.withResolvers<never>();
      const onAbort = () => aborted.reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        signal.throwIfAborted();
        const run = new AsyncFunction("client", "commands", "console", "signal", code);
        // Racing the abort answers on time even if the code ignores the signal,
        // the code then keeps running in the background until it settles
        const result = await Promise.race([
          run(execution.client, commands, output.console, execution.signal),
          aborted.promise,
        ]);
        return textResult(output.appendTo(formatResult(result)));
      } catch (error) {
        return textResult(output.appendTo(describeFailure(error, signal, config.executionTimeoutMs)), true);
      } finally {
        signal.removeEventListener("abort", onAbort);
        execution.close();
      }
    },
  );
}

/**
 * A console whose lines are kept, masked then cut to `budget` characters in
 * all, to send back after the result
 */
function createConsole(budget: number, mask: (text: string) => string) {
  const lines: string[] = [];
  let size = 0;
  let omitted = 0;
  const writer =
    (prefix: string) =>
    (...args: unknown[]) => {
      if (size >= budget) {
        omitted++;
        return;
      }
      const line = mask(prefix + formatWithOptions(INSPECT_OPTIONS, ...args)).slice(0, budget - size);
      lines.push(line);
      // The newline joining the lines counts too
      size += line.length + 1;
    };

  return {
    console: {
      log: writer(""),
      info: writer(""),
      debug: writer(""),
      warn: writer("[WARN] "),
      error: writer("[ERROR] "),
    },
    appendTo: (text: string) => {
      if (lines.length === 0) return text;
      const notice = omitted > 0 ? `\n... (${omitted} more lines omitted)` : "";
      return `${text}\n\nConsole output:\n${lines.join("\n")}${notice}`;
    },
  };
}

function formatResult(result: unknown): string {
  try {
    return `Result:\n${JSON.stringify(result, null, 2) ?? "undefined"}`;
  } catch {
    // Cyclic or BigInt values: the code did run, only JSON cannot represent its result
    return `Result (not representable as JSON):\n${inspectSafely(result)}`;
  }
}

function describeFailure(error: unknown, signal: AbortSignal, timeoutMs: number): string {
  if (signal.aborted) {
    const isTimeout = signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
    return `Error: the execution ${isTimeout ? `timed out after ${timeoutMs} ms` : "was cancelled"}. Its client requests were asked to stop, but some operations may already have taken effect: check the current state before retrying.`;
  }
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return `Error: ${String(error)}`;
}
