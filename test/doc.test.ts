import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerDocTool } from "../src/tools/doc.ts";
import { createTextResult } from "../src/tools/result.ts";

const INDEX = `# Clever Cloud documentation

## Runtimes
- [Node.js](https://www.clever.cloud/developers/doc/applications/nodejs/): Deploy Node.js applications

## Add-ons
- [PostgreSQL](https://www.clever.cloud/developers/doc/addons/postgresql/): Managed PostgreSQL databases
`;

/** Replaces fetch: the index URL answers with the given responses in turn, pages with their URL */
function mockFetch(...indexResponses: (() => Response | Promise<Response>)[]) {
  return mock.method(globalThis, "fetch", async (input: URL | string) => {
    const url = String(input);
    if (url.endsWith("/llms.txt")) return indexResponses.shift()?.() ?? new Response(INDEX);
    if (url.endsWith("/moved")) return new Response(null, { status: 301, headers: { Location: "https://example.com" } });
    if (url.endsWith("/huge")) return new Response("x".repeat(1_000_000));
    if (url.endsWith("/accents")) {
      // "é" is two bytes in UTF-8, split here across two chunks
      const [first, second] = [new Uint8Array([0x63, 0x61, 0x66, 0xc3]), new Uint8Array([0xa9])];
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(first);
            controller.enqueue(second);
            controller.close();
          },
        }),
      );
    }
    return new Response(`# Page at ${url}`);
  });
}

const clients: Client[] = [];

async function connect() {
  const config = { apiToken: "secret-token", maxOutputLength: 1_000 };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerDocTool(server, createTextResult(config), config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return async (args: { query?: string; url?: string }, options?: { signal?: AbortSignal }) => {
    const result = await client.callTool({ name: "doc", arguments: args }, undefined, options);
    const [content] = result.content as { text: string }[];
    return { text: content?.text ?? "", isError: result.isError === true };
  };
}

describe("doc", () => {
  afterEach(async () => {
    mock.restoreAll();
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  test("loads the index on the first query only", async () => {
    const fetch = mockFetch();
    const doc = await connect();
    assert.equal(fetch.mock.callCount(), 0);

    const { text } = await doc({ query: "nodejs" });
    assert.match(text, /^Found 1 page\(s\)\. .*\n\n- \[Runtimes\] Node\.js\n {2}https:\/\/www\.clever\.cloud\/developers\/doc\/applications\/nodejs\//);
    await doc({ query: "postgresql" });
    assert.equal(fetch.mock.callCount(), 1);
  });

  test("shares the index load between concurrent queries, even when one is cancelled", async () => {
    const index = Promise.withResolvers<Response>();
    const fetch = mockFetch(() => index.promise);
    const doc = await connect();

    const cancellation = new AbortController();
    const cancelled = doc({ query: "nodejs" }, { signal: cancellation.signal });
    const completed = doc({ query: "postgresql" });
    while (fetch.mock.callCount() === 0) await new Promise((resolve) => setImmediate(resolve));
    cancellation.abort();
    await assert.rejects(cancelled);
    index.resolve(new Response(INDEX));

    assert.match((await completed).text, /^Found 1 page\(s\)\..*\n\n- \[Add-ons\] PostgreSQL/s);
    assert.equal(fetch.mock.callCount(), 1);
  });

  test("refuses an index larger than expected", async () => {
    mockFetch(() => new Response("x".repeat(1_000_001)));
    const doc = await connect();
    assert.match((await doc({ query: "nodejs" })).text, /llms\.txt is larger than 1000000 characters/);
  });

  test("retries loading the index after a failure", async () => {
    mockFetch(() => new Response("unavailable", { status: 503 }));
    const doc = await connect();

    const failed = await doc({ query: "nodejs" });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /the documentation index cannot be loaded \(HTTP 503/);
    assert.equal((await doc({ query: "nodejs" })).isError, false);
  });

  test("lists the categories when no page matches", async () => {
    mockFetch();
    const doc = await connect();
    const { text } = await doc({ query: "kubernetes" });
    assert.equal(text, 'No documentation pages found for "kubernetes". Available categories: Runtimes, Add-ons');
  });

  test("rejects queries without letters or digits, and calls with both or no params", async () => {
    mockFetch();
    const doc = await connect();
    assert.deepEqual(await doc({ query: "!!!" }), {
      text: "The query needs at least one letter or digit.",
      isError: true,
    });
    assert.equal((await doc({})).isError, true);
    assert.equal((await doc({ query: "nodejs", url: "https://www.clever.cloud/" })).isError, true);
  });

  test("fetches pages from the documentation host only, over https", async () => {
    const fetch = mockFetch();
    const doc = await connect();

    assert.deepEqual(await doc({ url: "https://www.clever.cloud/developers/doc/" }), {
      text: "# Page at https://www.clever.cloud/developers/doc/",
      isError: false,
    });
    assert.match((await doc({ url: "http://www.clever.cloud/developers/doc/" })).text, /^Only https:\/\//);
    assert.match((await doc({ url: "https://example.com/" })).text, /^Only www\.clever\.cloud URLs/);
    assert.equal(fetch.mock.callCount(), 1);
  });

  test("does not follow redirects", async () => {
    mockFetch();
    const doc = await connect();
    const { text, isError } = await doc({ url: "https://www.clever.cloud/moved" });
    assert.equal(isError, true);
    assert.equal(text, "Unexpected redirect (HTTP 301) fetching https://www.clever.cloud/moved");
  });

  test("decodes characters split across chunks", async () => {
    mockFetch();
    const doc = await connect();
    assert.equal((await doc({ url: "https://www.clever.cloud/accents" })).text, "café");
  });

  test("cuts pages to the output budget", async () => {
    mockFetch();
    const doc = await connect();
    const { text } = await doc({ url: "https://www.clever.cloud/huge" });
    assert.equal(text.length, 1_000);
    assert.match(text, /\(truncated to the 1000 characters output budget\)$/);
  });
});
