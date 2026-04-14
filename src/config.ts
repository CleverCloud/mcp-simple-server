export interface Config {
  apiToken: string;
  executionTimeoutMs: number;
  maxOutputLength: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid value "${value}", using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

export function getConfig(): Config {
  const apiToken = process.env.CLEVER_CLOUD_API_TOKEN;
  if (!apiToken) {
    console.error(
      "CLEVER_CLOUD_API_TOKEN environment variable is required.\n" +
        "Create an API token at https://console.clever-cloud.com/users/me/tokens",
    );
    process.exit(1);
  }

  return {
    apiToken,
    executionTimeoutMs: parsePositiveInt(
      process.env.CC_MCP_TIMEOUT_MS,
      30_000,
    ),
    maxOutputLength: parsePositiveInt(
      process.env.CC_MCP_MAX_OUTPUT,
      50_000,
    ),
  };
}
