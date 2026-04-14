import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { textResult } from "./result.js";

const LLMS_TXT_URL = "https://www.clever.cloud/developers/llms.txt";
const ALLOWED_HOST = "www.clever.cloud";
const FETCH_TIMEOUT_MS = 10_000;

interface DocEntry {
  category: string;
  title: string;
  url: string;
  description: string;
}

// Parses the llms.txt format: `## Category` headings followed by
// `- [Title](URL): Description` bullet entries.
function parseIndex(content: string): DocEntry[] {
  const entries: DocEntry[] = [];
  let currentCategory = "";

  for (const line of content.split("\n")) {
    const categoryMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (categoryMatch) {
      currentCategory = categoryMatch[1];
      continue;
    }
    const linkMatch = /^-\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)(?::\s*(.*))?$/.exec(
      line,
    );
    if (linkMatch) {
      entries.push({
        category: currentCategory,
        title: linkMatch[1],
        url: linkMatch[2],
        description: linkMatch[3]?.trim() ?? "",
      });
    }
  }

  return entries;
}

function formatEntry(entry: DocEntry): string {
  const desc = entry.description ? `\n  ${entry.description}` : "";
  return `- [${entry.category}] ${entry.title}\n  ${entry.url}${desc}`;
}

async function fetchIndex(): Promise<DocEntry[]> {
  const response = await fetch(LLMS_TXT_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${LLMS_TXT_URL}`);
  }
  return parseIndex(await response.text());
}

export async function registerDocTool(server: McpServer): Promise<void> {
  let index: DocEntry[] = [];
  try {
    index = await fetchIndex();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Warning: could not load Clever Cloud doc index (${message}). The doc tool will still work for direct URL fetches.`);
  }
  const categories = [...new Set(index.map((e) => e.category))];

  server.tool(
    "doc",
    `Search or fetch Clever Cloud documentation pages.

Two modes (provide exactly one):
- query: search the documentation index (titles, categories, URLs) and return matching pages
- url: fetch a documentation page and return its markdown content

Use 'query' first to discover pages, then 'url' to read one in full. URLs must point to ${ALLOWED_HOST}.
The documentation covers concepts, runtimes, add-ons, CLI, deployment, and reference material that the command catalog doesn't expose.`,
    {
      query: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Keywords to search in page titles, descriptions, and categories. Examples: "environment variables", "postgresql", "deploy nodejs"',
        ),
      url: z
        .string()
        .url()
        .optional()
        .describe(
          `Full URL of a Clever Cloud documentation page (must be on ${ALLOWED_HOST}). Returns the page's markdown content.`,
        ),
    },
    async ({ query, url }) => {
      if ((query == null) === (url == null)) {
        return textResult(
          "Provide exactly one of `query` or `url`.",
          true,
        );
      }

      if (query != null) {
        if (index.length === 0) {
          return textResult(
            "Documentation index is unavailable (failed to load at startup). Use the `url` parameter to fetch a known page directly.",
            true,
          );
        }

        // Normalize tokens by stripping punctuation so "nodejs" matches
        // "Node.js", "github" matches "GitHub", "12factor" matches "12-factor".
        // The haystack has ALL non-alphanumerics stripped (including spaces)
        // so a query token like "nodejs" matches "node.js" after both sides
        // collapse to "nodejs". Query is kept space-tokenized for multi-term AND.
        const collapse = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
        const terms = query
          .toLowerCase()
          .split(/\s+/)
          .map(collapse)
          .filter(Boolean);
        const matches = index.filter((entry) => {
          const haystack = collapse(
            `${entry.category} ${entry.title} ${entry.description} ${entry.url}`,
          );
          return terms.every((term) => haystack.includes(term));
        });

        if (matches.length === 0) {
          return textResult(
            `No documentation pages found for "${query}". Available categories: ${categories.join(", ")}`,
          );
        }

        const formatted = matches.map(formatEntry).join("\n\n");
        return textResult(
          `Found ${matches.length} page(s). Use the \`url\` parameter to read one in full.\n\n${formatted}`,
        );
      }

      // url mode — validate protocol and host before fetching to prevent SSRF
      const parsed = new URL(url!);
      if (parsed.protocol !== "https:") {
        return textResult(
          `Only https:// URLs are allowed (got: ${parsed.protocol})`,
          true,
        );
      }
      if (parsed.hostname !== ALLOWED_HOST) {
        return textResult(
          `Only ${ALLOWED_HOST} URLs are allowed (got: ${parsed.hostname})`,
          true,
        );
      }

      try {
        // `redirect: "manual"` prevents a page from bouncing the client to
        // an off-allowlist host after the initial host check passed.
        const response = await fetch(parsed.toString(), {
          headers: { Accept: "text/markdown" },
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.status >= 300 && response.status < 400) {
          return textResult(
            `Unexpected redirect (HTTP ${response.status}) fetching ${url}`,
            true,
          );
        }
        if (!response.ok) {
          return textResult(
            `HTTP ${response.status} fetching ${url}`,
            true,
          );
        }
        return textResult(await response.text());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Fetch failed: ${message}`, true);
      }
    },
  );
}
