import { randomBytes, randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import { hashPassword, verifyPassword } from "./password.js";

export type Owner = {
  id: string;
  createdAt: number;
};

type OwnerRow = {
  id: string;
  password_hash: string;
  created_at: number;
};

export class OwnerAlreadyInitializedError extends Error {
  constructor() {
    super("Owner has already been initialized");
    this.name = "OwnerAlreadyInitializedError";
  }
}

export class OwnerRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  async bootstrapOwner(input: { password: string }): Promise<Owner> {
    const passwordHash = await hashPassword(input.password);
    const create = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT id FROM owner WHERE auth_source = 'local' LIMIT 1")
        .get() as { id: string } | undefined;
      if (existing) throw new OwnerAlreadyInitializedError();

      const owner: Owner = {
        id: randomUUID(),
        createdAt: Date.now(),
      };
      this.db
        .prepare(
          "INSERT INTO owner (id, password_hash, created_at) VALUES (?, ?, ?)",
        )
        .run(owner.id, passwordHash, owner.createdAt);
      return owner;
    });

    return create();
  }

  getOwner(): OwnerRow | null {
    return (
      (this.db
        .prepare(
          "SELECT id, password_hash, created_at FROM owner WHERE auth_source = 'local' LIMIT 1",
        )
        .get() as OwnerRow | undefined) ?? null
    );
  }

  getUserById(userId: string): Owner | null {
    const row = this.db.prepare("SELECT id, created_at AS createdAt FROM owner WHERE id = ?")
      .get(userId) as Owner | undefined;
    return row ?? null;
  }

  findOrCreateGitHubUser(githubUserId: string, login: string): Owner {
    if (!/^[0-9]{1,20}$/.test(githubUserId) || !/^[a-zA-Z0-9-]{1,39}$/.test(login)) {
      throw new TypeError("Invalid GitHub identity");
    }
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id, created_at AS createdAt FROM owner WHERE github_user_id = ?")
        .get(githubUserId) as Owner | undefined;
      if (existing) {
        this.db.prepare("UPDATE owner SET github_login = ? WHERE id = ?").run(login, existing.id);
        return existing;
      }
      const user: Owner = { id: randomUUID(), createdAt: Date.now() };
      this.db.prepare(
        "INSERT INTO owner (id, password_hash, created_at, auth_source, github_user_id, github_login) VALUES (?, ?, ?, 'github', ?, ?)"
      ).run(user.id, "disabled-github:" + randomBytes(32).toString("hex"), user.createdAt, githubUserId, login);
      return user;
    })();
  }

  async verifyOwnerPassword(password: string): Promise<Owner | null> {
    const row = this.getOwner();
    if (!row) return null;
    if (!(await verifyPassword(password, row.password_hash))) return null;
    return { id: row.id, createdAt: row.created_at };
  }

  async changePassword(
    ownerId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const row = this.getOwner();
    if (!row || row.id !== ownerId) return false;
    if (!(await verifyPassword(currentPassword, row.password_hash))) return false;

    const newHash = await hashPassword(newPassword);
    const update = this.db.transaction(() =>
      this.db
        .prepare(
          "UPDATE owner SET password_hash = ? WHERE id = ? AND password_hash = ?",
        )
        .run(newHash, ownerId, row.password_hash),
    );
    return update().changes === 1;
  }
}
