# mcp-simple-server

An MCP server that gives AI agents full access to the [Clever Cloud](https://clever-cloud.com) API through three tools: `search`, `execute`, and `doc`.

Instead of exposing hundreds of individual tools (one per API endpoint), the agent discovers available commands then writes JavaScript code to compose them — a pattern [Cloudflare also explored as "Code Mode"](https://blog.cloudflare.com/code-mode-mcp/), but without needing any specific infrastructure.

> [!IMPORTANT] 
> This project is early software, don't use it on a production organisation without caution

## How it works

1. The agent calls **`search`** with keywords (e.g. `"deploy application"`) and gets back matching commands with their description, parameters, and the types they use
2. The agent calls **`execute`** with JavaScript code that uses a pre-authenticated Clever Cloud client and the discovered commands, for instance to list the applications meant to be running:

```js
const apps = await client.send(new commands.ListApplicationCommand({ ownerId: "orga_xxx" }));
return apps
  .filter((app) => app.state === "SHOULD_BE_UP")
  .map(({ id, name, zone }) => ({ id, name, zone }));
```

3. The agent calls **`doc`** to search Clever Cloud's documentation index or fetch a specific page as markdown — useful for conceptual questions the API catalog can't answer (runtimes, add-ons, deployment model, environment variables, etc.).

The full [`@clevercloud/client`](https://github.com/CleverCloud/clever-client.js) command library is available — including automatic owner ID resolution, response transformation, and structured error handling.

## Security model

The code sent to `execute` runs on your machine, inside the server process, with no sandbox: it has the same rights as the server, including its environment (so the API token), files and network access. This is a single-user tool, meant to be driven by an agent you trust with your Clever Cloud account:

- Use an API token limited to what the agent should be able to do, and an organisation you can afford to experiment on
- Exact occurrences of the API token are masked in every tool response, but code could still send it elsewhere
- A timed out or cancelled execution aborts the requests made through the client and stops waiting for the code, but cannot stop the code itself: an operation the API already processed may have taken effect, and code that keeps the CPU busy blocks the whole server, timeout included

## Setup

### Prerequisites

- Node.js >= 26
- A Clever Cloud API token ([create one here](https://console.clever-cloud.com/users/me/tokens))

### Install

```bash
git clone https://github.com/CleverCloud/mcp-simple-server.git
cd mcp-simple-server
npm clean-install
```

`npm clean-install` installs the exact dependency versions of the lockfile and builds the server into `dist/`.

### Configure in Claude Code

Using the CLI:

```bash
claude mcp add clever-cloud \
  -e CLEVER_CLOUD_API_TOKEN=your-api-token \
  -- node /absolute/path/to/mcp-simple-server/dist/index.js
```

Or add a `.mcp.json` file at the root of your project:

```json
{
  "mcpServers": {
    "clever-cloud": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-simple-server/dist/index.js"],
      "env": {
        "CLEVER_CLOUD_API_TOKEN": "${CLEVER_CLOUD_API_TOKEN}"
      }
    }
  }
}
```

The `.mcp.json` approach supports environment variable expansion (`${VAR}` or `${VAR:-default}`), so you can keep your token in your shell environment rather than in the file itself.

### Optional environment variables

| Variable | Default | Accepted values | Description |
|----------|---------|-----------------|-------------|
| `CC_MCP_TIMEOUT_MS` | `30000` | 1000 to 2147483647 | Timeout of an `execute` call, in milliseconds |
| `CC_MCP_MAX_OUTPUT` | `50000` | 1000 to 10000000 | Maximum length of a tool response, in characters |

The server refuses to start on a value it cannot accept, and says why.

## Development

The sources run as is on Node.js 26, which strips the TypeScript types: `node src/index.ts` starts the server without building it.

```bash
npm run check             # Type check, build, then run the tests
npm run generate-catalog  # Regenerate the command catalog, after upgrading @clevercloud/client
```

The command catalog (`src/catalog/command-catalog.json`) and registry (`src/commands/command-registry.ts`) are generated from the type declarations of `@clevercloud/client`, through the TypeScript checker, and committed: do not edit them by hand. The CI checks they are up to date.

## License

Apache-2.0 — Clever Cloud, 2026
