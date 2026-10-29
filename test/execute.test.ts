import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import type { CcApiClient } from "@clevercloud/client/cc-api-client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerExecuteTool } from "../src/tools/execute.ts";
import { createTextResult } from "../src/tools/result.ts";

/** A client whose requests never settle, recording the signal each one got */
function createPendingClient() {
  const signals: AbortSignal[] = [];
  const closedStreams: string[] = [];
  const client = {
    send: (_command: unknown, config?: { signal?: AbortSignal }) => {
      signals.push(config?.signal as AbortSignal);
      return new Promise(() => {});
    },
    stream: async (command: { name: string }) => ({
      close: () => {
        closedStreams.push(command.name);
        if (command.name === "failing") throw new Error("cannot close");
      },
    }),
  };
  return { client: client as unknown as CcApiClient, signals, closedStreams };
}

const clients: Client[] = [];

async function connect(apiClient: CcApiClient, executionTimeoutMs = 5_000) {
  const config = { apiToken: "secret-token", executionTimeoutMs, maxOutputLength: 10_000 };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerExecuteTool(server, createTextResult(config), apiClient, config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function execute(client: Client, code: string, options?: { signal?: AbortSignal }) {
  const result = await client.callTool({ name: "execute", arguments: { code } }, undefined, options);
  const [content] = result.content as { type: string; text: string }[];
  return { text: content?.text ?? "", isError: result.isError === true };
}

describe("execute", () => {
  afterEach(() => Promise.all(clients.splice(0).map((client) => client.close())));

  test("returns the result as JSON, followed by the console output", async () => {
    const client = await connect(createPendingClient().client);
    const { text, isError } = await execute(client, 'console.log("found", { id: 1 }); return { ok: true };');
    assert.equal(isError, false);
    assert.equal(text, 'Result:\n{\n  "ok": true\n}\n\nConsole output:\nfound { id: 1 }');
  });

  test("reports a result JSON cannot represent as a success", async () => {
    const client = await connect(createPendingClient().client);
    const { text, isError } = await execute(client, "const a = { n: 1n }; a.self = a; return a;");
    assert.equal(isError, false);
    assert.match(text, /^Result \(not representable as JSON\):\n<ref \*1> \{ n: 1n, self: \[Circular \*1\] \}$/);
  });

  test("reports errors with their position in the code and their causes, without the server's stack", async () => {
    const client = await connect(createPendingClient().client);
    const thrown = await execute(
      client,
      'const check = () => {\n  throw new TypeError("bad input", { cause: new Error("fetch failed", { cause: "ECONNRESET" }) });\n};\ncheck();',
    );
    assert.deepEqual(thrown, {
      text: "TypeError: bad input\n    at line 2, column 9 of the code\nCaused by: Error: fetch failed\nCaused by: 'ECONNRESET'",
      isError: true,
    });
    assert.equal((await execute(client, "return 1 +;")).text, "SyntaxError: Unexpected token ';'");
  });

  test("gives the position in the code only, not in code it evaluates, and survives errors that cannot be read", async () => {
    const client = await connect(createPendingClient().client);
    assert.equal(
      (await execute(client, "await Promise.resolve();\r\neval('\\n\\nnull.bar');")).text,
      "TypeError: Cannot read properties of null (reading 'bar')\n    at line 2, column 1 of the code",
    );
    assert.equal(
      (await execute(client, 'const e = new Error("e"); e.cause = e; throw e;')).text,
      "Error: e\n    at line 1, column 11 of the code",
    );
    assert.equal(
      (await execute(client, 'const e = new Error(); Object.defineProperty(e, "name", { get() { throw 1; } }); throw e;')).text,
      "Error: the code threw a value that cannot be described",
    );
  });

  test("times out, and aborts the requests even when the code doesn't pass the signal", async () => {
    const { client: apiClient, signals } = createPendingClient();
    const client = await connect(apiClient, 100);
    const { text, isError } = await execute(client, "await client.send({});");
    assert.equal(isError, true);
    assert.match(text, /^Error: the execution timed out after 100 ms\. .* check the current state before retrying\.$/);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.aborted, true);
  });

  test("aborts the requests when the MCP client cancels the call", async () => {
    const { client: apiClient, signals } = createPendingClient();
    const client = await connect(apiClient);
    const cancellation = new AbortController();
    const call = execute(client, "await client.send({});", { signal: cancellation.signal });
    while (signals.length === 0) await new Promise((resolve) => setImmediate(resolve));
    cancellation.abort();
    await assert.rejects(call);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signals[0]?.aborted, true);
  });

  test("closes the streams left open, including one still opening when the execution ends", async () => {
    const { client: apiClient, closedStreams } = createPendingClient();
    const client = await connect(apiClient);
    await execute(
      client,
      'await client.stream({ name: "awaited" }); client.stream({ name: "pending" }); return null;',
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closedStreams.sort(), ["awaited", "pending"]);
  });

  test("aborts the requests still running once the execution is over", async () => {
    const { client: apiClient, signals } = createPendingClient();
    const client = await connect(apiClient);
    const { isError } = await execute(client, "client.send({}); return 1;");
    assert.equal(isError, false);
    assert.equal(signals[0]?.aborted, true);
  });

  test("keeps a successful result when closing a stream fails", async () => {
    const { client: apiClient, closedStreams } = createPendingClient();
    const client = await connect(apiClient);
    const { text, isError } = await execute(
      client,
      'await client.stream({ name: "failing" }); await client.stream({ name: "other" }); return 1;',
    );
    assert.deepEqual({ text, isError }, { text: "Result:\n1", isError: false });
    assert.deepEqual(closedStreams.sort(), ["failing", "other"]);
  });

  test("masks the API token in the console output before cutting it", async () => {
    const client = await connect(createPendingClient().client);
    const { text } = await execute(client, 'console.log("x".repeat(9_990) + "secret-token"); return 1;');
    assert.ok(!text.includes("secret"));
    assert.ok(text.length <= 10_000);
  });

  test("keeps the console output within the output budget", async () => {
    const client = await connect(createPendingClient().client);
    const { text } = await execute(client, 'for (let i = 0; i < 10_000; i++) console.log("line", i); return 1;');
    assert.match(text, /^Result:\n1\n\nConsole output:\nline 0\n/);
    assert.ok(text.length <= 10_000);
  });
});
