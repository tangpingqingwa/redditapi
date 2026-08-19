export const DEFAULT_PORT = 3000;
export const DEFAULT_DATABASE_PATH = "./data/redditapi.sqlite";
export const DEFAULT_FREE_CREDITS = 100;
export const DEFAULT_FREE_RPM = 30;

export function parseListenPort(value = process.env.PORT): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer 1-65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

export function resolveDatabasePath(value = process.env.REDDITAPI_DATABASE): string {
  if (value === undefined || value === "") {
    return DEFAULT_DATABASE_PATH;
  }
  return value;
}

export function resolveBootstrapKey(value = process.env.REDDITAPI_BOOTSTRAP_KEY): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}
