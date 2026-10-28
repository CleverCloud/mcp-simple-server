import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// These tests run against dist/, built by `pretest`: what users actually install

test("the package ships the built server with its catalog", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf-8",
  });
  // npm < 12 reports an array of packages, npm 12 an object keyed by package name
  const [report] = Object.values(JSON.parse(output)) as { files: { path: string }[] }[];
  const paths = report!.files.map((file) => file.path);

  for (const expected of ["dist/index.js", "dist/catalog/command-catalog.json"]) {
    assert.ok(paths.includes(expected), `${expected} is missing from the package`);
  }
});

test("the built server starts and serves its tools over stdio", { timeout: 30_000 }, async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "mcp-simple-server-"));
  const client = new Client({ name: "test", version: "0.0.0" });
  t.after(async () => {
    await client.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { CLEVER_CLOUD_API_TOKEN: "test-token", XDG_CACHE_HOME: cacheDir },
    }),
  );

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["doc", "execute", "search"]);

  const result = await client.callTool({ name: "search", arguments: { query: "list application" } });
  assert.match(JSON.stringify(result.content), /ListApplicationCommand/);
});
