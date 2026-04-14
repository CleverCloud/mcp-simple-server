# ADR-001: Code Mode Pattern for Clever Cloud MCP Server

## Status

Accepted

## Context

We need an MCP server that gives LLM agents access to the full Clever Cloud API (~177 commands across 43 categories). The traditional approach of exposing one MCP tool per API endpoint would create 177+ tool definitions, consuming tens of thousands of tokens in every LLM context window just for tool descriptions.

We made previous tests of very simple MCP servers relying on generic tools. Cloudflare explored a comparable approach they named "Code Mode" for their MCP server: instead of many tools, expose just two (`search` + `execute`) that let the LLM discover API endpoints and compose calls by writing code. They reported reducing their context usage by 99.9%.

However, Cloudflare's implementation relies on processing a raw OpenAPI specification and running code in sandboxed Cloudflare Workers. Our situation differs: we have `@clevercloud/client`, a strongly-typed TypeScript client with a command pattern, LLM-ready documentation, and we can run locally on the user's machine as we do with Clever Tools.

## Decisions

### 1. Three-tool Code Mode architecture

**Decision**: Expose exactly three MCP tools — `search`, `execute`, and `doc`.

- `search`: text-based filtering over a static command catalog
- `execute`: runs JavaScript code with a pre-authenticated `CcApiClient` and all command classes in scope
- `doc`: searches the Clever Cloud documentation index (parsed from the site's `llms.txt`) or fetches a page as markdown via content negotiation (`Accept: text/markdown`)

**Rationale**: ~177 commands at ~100 tokens each = ~17,000 tokens per context. Three tools with concise descriptions use ~700 tokens total. The LLM discovers what it needs on demand via `search` (for API commands) or `doc` (for conceptual guidance — runtimes, add-ons, environment variables, deployment model, etc.) that the API catalog alone doesn't expose.

### 2. Use `@clevercloud/client` commands directly (no OpenAPI spec processing)

**Decision**: The execute tool exposes the client's command classes (`ListApplicationCommand`, `CreateDomainCommand`, etc.) rather than raw REST calls.

**Rationale**: The command classes provide:
- Automatic `ownerId` resolution from `applicationId`/`addonId`
- Response transformation and error mapping
- Typed parameters (surfaced in the catalog for the LLM)
- No need to download, parse, resolve `$ref`s, and pre-process an OpenAPI spec

This is simpler than the OpenAPI-spec-based variant, which requires a spec processor and a cron job to stay in sync.

### 3. No sandbox / no Worker isolation

**Decision**: Execute user-provided code via `new Function(...)` wrapped in an async IIFE, directly in the Node.js process.

**Rationale**: The MCP server runs locally on the user's machine as a stdio process. The user (or their LLM agent) already has full system access — they can run shell commands, edit files, etc. Sandboxing the API calls adds complexity without meaningful security benefit. The threat model is identical to any other MCP tool.

A configurable timeout via `AbortSignal.timeout()` (`CC_MCP_TIMEOUT_MS`, default 30s) protects against runaway execution and cancels in-flight network requests.

### 4. API Token authentication only

**Decision**: Support only `api-token` authentication, not OAuth v1.

**Rationale**: OAuth v1 PLAINTEXT requires a multi-step browser flow with consumer key/secret exchange. This is incompatible with a headless MCP server invoked by a CLI tool. API tokens are:
- Simple to create (one step in the Clever Cloud console)
- Long-lived and scopable
- Passed via a single environment variable

### 5. Static command catalog generated at build time

**Decision**: A build script introspects `@clevercloud/client` to generate a JSON catalog and a TypeScript command registry. Both are committed to git.

**Rationale**:
- No runtime introspection or dynamic import overhead
- The catalog format is optimized for the `search` tool (class name, category, params, description)
- Regenerated only when upgrading `@clevercloud/client`
- The command registry uses static imports for fast startup and TypeScript verification

### 6. Eager command class loading

**Decision**: All ~177 command classes are statically imported at startup into a flat `Record<string, CommandClass>`.

**Rationale**: The MCP server is a long-running process. Loading all commands at startup (< 50ms) avoids per-call dynamic import latency. The LLM accesses commands as `commands.ListApplicationCommand` — a direct, unambiguous mapping from search results to executable code.

## Consequences

- LLM agents can access the full Clever Cloud API surface with minimal token overhead
- Adding new commands requires regenerating the catalog (`npm run generate-catalog`)
- No type safety on LLM-generated code (errors are caught at runtime and returned to the LLM)
- The `AbortSignal` timeout cancels in-flight requests, but CPU-bound infinite loops are not interruptible in a single-threaded Node.js process
- No multi-tenant safety — this is a single-user, local-execution tool by design
