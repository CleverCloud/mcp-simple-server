import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.ts";
import type { TextResult } from "./result.ts";

const LLMS_TXT_URL = "https://www.clever.cloud/developers/llms.txt";
const ALLOWED_HOST = "www.clever.cloud";
const FETCH_TIMEOUT_MS = 10_000;
// The index is a few dozen KB: anything far bigger is not what we expect
const MAX_INDEX_LENGTH = 1_000_000;
// The redirect of a page that moved comes in the first few hundred characters
const MAX_HTML_LENGTH = 10_000;

interface DocEntry {
  category: string;
  title: string;
  url: string;
  description: string;
}

export function registerDocTool(
  server: McpServer,
  textResult: TextResult,
  { maxOutputLength }: Pick<Config, "maxOutputLength">,
): void {
  const loadIndex = createIndexLoader();

  server.registerTool(
    "doc",
    {
      title: "Search and read the Clever Cloud documentation",
      description: `Search or fetch Clever Cloud documentation pages.

Two modes (provide exactly one):
- query: search the documentation index (titles, categories, URLs) and return matching pages
- url: fetch a documentation page and return its markdown content

Use 'query' first to discover pages, then 'url' to read one in full. URLs must point to ${ALLOWED_HOST}.
The documentation covers concepts, runtimes, add-ons, CLI, deployment, and reference material that the command catalog doesn't expose.`,
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            'Keywords to search in page titles, descriptions, and categories. Examples: "environment variables", "postgresql", "deploy nodejs"',
          ),
        url: z
          .url()
          .optional()
          .describe(
            `Full URL of a Clever Cloud documentation page (must be on ${ALLOWED_HOST}). Returns the page's markdown content.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, url }, { signal }) => {
      if ((query === undefined) === (url === undefined)) {
        return textResult("Provide exactly one of `query` or `url`.", true);
      }
      try {
        if (query !== undefined) {
          const terms = toSearchTerms(query);
          if (terms.length === 0) return textResult("The query needs at least one letter or digit.", true);
          return textResult(searchIndex(await loadIndex(signal), query, terms));
        }
        const page = await fetchPage(url!, signal, maxOutputLength);
        return textResult(page.text, page.isError);
      } catch (error) {
        return textResult(`Fetch failed: ${(error as Error).message}`, true);
      }
    },
  );
}

// Both the query and the index are stripped of punctuation so that "nodejs"
// matches "Node.js", "github" matches "GitHub" and "12factor" matches "12-factor"
function toSearchTerms(query: string): string[] {
  return query.split(/\s+/).map(collapse).filter(Boolean);
}

function collapse(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function searchIndex(index: DocEntry[], query: string, terms: string[]): string {
  const matches = index.filter((entry) => {
    const haystack = collapse(`${entry.category} ${entry.title} ${entry.description} ${entry.url}`);
    return terms.every((term) => haystack.includes(term));
  });
  if (matches.length === 0) {
    const categories = [...new Set(index.map((entry) => entry.category))];
    return `No documentation pages found for "${query}". Available categories: ${categories.join(", ")}`;
  }
  const formatted = matches.map((entry) => {
    const description = entry.description ? `\n  ${entry.description}` : "";
    return `- [${entry.category}] ${entry.title}\n  ${entry.url}${description}`;
  });
  return `Found ${matches.length} page(s). Use the \`url\` parameter to read one in full.\n\n${formatted.join("\n\n")}`;
}

async function fetchPage(
  url: string,
  signal: AbortSignal,
  maxLength: number,
): Promise<{ text: string; isError: boolean }> {
  const parsed = new URL(url);
  const refusal = checkPageUrl(parsed);
  if (refusal) return { text: refusal, isError: true };

  // `redirect: "manual"` prevents a page from bouncing the client to an
  // off-allowlist host after the host check passed
  const response = await fetch(parsed, {
    headers: { Accept: "text/markdown" },
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { text: movedTo(response.headers.get("location"), parsed), isError: true };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { text: `HTTP ${response.status} fetching ${url}`, isError: true };
  }
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type === "text/html") return { text: await describeHtmlPage(response, parsed), isError: true };
  if (type !== "text/markdown" && type !== "text/plain") {
    await response.body?.cancel();
    return { text: `${url} is not a markdown page (got: ${type ?? "no content type"})`, isError: true };
  }
  const { text, truncated } = await readText(response, maxLength);
  return { text: truncated ? `${text}\n\n... (page cut to the output budget)` : text, isError: false };
}

/**
 * A page that moved is left at its old address as an HTML page redirecting to
 * the new one, whatever the Accept header: such a page is pointed to its new
 * address, any other has no markdown version.
 */
async function describeHtmlPage(response: Response, url: URL): Promise<string> {
  const { text } = await readText(response, MAX_HTML_LENGTH);
  const refresh = /<meta\s[^>]*http-equiv=["']?refresh\b[^>]*>/i.exec(text)?.[0];
  const location = refresh && /\bcontent=["']?\d*\s*;\s*url=([^"'\s>]+)/i.exec(refresh)?.[1];
  return location ? movedTo(location, url) : `${url.href} has no markdown version`;
}

/** Why the page at `url` must not be fetched, if it must not */
function checkPageUrl(url: URL): string | undefined {
  if (url.protocol !== "https:") return `Only https:// URLs are allowed (got: ${url.protocol})`;
  if (url.hostname !== ALLOWED_HOST) return `Only ${ALLOWED_HOST} URLs are allowed (got: ${url.hostname})`;
  return undefined;
}

/** Points to the new address of a page, once checked, rather than following it */
function movedTo(location: string | null, from: URL): string {
  const target = location === null ? null : URL.parse(location, from);
  if (!target) return `${from.href} redirects to an invalid address`;
  const refusal = checkPageUrl(target);
  return refusal
    ? `${from.href} redirects to ${target.href}, which cannot be fetched: ${refusal}`
    : `This page moved to ${target.href}: fetch that URL instead.`;
}

/**
 * The index is loaded on first use rather than at startup, which then needs no
 * network. A failed load is retried on the next call.
 */
function createIndexLoader() {
  let loading: Promise<DocEntry[]> | undefined;
  return (signal: AbortSignal): Promise<DocEntry[]> => {
    signal.throwIfAborted();
    if (!loading) {
      loading = fetchIndex().catch((error: unknown) => {
        loading = undefined;
        throw new Error(`the documentation index cannot be loaded (${(error as Error).message})`, {
          cause: error,
        });
      });
      // Every caller may have been cancelled by the time it fails: that must not be an unhandled rejection
      loading.catch(() => {});
    }
    // A cancelled call stops waiting, but leaves the shared load running for the others
    return untilAborted(loading, signal);
  };
}

async function fetchIndex(): Promise<DocEntry[]> {
  const response = await fetch(LLMS_TXT_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} fetching ${LLMS_TXT_URL}`);
  }
  const { text, truncated } = await readText(response, MAX_INDEX_LENGTH);
  if (truncated) throw new Error(`${LLMS_TXT_URL} is larger than ${MAX_INDEX_LENGTH} characters`);
  return parseIndex(text);
}

// Parses the llms.txt format: `## Category` headings followed by
// `- [Title](URL): Description` bullet entries.
function parseIndex(content: string): DocEntry[] {
  const entries: DocEntry[] = [];
  let currentCategory = "";

  for (const line of content.split("\n")) {
    const categoryMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (categoryMatch) {
      currentCategory = categoryMatch[1]!;
      continue;
    }
    const linkMatch = /^-\s+\[([^\]]+)\]\((https?:\/\/[^)]+)\)(?::\s*(.*))?$/.exec(line);
    if (linkMatch) {
      entries.push({
        category: currentCategory,
        title: linkMatch[1]!,
        url: linkMatch[2]!,
        description: linkMatch[3]?.trim() ?? "",
      });
    }
  }

  return entries;
}

/** Reads a response body as text, up to `maxLength` characters, then releases it */
async function readText(response: Response, maxLength: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { text, truncated: false };
      // One character past the limit tells that there is more
      text += value.slice(0, maxLength + 1 - text.length);
      if (text.length > maxLength) return { text: text.slice(0, maxLength), truncated: true };
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Waits for `promise`, unless `signal` aborts first */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, aborted.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}
