import type BetterSqlite3 from "better-sqlite3";
import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(
  app: FastifyInstance,
  db: BetterSqlite3.Database,
): void {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      const row = db.prepare("SELECT 1 AS ok").get() as { ok: number };
      if (row.ok !== 1) throw new Error("database readiness check failed");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
}
