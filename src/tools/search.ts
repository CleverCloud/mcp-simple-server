import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CatalogEntry } from "../catalog/catalog.js";
// A static import makes tsc emit the JSON into dist/, unlike a runtime readFileSync
import catalogJson from "../catalog/command-catalog.json" with { type: "json" };
import { textResult } from "./result.js";

// The inferred literal union (sparse `params` keys widened to `?: undefined`) isn't
// comparable to CatalogEntry; the generator guarantees the shape
const catalog = catalogJson as unknown as CatalogEntry[];
const categories = [...new Set(catalog.map((e) => e.category))];

export function registerSearchTool(server: McpServer): void {
  server.tool(
    "search",
    "Search available Clever Cloud API commands. Returns matching commands with their class name, category, parameters, and usage. Use this to discover which commands exist before writing code for the execute tool.",
    {
      query: z
        .string()
        .describe(
          'Search query: matches against command name, category, description, endpoint paths, and parameter names. Examples: "application", "create addon", "deploy", "environment variable", "network-group", "domain"',
        ),
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

      const formatted = matches.map((entry) => {
        const paramLines = Object.entries(entry.params).map(
          ([name, type]) => {
            const required = entry.requiredParams.includes(name);
            return `    ${name}${required ? "" : "?"}: ${type}`;
          },
        );

        const lines = [
          `## ${entry.className}`,
          `Category: ${entry.category} | ${entry.description}`,
          entry.endpoints.length > 0
            ? `Endpoints: ${entry.endpoints.join(", ")}`
            : null,
          entry.isStream ? `**Stream command** — use client.stream() instead of client.send()` : null,
          paramLines.length > 0
            ? `Parameters:\n${paramLines.join("\n")}`
            : `Parameters: none`,
          `Usage: ${entry.isStream ? "client.stream" : "await client.send"}(new commands.${entry.className}(${paramLines.length > 0 ? "{ ... }" : ""}))`,
        ];

        return lines.filter(Boolean).join("\n");
      });

      return textResult(
        `Found ${matches.length} command(s):\n\n${formatted.join("\n\n---\n\n")}`,
      );
    },
  );
}
