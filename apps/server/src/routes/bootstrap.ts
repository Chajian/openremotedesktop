import type { FastifyInstance } from "fastify";
import {
  OwnerAlreadyInitializedError,
  type OwnerRepository,
} from "../auth/owner-repository.js";

export function registerBootstrapRoutes(
  app: FastifyInstance,
  owners: OwnerRepository,
): void {
  app.post("/api/bootstrap", async (request, reply) => {
    const body = request.body as { password?: unknown } | null;
    if (!body || typeof body.password !== "string" || body.password.length === 0) {
      return reply.code(400).send({ error: "INVALID_PASSWORD" });
    }

    try {
      const owner = await owners.bootstrapOwner({ password: body.password });
      return reply.code(201).send({ ownerId: owner.id });
    } catch (error) {
      if (error instanceof OwnerAlreadyInitializedError) {
        return reply.code(409).send({ error: "OWNER_ALREADY_INITIALIZED" });
      }
      throw error;
    }
  });
}
