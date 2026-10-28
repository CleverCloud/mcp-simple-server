import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Config } from "../config.ts";

/** Builds a tool response holding a single text block */
export type TextResult = (text: string, isError?: boolean) => CallToolResult;

/**
 * Every tool response goes through the returned function: it masks the API
 * token, should some output echo it, then cuts the text to the output budget.
 */
export function createTextResult({
  apiToken,
  maxOutputLength,
}: Pick<Config, "apiToken" | "maxOutputLength">): TextResult {
  return (text, isError = false) => ({
    content: [{ type: "text", text: truncate(maskToken(text, apiToken), maxOutputLength) }],
    ...(isError && { isError: true }),
  });
}

/** Masks the API token; to apply before any cut, which could leave part of it */
export function maskToken(text: string, apiToken: string): string {
  return text.replaceAll(apiToken, "[REDACTED]");
}

/** Cuts `text` to at most `maxLength` characters, the truncation notice included */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const notice = `\n\n... (truncated to the ${maxLength} characters output budget)`;
  return `${text.slice(0, Math.max(0, maxLength - notice.length))}${notice}`.slice(0, maxLength);
}
