import { db } from "../services/db.js";
import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";

function nowIso() {
  return new Date().toISOString();
}

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

export type WorldRole = "dm" | "player" | "observer";
export type ActorPermission = "owner" | "editor" | "viewer";

export type VaultUser = {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  must_reset_password: number;
  is_superadmin: number;
  created_at: string;
  updated_at: string;
};

// 2-32 chars, lowercase letters/numbers plus . _ - in the middle.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])$/;

function normalizeUsername(input: string): string {
  return String(input ?? "").trim().toLowerCase();
}

export class AuthStore {
  bootstrapAdminIfEmpty(username = "admin") {
    const row = db.prepare(`SELECT COUNT(*) as n FROM vault_users`).get() as any;
    if ((row?.n ?? 0) > 0) return;

    const id = uuid();
    const t = nowIso();
    const normalizedUsername = normalizeUsername(username) || "admin";
    const legacyEmail = `${normalizedUsername}@local`;

    const tempPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "change_me";
    const passwordHash = bcrypt.hashSync(tempPassword, 12);

    db.prepare(`
      INSERT INTO vault_users (id,username,email,password_hash,must_reset_password,is_superadmin,created_at,updated_at)
      VALUES (@id,@username,@email,@passwordHash,1,1,@t,@t)
    `).run({ id, username: normalizedUsername, email: legacyEmail, passwordHash, t });
  }

  listUsers(): Array<VaultUser> {
    return db.prepare(`
      SELECT id, username, email, display_name, must_reset_password, is_superadmin, created_at, updated_at
      FROM vault_users
      ORDER BY username ASC, created_at ASC
    `).all() as any;
  }

  createUser(args: {
    username: string;
    email?: string | null;
    isSuperadmin?: boolean;
    createdBy?: string;
  }) {
    const username = normalizeUsername(args.username);
    if (!username || !USERNAME_RE.test(username)) {
      return { ok: false as const, error: "Invalid username" };
    }

    const existing = db.prepare(`SELECT 1 FROM vault_users WHERE username=?`).get(username);
    if (existing) return { ok: false as const, error: "Username already exists" };

    const email = String(args.email ?? "").trim().toLowerCase() || `${username}@local`;
    const defaultDisplayName = username.replace(/[._-]+/g, " ").trim() || null;

    const id = uuid();
    const t = nowIso();

    db.prepare(`
      INSERT INTO vault_users (id,username,email,display_name,password_hash,must_reset_password,is_superadmin,created_at,updated_at)
      VALUES (@id,@username,@email,@displayName,NULL,1,@isSuperadmin,@t,@t)
    `).run({
      id,
      username,
      email,
      displayName: defaultDisplayName,
      isSuperadmin: args.isSuperadmin ? 1 : 0,
      t
    });

    const reset = this.createPasswordReset(id, args.createdBy, 60);

    return {
      ok: true as const,
      userId: id,
      username,
      email,
      resetToken: reset.token,
      resetId: reset.resetId
    };
  }

  getUserByUsername(username: string): VaultUser | null {
    return (
      (db.prepare(`
        SELECT id, username, email, display_name, must_reset_password, is_superadmin, created_at, updated_at
        FROM vault_users
        WHERE username=?
      `).get(normalizeUsername(username)) as any) ?? null
    );
  }

  getUserByEmail(email: string): VaultUser | null {
    return (
      (db.prepare(`
        SELECT id, username, email, display_name, must_reset_password, is_superadmin, created_at, updated_at
        FROM vault_users
        WHERE email=?
      `).get(String(email ?? "").trim().toLowerCase()) as any) ?? null
    );
  }

  getUserById(id: string): VaultUser | null {
    return (
      (db.prepare(`
        SELECT id, username, email, display_name, must_reset_password, is_superadmin, created_at, updated_at
        FROM vault_users
        WHERE id=?
      `).get(id) as any) ?? null
    );
  }

  getAnySuperadminId(): string {
    const row = db.prepare(`SELECT id FROM vault_users WHERE is_superadmin=1 LIMIT 1`).get() as any;
    if (!row?.id) throw new Error("No superadmin exists to attribute API-key actions.");
    return row.id as string;
  }

  /** -------------------------
   *  WORLD LINKS / ROLES
   *  ------------------------- */

  getWorldRole(worldId: string, userId: string): WorldRole | null {
    if (this.isSuperadmin(userId)) return "dm";

    const row = db.prepare(`
      SELECT role
      FROM world_user_links
      WHERE world_id=? AND vault_user_id=?
    `).get(worldId, userId) as any;

    return (row?.role as WorldRole) ?? null;
  }

  listActorLinksForUser(vaultUserId: string): Array<{
    worldId: string;
    actorId: string;
    permission: ActorPermission;
    linkedAt: string;
  }> {
    return db.prepare(`
      SELECT
        world_id AS worldId,
        actor_id AS actorId,
        permission,
        linked_at AS linkedAt
      FROM world_actor_links
      WHERE vault_user_id=?
      ORDER BY linked_at DESC
    `).all(vaultUserId) as any;
  }

  isWorldMember(worldId: string, userId: string): boolean {
    if (this.isSuperadmin(userId)) return true;

    const row = db.prepare(`
      SELECT 1
      FROM world_user_links
      WHERE world_id=? AND vault_user_id=?
    `).get(worldId, userId);

    return !!row;
  }

  isWorldDm(worldId: string, userId: string): boolean {
    if (this.isSuperadmin(userId)) return true;
    return this.getWorldRole(worldId, userId) === "dm";
  }

  canAccessActor(args: { worldId: string; actorId: string; vaultUserId: string }): boolean {
    if (this.isSuperadmin(args.vaultUserId)) return true;
    if (this.isWorldDm(args.worldId, args.vaultUserId)) return true;

    const row = db.prepare(`
      SELECT 1
      FROM world_actor_links
      WHERE world_id=? AND actor_id=? AND vault_user_id=?
    `).get(args.worldId, args.actorId, args.vaultUserId);

    return !!row;
  }

  /**
   * Returns linked worlds (for UI) including role + optional foundryUserId.
   */
  listUserWorldLinks(vaultUserId: string): Array<{
    worldId: string;
    foundryUserId: string | null;
    role: WorldRole;
    linkedAt: string;
  }> {
    return db.prepare(`
      SELECT
        world_id  AS worldId,
        foundry_user_id AS foundryUserId,
        role      AS role,
        linked_at AS linkedAt
      FROM world_user_links
      WHERE vault_user_id=?
      ORDER BY linked_at DESC
    `).all(vaultUserId) as any;
  }

  /** -------------------------
   *  LOGIN / PASSWORDS
   *  ------------------------- */

  verifyLogin(identifier: string, password: string): { ok: true; user: VaultUser } | { ok: false; error: string } {
    const ident = String(identifier ?? "").trim().toLowerCase();
    const row =
      (db.prepare(`SELECT * FROM vault_users WHERE username=?`).get(ident) as any) ??
      (db.prepare(`SELECT * FROM vault_users WHERE email=?`).get(ident) as any);
    if (!row) return { ok: false, error: "Invalid username or password" };
    if (!row.password_hash) return { ok: false, error: "Password not set. Ask an admin for a reset link." };

    const ok = bcrypt.compareSync(password, row.password_hash);
    if (!ok) return { ok: false, error: "Invalid username or password" };

    const user: VaultUser = {
      id: row.id,
      username: row.username,
      email: row.email,
      must_reset_password: row.must_reset_password,
      display_name: row.display_name ?? null,
      is_superadmin: row.is_superadmin,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
    return { ok: true, user };
  }

  setPassword(userId: string, newPassword: string) {
    const hash = bcrypt.hashSync(newPassword, 12);
    db.prepare(`
      UPDATE vault_users
      SET password_hash=?, must_reset_password=0, updated_at=?
      WHERE id=?
    `).run(hash, nowIso(), userId);
  }

  createPasswordReset(userId: string, createdBy?: string, minutes = 60) {
    const token = randomBytes(32).toString("hex");
    const tokenHash = sha256(token);
    const id = uuid();

    db.prepare(`
      INSERT INTO password_reset_tokens (id, vault_user_id, token_hash, created_at, expires_at, created_by_vault_user_id)
      VALUES (?,?,?,?,?,?)
    `).run(
      id,
      userId,
      tokenHash,
      nowIso(),
      new Date(Date.now() + minutes * 60_000).toISOString(),
      createdBy ?? null
    );

    db.prepare(`UPDATE vault_users SET must_reset_password=1, updated_at=? WHERE id=?`)
      .run(nowIso(), userId);

    return { resetId: id, token };
  }

  consumePasswordReset(token: string, newPassword: string) {
    const tokenHash = sha256(token);
    const row = db.prepare(`SELECT * FROM password_reset_tokens WHERE token_hash=?`).get(tokenHash) as any;
    if (!row) return { ok: false as const, error: "Invalid token" };
    if (row.used_at) return { ok: false as const, error: "Token already used" };
    if (Date.parse(row.expires_at) < Date.now()) return { ok: false as const, error: "Token expired" };

    this.setPassword(row.vault_user_id, newPassword);
    db.prepare(`UPDATE password_reset_tokens SET used_at=? WHERE id=?`).run(nowIso(), row.id);

    return { ok: true as const, userId: row.vault_user_id as string };
  }

  /** -------------------------
   *  INVITES (grant world role)
   *  ------------------------- */

  createInvite(args: {
    worldId: string;
    foundryUserId: string;
    role?: WorldRole;
    createdBy: string;
    expiresMinutes?: number;
    maxUses?: number;
  }) {
    const code = randomBytes(24).toString("hex");
    const codeHash = sha256(code);

    const id = uuid();
    const createdAt = nowIso();
    const expiresAt = args.expiresMinutes
      ? new Date(Date.now() + args.expiresMinutes * 60_000).toISOString()
      : null;

    db.prepare(`
      INSERT INTO invites (
        id, world_id, foundry_user_id, role,
        code_hash, created_by_vault_user_id, created_at, expires_at, max_uses
      )
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      args.worldId,
      args.foundryUserId,
      args.role ?? "player",
      codeHash,
      args.createdBy,
      createdAt,
      expiresAt,
      args.maxUses ?? 1
    );

    return { inviteId: id, code };
  }

  private isSuperadmin(userId: string): boolean {
    const row = db.prepare(`SELECT is_superadmin FROM vault_users WHERE id=?`).get(userId) as any;
    return !!row?.is_superadmin;
  }
  
  redeemInvite(args: { code: string; vaultUserId: string }) {
    const codeHash = sha256(args.code);
    const row = db.prepare(`SELECT * FROM invites WHERE code_hash=?`).get(codeHash) as any;

    if (!row) return { ok: false as const, error: "Invalid invite" };
    if (row.revoked) return { ok: false as const, error: "Invite revoked" };
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return { ok: false as const, error: "Invite expired" };
    if ((row.uses ?? 0) >= (row.max_uses ?? 1)) return { ok: false as const, error: "Invite already used" };

    db.prepare(`
      INSERT OR REPLACE INTO world_user_links (
        vault_user_id, world_id, foundry_user_id, role, linked_at
      )
      VALUES (?,?,?,?,?)
    `).run(
      args.vaultUserId,
      row.world_id,
      row.foundry_user_id ?? null,
      (row.role as WorldRole) ?? "player",
      nowIso()
    );

    db.prepare(`UPDATE invites SET uses=uses+1 WHERE id=?`).run(row.id);

    return {
      ok: true as const,
      worldId: row.world_id as string,
      foundryUserId: (row.foundry_user_id as string) ?? null,
      role: (row.role as WorldRole) ?? "player"
    };
  }

  /** -------------------------
   *  ACTOR LINKS (world_actor_links)
   *  ------------------------- */

  linkActorToUser(args: {
    worldId: string;
    actorId: string;
    vaultUserId: string;
    permission?: ActorPermission;
  }) {
    db.prepare(`
      INSERT OR REPLACE INTO world_actor_links (
        world_id, actor_id, vault_user_id, permission, linked_at
      )
      VALUES (?,?,?,?,?)
    `).run(
      args.worldId,
      args.actorId,
      args.vaultUserId,
      args.permission ?? "owner",
      nowIso()
    );

    return { ok: true as const };
  }

  unlinkActorFromUser(args: { worldId: string; actorId: string; vaultUserId: string }) {
    db.prepare(`
      DELETE FROM world_actor_links
      WHERE world_id=? AND actor_id=? AND vault_user_id=?
    `).run(args.worldId, args.actorId, args.vaultUserId);

    return { ok: true as const };
  }

  listActorsForUserInWorld(worldId: string, vaultUserId: string): Array<{
    actorId: string;
    permission: ActorPermission;
    linkedAt: string;
  }> {
    return db.prepare(`
      SELECT actor_id AS actorId, permission, linked_at AS linkedAt
      FROM world_actor_links
      WHERE world_id=? AND vault_user_id=?
      ORDER BY linked_at DESC
    `).all(worldId, vaultUserId) as any;
  }

  linkUserToWorld(args: {
    vaultUserId: string;
    worldId: string;
    foundryUserId: string | null;
    role: WorldRole;
  }) {
    db.prepare(`
      INSERT OR REPLACE INTO world_user_links (
        vault_user_id, world_id, foundry_user_id, role, linked_at
      )
      VALUES (?,?,?,?,?)
    `).run(
      args.vaultUserId,              // ✅ FIX
      args.worldId,
      args.foundryUserId ?? null,
      args.role ?? "player",
      nowIso()
    );

    return { ok: true as const };
  }

  unlinkUserFromWorld(args: { userId?: string; vaultUserId?: string; worldId: string }) {
    const userId = args.vaultUserId ?? args.userId;
    if (!userId) return { ok: false as const, error: "userId is required" };

    db.prepare(`
      DELETE FROM world_user_links
      WHERE vault_user_id=? AND world_id=?
    `).run(userId, args.worldId);

    // Optional but recommended cleanup: also remove actor links in that world for that user
    db.prepare(`
      DELETE FROM world_actor_links
      WHERE vault_user_id=? AND world_id=?
    `).run(userId, args.worldId);

    return { ok: true as const };
  }

  linkUserToActor(args: {
    userId: string;
    worldId: string;
    actorId: string;
    permission?: ActorPermission;
  }) {
    return this.linkActorToUser({
      worldId: args.worldId,
      actorId: args.actorId,
      vaultUserId: args.userId,
      permission: args.permission
    });
  }

  unlinkUserFromActor(args: { userId: string; worldId: string; actorId: string }) {
    return this.unlinkActorFromUser({
      worldId: args.worldId,
      actorId: args.actorId,
      vaultUserId: args.userId
    });
  }

  listUserActorLinks(vaultUserId: string): Array<{
    worldId: string;
    actorId: string;
    permission: ActorPermission;
    linkedAt: string;
  }> {
    return db.prepare(`
      SELECT
        world_id AS worldId,
        actor_id AS actorId,
        permission AS permission,
        linked_at AS linkedAt
      FROM world_actor_links
      WHERE vault_user_id=?
      ORDER BY linked_at DESC
    `).all(vaultUserId) as any;
  }

}



export const authStore = new AuthStore();
