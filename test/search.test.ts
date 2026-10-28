import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createTextResult } from "../src/tools/result.ts";
import { registerSearchTool } from "../src/tools/search.ts";

describe("search", () => {
  const client = new Client({ name: "test", version: "0.0.0" });
  before(async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerSearchTool(server, createTextResult({ apiToken: "secret-token", maxOutputLength: 100_000 }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  after(() => client.close());

  const search = async (query: string) => {
    const result = await client.callTool({ name: "search", arguments: { query } });
    const [content] = result.content as { text: string }[];
    return { text: content?.text ?? "", isError: result.isError === true };
  };

  test("rejects a blank query", async () => {
    const { isError } = await search("   ");
    assert.equal(isError, true);
  });

  test("renders a command with its params, alternatives and types", async () => {
    const { text } = await search("CreateOrganisationCommand");
    assert.match(text, /^Found 1 command\(s\):\n\n## CreateOrganisationCommand\nCreates an organisation/);
    assert.match(text, /\n {2}name: string — /);
    assert.match(text, /\n {2}country\?: string — /);
    assert.match(text, /\nAlso required, at least one of: \(country\) \| \(company, vat\)\n/);
    assert.match(text, /\nUsage: await client\.send\(new commands\.CreateOrganisationCommand\(\{ \.\.\. \}\)\)$/);
  });

  test("defines the named types a command uses", async () => {
    const { text } = await search("CreateApplicationCommand");
    assert.match(text, /\nTypes:\n(?: {2}.+\n)* {2}EnvironmentVariable = \{ name: string; value: string; \}\n/);
  });

  test("details at most 10 commands, those named after the query first", async () => {
    const { text } = await search("application");
    assert.match(text, /^Found \d+ commands, showing 10\. The \d+ others are in these categories: .+\. Refine the query/);
    assert.equal(text.match(/^## /gm)?.length, 10);
    assert.match(text.split("## ")[1] ?? "", /^\w*Application\w*Command\n/);
  });

  test("suggests the categories when nothing matches", async () => {
    const { text, isError } = await search("no-such-thing");
    assert.equal(isError, false);
    assert.match(text, /^No commands found for query "no-such-thing"\. Try broader terms like a category name: addon, /);
  });
});
