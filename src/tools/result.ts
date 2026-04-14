// Shared helper for MCP tool responses. All tools return `{ content: [...] }`
// with a single text block, optionally flagged as an error.
export function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError && { isError: true }),
  };
}
