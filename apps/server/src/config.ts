export type ServerEnvironment = "development" | "test" | "production";

export type ServerConfig = {
  databasePath: string;
  publicBaseUrl: URL;
  /** Secondary public HTTPS origins accepted for this same Server instance. */
  additionalPublicBaseUrls?: URL[];
  environment: ServerEnvironment;
  agentInstallEnabled?: boolean;
  /** Retention for minimal device deletion audit events; default 30 days. */
  deviceDeletionAuditRetentionDays?: number;
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

  const extraOrigins = env.ODR_ADDITIONAL_PUBLIC_BASE_URLS?.trim();
  const additionalPublicBaseUrls = extraOrigins
    ? extraOrigins.split(",").map((entry) => {
      let url: URL;
      try { url = new URL(entry.trim()); } catch { throw new Error("Invalid ODR_ADDITIONAL_PUBLIC_BASE_URLS entry"); }
      if (url.protocol !== publicBaseUrl.protocol || url.pathname !== "/" ||
          url.search || url.hash || url.username || url.password ||
          url.origin === publicBaseUrl.origin) {
        throw new Error("ODR_ADDITIONAL_PUBLIC_BASE_URLS must contain distinct origins using the primary scheme");
      }
      return url;
    })
    : [];
  if (new Set(additionalPublicBaseUrls.map((url) => url.origin)).size !== additionalPublicBaseUrls.length) {
    throw new Error("ODR_ADDITIONAL_PUBLIC_BASE_URLS contains a duplicate origin");
  }

  const retentionRaw = env.ODR_DEVICE_DELETION_AUDIT_RETENTION_DAYS ?? "30";
  const deviceDeletionAuditRetentionDays = Number(retentionRaw);
  if (!Number.isSafeInteger(deviceDeletionAuditRetentionDays) ||
      deviceDeletionAuditRetentionDays < 1 || deviceDeletionAuditRetentionDays > 3650) {
    throw new Error("ODR_DEVICE_DELETION_AUDIT_RETENTION_DAYS must be 1..3650");
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
    ...(additionalPublicBaseUrls.length ? { additionalPublicBaseUrls } : {}),
    environment,
    agentInstallEnabled: env.ODR_AGENT_INSTALL_ENABLED === "true",
    deviceDeletionAuditRetentionDays,
    listenHost,
    listenPort,
  };
}

/** Resolve only explicit, configured Host values. Never trust X-Forwarded-Host. */
export function publicBaseUrlForHost(config: ServerConfig, host: string | undefined): URL {
  const normalizedHost = typeof host === "string" ? host.trim().toLowerCase() : "";
  return [config.publicBaseUrl, ...(config.additionalPublicBaseUrls ?? [])]
    .find((base) => base.host.toLowerCase() === normalizedHost) ?? config.publicBaseUrl;
}
