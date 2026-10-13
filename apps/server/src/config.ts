export type ServerEnvironment = "development" | "test" | "production";

export type ServerConfig = {
  databasePath: string;
  publicBaseUrl: URL;
  environment: ServerEnvironment;
  githubClientId?: string;
  githubClientSecret?: string;
};

export type ServerRuntimeConfig = ServerConfig & {
  listenHost: string;
  listenPort: number;
};

function environmentFrom(value: string | undefined): ServerEnvironment {
  if (value === "production" || value === "test") return value;
  return "development";
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("ODR_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function loadServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerRuntimeConfig {
  const environment = environmentFrom(env.NODE_ENV);
  const listenPort = parsePort(env.ODR_PORT);
  const listenHost = env.ODR_HOST?.trim() || "0.0.0.0";
  const databasePath =
    env.ODR_DATABASE_PATH?.trim() ||
    (environment === "production" ? "/data/server.sqlite" : "./data/server.sqlite");

  const rawBaseUrl =
    env.ODR_PUBLIC_BASE_URL?.trim() ||
    (environment === "production"
      ? undefined
      : `http://localhost:${listenPort}`);

  if (!rawBaseUrl) {
    throw new Error("ODR_PUBLIC_BASE_URL is required in production");
  }

  let publicBaseUrl: URL;
  try {
    publicBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error("ODR_PUBLIC_BASE_URL must be an absolute URL");
  }

  if (environment === "production" && publicBaseUrl.protocol !== "https:") {
    throw new Error("ODR_PUBLIC_BASE_URL must use https in production");
  }

  if (!["http:", "https:"].includes(publicBaseUrl.protocol)) {
    throw new Error("ODR_PUBLIC_BASE_URL must use http or https");
  }

  const githubClientId = env.ODR_GITHUB_CLIENT_ID?.trim();
  const githubClientSecret = env.ODR_GITHUB_CLIENT_SECRET?.trim();
  if (Boolean(githubClientId) !== Boolean(githubClientSecret)) {
    throw new Error("ODR_GITHUB_CLIENT_ID and ODR_GITHUB_CLIENT_SECRET must both be configured");
  }
  return {
    ...(githubClientId && githubClientSecret ? { githubClientId, githubClientSecret } : {}),
    databasePath,
    publicBaseUrl,
    environment,
    listenHost,
    listenPort,
  };
}
