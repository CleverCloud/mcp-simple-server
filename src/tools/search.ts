import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CatalogEntry } from "../catalog/catalog.ts";
// A static import makes tsc emit the JSON into dist/, unlike a runtime readFileSync
import catalogJson from "../catalog/command-catalog.json" with { type: "json" };
import type { TextResult } from "./result.ts";

// The inferred literal union (sparse `params` keys widened to `?: undefined`) isn't
// comparable to CatalogEntry; the generator guarantees the shape
const catalog = catalogJson as unknown as CatalogEntry[];
const categories = [...new Set(catalog.map((e) => e.category))];

export function registerSearchTool(server: McpServer, textResult: TextResult): void {
  server.registerTool(
    "search",
    {
      title: "Search Clever Cloud API commands",
      description:
        "Search available Clever Cloud API commands. Returns matching commands with their class name, category, parameters, and usage. Use this to discover which commands exist before writing code for the execute tool.",
      inputSchema: {
        query: z
          .string()
          .describe(
            'Search query: matches against command name, category, description, endpoint paths, and parameter names. Examples: "application", "create addon", "deploy", "environment variable", "network-group", "domain"',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

      const matches = catalog.filter((entry) => {
        const searchable = [
          entry.className,
          entry.category,
          entry.description,
          ...entry.endpoints,
          ...Object.keys(entry.params),
        ]
          .join(" ")
          .toLowerCase();

        return terms.every((term) => searchable.includes(term));
      });

      if (matches.length === 0) {
        return textResult(
          `No commands found for query "${query}". Try broader terms like a category name: ${categories.join(", ")}`,
        );
      }

      return textResult(
        `Found ${matches.length} command(s):\n\n${matches.map(formatCommand).join("\n\n---\n\n")}`,
      );
    },
  );
}

function formatCommand(entry: CatalogEntry): string {
  const params = Object.entries(entry.params).map(([name, { type, required, description }]) => {
    const summary = description ? ` — ${description}` : "";
    return `  ${name}${required ? "" : "?"}: ${type}${summary}`;
  });
  const types = Object.entries(entry.types ?? {}).map(([name, definition]) => `  ${name} = ${definition}`);
  const args = params.length > 0 ? "{ ... }" : "";

  return [
    `## ${entry.className}`,
    entry.description,
    `Category: ${entry.category} | Endpoints: ${entry.endpoints.join(", ")}`,
    params.length > 0 ? `Parameters:\n${params.join("\n")}` : "Parameters: none",
    entry.requiredAnyOf &&
      `Also required, at least one of: ${entry.requiredAnyOf.map((set) => `(${set.join(", ")})`).join(" | ")}`,
    types.length > 0 && `Types:\n${types.join("\n")}`,
    entry.isStream
      ? `Usage: const stream = await client.stream(new commands.${entry.className}(${args})) — see the execute tool for how to consume a stream`
      : `Usage: await client.send(new commands.${entry.className}(${args}))`,
  ]
    .filter(Boolean)
    .join("\n");
}
