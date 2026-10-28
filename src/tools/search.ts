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

// Keeps the response short enough to stay readable, and within the output budget
const MAX_RESULTS = 10;

export function registerSearchTool(server: McpServer, textResult: TextResult): void {
  server.registerTool(
    "search",
    {
      title: "Search Clever Cloud API commands",
      description: `Search available Clever Cloud API commands. Returns matching commands with their class name, description, parameters, the types they use, and usage. Use this to discover which commands exist before writing code for the execute tool. At most ${MAX_RESULTS} commands are detailed, those whose name matches first: refine the query to reach the others.`,
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Search query: matches against command name, category, description, endpoint paths, and parameter names. Examples: "application", "create addon", "deploy", "environment variable", "network-group", "domain"',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const terms = query.toLowerCase().split(/\s+/);
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

      // Commands named after the query are the most likely to be wanted
      const nameMatches = (entry: CatalogEntry) =>
        terms.every((term) => entry.className.toLowerCase().includes(term));
      const ranked = matches.toSorted((a, b) => Number(nameMatches(b)) - Number(nameMatches(a)));
      const shown = ranked.slice(0, MAX_RESULTS);
      const omitted = ranked.slice(MAX_RESULTS);

      const header =
        omitted.length > 0
          ? `Found ${matches.length} commands, showing ${shown.length}. The ${omitted.length} others are in these categories: ${[...new Set(omitted.map((entry) => entry.category))].join(", ")}. Refine the query to see them, e.g. with a category or a verb like "list", "create".`
          : `Found ${matches.length} command(s):`;
      return textResult(`${header}\n\n${shown.map(formatCommand).join("\n\n---\n\n")}`);
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
