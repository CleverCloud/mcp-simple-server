export interface Config {
  apiToken: string;
  executionTimeoutMs: number;
  maxOutputLength: number;
}

/** Reads the configuration from the environment, throwing on a missing or invalid value */
export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.CLEVER_CLOUD_API_TOKEN?.trim();
  if (!apiToken) {
    throw new Error(
      "CLEVER_CLOUD_API_TOKEN environment variable is required. Create an API token at https://console.clever-cloud.com/users/me/tokens",
    );
  }

  return {
    apiToken,
    // Timers overflow past 2^31 - 1 milliseconds
    executionTimeoutMs: readInteger(env, "CC_MCP_TIMEOUT_MS", { fallback: 30_000, min: 1_000, max: 2 ** 31 - 1 }),
    // The minimum leaves room for the truncation notice
    maxOutputLength: readInteger(env, "CC_MCP_MAX_OUTPUT", { fallback: 50_000, min: 1_000, max: 10_000_000 }),
  };
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  { fallback, min, max }: { fallback: number; min: number; max: number },
): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${value}"`);
  }
  return parsed;
}
