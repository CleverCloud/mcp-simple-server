# CLAUDE.md

## Project

Code Mode MCP server for Clever Cloud. Exposes the full Clever Cloud API (~177 commands) through three MCP tools (`search`, `execute`, `doc`) instead of one tool per endpoint. The agent writes JavaScript code that runs against a pre-authenticated `@clevercloud/client` instance, and can fetch Clever Cloud documentation on demand.

## Architecture

- `src/index.ts` — Entry point, wires McpServer with stdio transport
- `src/config.ts` — Reads `CLEVER_CLOUD_API_TOKEN` env var (required) and optional `CC_MCP_TIMEOUT_MS`, `CC_MCP_MAX_OUTPUT`
- `src/client/create-client.ts` — Creates `CcApiClient` with API token auth and FileStore cache (XDG-compliant)
- `src/tools/search.ts` — MCP tool: text search over the command catalog (AND matching on terms)
- `src/tools/execute.ts` — MCP tool: runs JS code via `new Function()` with `client`, `commands`, `console`, and `signal` (AbortSignal) in scope
- `src/tools/doc.ts` — MCP tool: searches the Clever Cloud docs index (llms.txt loaded at startup) or fetches a page as markdown via `Accept: text/markdown`
- `src/catalog/command-catalog.json` — **Generated file**: 177 command entries with class name, category, params, endpoints
- `src/commands/command-registry.ts` — **Generated file**: static imports of all command classes into a flat record
- `scripts/generate-catalog.ts` — Generates both files above by introspecting `@clevercloud/client`
- `docs/adr-001-code-mode-pattern.md` — Architecture Decision Record explaining key design choices

## Key decisions

- No sandbox: runs locally, same trust model as any MCP tool
- API token auth only (no OAuth v1)
- `new Function(...)` executor wrapped in an async IIFE, with `AbortSignal.timeout()` for cancellable requests
- Command catalog generated at build time, committed to git
- All command classes eagerly loaded at startup

## Commands

```bash
npm run generate-catalog  # Regenerate catalog + registry from @clevercloud/client
npm run build             # TypeScript compilation
npm start                 # Run the MCP server (needs CLEVER_CLOUD_API_TOKEN)
```

## Conventions

- TypeScript strict mode, ESM (`"type": "module"`, `"module": "NodeNext"`)
- Generated files (`command-catalog.json`, `command-registry.ts`) must not be edited manually — run `npm run generate-catalog` after upgrading `@clevercloud/client`
- Keep tool descriptions concise: they're injected into LLM context on every call
