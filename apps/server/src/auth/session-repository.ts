import { createHash, randomBytes, randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import type { FastifyRequest } from "fastify";

export type OwnerPrincipal = { ownerId: string };
export type SessionToken = string;

export type SessionRepositoryOptions = {
  now?: () => number;
  ttlMs?: number;
};

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function ownerSessionToken(
  request: FastifyRequest,
): string | null {
  return cookieValue(request.headers.cookie, "odr_session");
}

export function requireOwnerSession(
  request: FastifyRequest,
  sessions: SessionRepository,
): OwnerPrincipal | null {
  const token = ownerSessionToken(request);
  return token ? sessions.verifyOwnerSession(token) : null;
}

export class SessionRepository {
  readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: BetterSqlite3.Database,
    options: SessionRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  createOwnerSession(ownerId: string): SessionToken {
    const token = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    this.db
      .prepare(
        `INSERT INTO owner_sessions
          (id, owner_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        ownerId,
        hashToken(token),
        createdAt + this.ttlMs,
        createdAt,
      );
    return token;
  }

  revokeSession(sessionToken: string): boolean {
    return this.db.prepare("DELETE FROM owner_sessions WHERE token_hash = ?")
      .run(hashToken(sessionToken)).changes === 1;
  }

  invalidateOtherSessions(ownerId: string, currentToken: string): number {
    const currentHash = hashToken(currentToken);
    return this.db
      .prepare(
        "DELETE FROM owner_sessions WHERE owner_id = ? AND token_hash <> ?",
      )
      .run(ownerId, currentHash).changes;
  }

  verifyOwnerSession(token: string): OwnerPrincipal | null {
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare(
        "SELECT owner_id AS ownerId, expires_at AS expiresAt FROM owner_sessions WHERE token_hash = ?",
      )
      .get(tokenHash) as { ownerId: string; expiresAt: number } | undefined;

    if (!row) return null;
    if (row.expiresAt <= this.now()) {
      this.db
        .prepare("DELETE FROM owner_sessions WHERE token_hash = ?")
        .run(tokenHash);
      return null;
    }
    return { ownerId: row.ownerId };
  }
}
