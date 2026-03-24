// @ts-nocheck
// src/__tests__/auth.test.ts
import request from "supertest";
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import session from "express-session";

import { createApp } from "../app.js";
import { VaultStore } from "../services/vaultStore.js";
import { migrate } from "../services/db.js";
import { authStore } from "../services/authStore.js";
import { WorldStore } from "../stores/worldStore.js";
import { ActorsStore } from "../stores/actorsStore.js";
import { ImportsStore } from "../stores/importStore.js";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { db } from "../services/db.js";

type Logger = {
  info: (msg: string, meta?: any) => void;
  warn: (msg: string, meta?: any) => void;
  error: (msg: string, meta?: any) => void;
};

// Simple noop logger for tests
const logger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {}
};

const fixtureRoot = path.resolve("test-fixtures/vault");
const apiKey = "dev-key";

// MemoryStore is fine for tests
const sessionConfig: session.SessionOptions = {
  secret: "test-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false }
};

function apiKeyAuth(r: request.Test, key = apiKey) {
  return r.set("Authorization", `Bearer ${key}`);
}

function createVaultUserInDb(args: { username: string; password: string }) {
  const id = uuid();
  const t = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(args.password, 12);

  db.prepare(`
    INSERT INTO vault_users (id,username,email,password_hash,must_reset_password,is_superadmin,created_at,updated_at)
    VALUES (@id,@username,@email,@passwordHash,0,0,@t,@t)
  `).run({ id, username: args.username, email: `${args.username}@local`, passwordHash, t });

  return { id };
}

async function createAndLoginUser(app: ReturnType<typeof createApp>, suffix: string) {
  const username = `perm_${suffix}_${uuid().slice(0, 6)}`;
  const password = "Test_password_123";
  const user = createVaultUserInDb({ username, password });
  const userAgent = request.agent(app);
  const loginRes = await userAgent.post("/auth/login").send({
    username,
    password
  });

  expect(loginRes.status).toBe(200);
  expect(loginRes.body.ok).toBe(true);

  return { userId: user.id, username, password, agent: userAgent };
}

async function ensureActorsExportFixtures() {
  const worldId = "test-world";
  const exportDir = path.join(fixtureRoot, "worlds", worldId, "vaultsync", "exports", "actors");
  const manifestDir = path.join(exportDir, "_manifest");
  await fs.mkdir(manifestDir, { recursive: true });

  const actorA = JSON.parse(await fs.readFile(path.join(fixtureRoot, "worlds", worldId, "actors", "actorA.json"), "utf-8"));
  const actorB = JSON.parse(await fs.readFile(path.join(fixtureRoot, "worlds", worldId, "actors", "actorB.json"), "utf-8"));
  const actorC = {
    ...actorA,
    _id: "actorC",
    id: "actorC",
    name: "Companion Character",
  };

  const actorAFile = `worlds/${worldId}/vaultsync/exports/actors/actor.actorA.1000.test.json`;
  const actorBFile = `worlds/${worldId}/vaultsync/exports/actors/actor.actorB.1001.test.json`;
  const actorCFile = `worlds/${worldId}/vaultsync/exports/actors/actor.actorC.1002.test.json`;

  await fs.writeFile(path.join(fixtureRoot, actorAFile), JSON.stringify({
    type: "export",
    docType: "Actor",
    uuid: "Actor.actorA",
    externalId: "vh:Actor:actorA",
    foundry: actorA,
    exportedAt: "2026-03-11T00:00:00.000Z",
  }, null, 2));

  await fs.writeFile(path.join(fixtureRoot, actorBFile), JSON.stringify({
    type: "export",
    docType: "Actor",
    uuid: "Actor.actorB",
    externalId: "vh:Actor:actorB",
    foundry: actorB,
    exportedAt: "2026-03-11T00:00:01.000Z",
  }, null, 2));

  await fs.writeFile(path.join(fixtureRoot, actorCFile), JSON.stringify({
    type: "export",
    docType: "Actor",
    uuid: "Actor.actorC",
    externalId: "vh:Actor:actorC",
    foundry: actorC,
    exportedAt: "2026-03-11T00:00:02.000Z",
  }, null, 2));

  await fs.writeFile(path.join(manifestDir, "index.1003.test.json"), JSON.stringify({
    worldId,
    generatedAt: "2026-03-11T00:00:03.000Z",
    actors: {
      actorA: {
        id: "actorA",
        key: "actorA",
        uuid: "Actor.actorA",
        externalId: "vh:Actor:actorA",
        name: actorA.name,
        type: actorA.type,
        latestFile: actorAFile,
        updatedAt: "2026-03-11T00:00:00.000Z",
        exportedAt: "2026-03-11T00:00:00.000Z",
      },
      actorB: {
        id: "actorB",
        key: "actorB",
        uuid: "Actor.actorB",
        externalId: "vh:Actor:actorB",
        name: actorB.name,
        type: actorB.type,
        latestFile: actorBFile,
        updatedAt: "2026-03-11T00:00:01.000Z",
        exportedAt: "2026-03-11T00:00:01.000Z",
      },
      actorC: {
        id: "actorC",
        key: "actorC",
        uuid: "Actor.actorC",
        externalId: "vh:Actor:actorC",
        name: actorC.name,
        type: actorC.type,
        latestFile: actorCFile,
        updatedAt: "2026-03-11T00:00:02.000Z",
        exportedAt: "2026-03-11T00:00:02.000Z",
      }
    }
  }, null, 2));
}

describe("auth + authz (session + api key)", () => {
  let app: ReturnType<typeof createApp>;
  let agent: request.SuperAgentTest;

  // We’ll use these across tests
  const adminUsername = process.env.BOOTSTRAP_ADMIN_USERNAME ?? "admin";
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "change_me";

  beforeAll(async () => {
    // Ensure DB schema exists
    migrate();
    await ensureActorsExportFixtures();

    // Bootstrap admin (expected to exist after this)
    // Prefer returning a temp password from bootstrap for tests.
    const boot: any = await (authStore as any).bootstrapAdminIfEmpty?.(adminUsername);

    app = createApp({
      vault: new VaultStore(fixtureRoot),
      vaultRoot: fixtureRoot,
      apiKey,
      authStore,
      worldStore: new WorldStore(fixtureRoot),
      actorsStore: new ActorsStore({
        dataRoot: fixtureRoot,
        vaultDirName: "vault",
        allowLegacyWorldRoot: true,
      }),
      importsStore: new ImportsStore({
        dataRoot: fixtureRoot
      }),
      allowUnauthedPaths: ["/health", "/auth/login", "/auth/reset-password", "/invites/redeem"],
      sessionConfig,
      logger
    });

    agent = request.agent(app); // keeps cookies across requests
  });

  it("API key can access protected routes (baseline)", async () => {
    const res = await apiKeyAuth(request(app).get("/worlds"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.worlds)).toBe(true);
  });

  it("session-less user is blocked from world-admin endpoint", async () => {
    const res = await request(app).post("/worlds/test-world/invites").send({
      foundryUserId: "foundry-user-1"
    });
    expect([401, 403]).toContain(res.status);
  });

  it("admin can login via session (cookie set)", async () => {
    const res = await agent.post("/auth/login").send({
      username: adminUsername,
      password: adminPassword
    });

    // Depending on your implementation:
    // - could be 200 OK
    // - could be 403/400 if must_reset_password is enforced at login
    // Adjust expectations to your intended contract.
    expect([200, 400, 401, 403]).toContain(res.status);

    if (res.status !== 200) {
      // If your app forces password reset before allowing login,
      // this is where you’d call /auth/reset-password flow in tests.
      // For now, we fail with a helpful message so you can wire it up.
      throw new Error(
        `Login did not succeed (status=${res.status}). If you enforce must_reset_password, update this test to perform reset first. Body=${JSON.stringify(
          res.body
        )}`
      );
    }

    expect(res.body.ok).toBe(true);
  });

  it("after login, session can access /worlds without API key", async () => {
    const res = await agent.get("/worlds");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.worlds)).toBe(true);
  });

  it("admin session can create an invite (world admin required)", async () => {
    const res = await agent.post("/worlds/test-world/invites").send({
      foundryUserId: "foundry-user-1",
      expiresMinutes: 60
    });

    // If your admin isn’t automatically a world admin for test-world,
    // this will be 403. In that case, set up world admin membership in beforeAll
    // using your authStore (recommended).
    expect([200, 403]).toContain(res.status);

    if (res.status === 403) {
      throw new Error(
        `Admin is not a world admin for test-world. Either (1) add a fixture world_admins row in bootstrap, or (2) grant it in beforeAll via authStore. Body=${JSON.stringify(
          res.body
        )}`
      );
    }

    expect(res.body.ok).toBe(true);
    expect(res.body.inviteId).toBeTruthy();
    expect(res.body.code).toBeTruthy(); // returned once
  });

    it("second user can redeem invite and then access world reads (requireWorldMember)", async () => {
    // 1) Admin creates invite for test-world (bound to a foundry user id)
    const invRes = await agent.post("/worlds/test-world/invites").send({
        foundryUserId: "foundry-user-2",
        expiresMinutes: 60
    });

    expect(invRes.status).toBe(200);
    expect(invRes.body.ok).toBe(true);
    expect(invRes.body.code).toBeTruthy();

    const inviteCode = invRes.body.code as string;

    // 2) Create second user directly in DB (since no user-create endpoint yet)
    const userUsername = `user2_${uuid().slice(0, 8)}`;
    const userPassword = "user2_password_123";
    createVaultUserInDb({ username: userUsername, password: userPassword });

    // 3) Login as second user with a new session agent (cookie jar)
    const userAgent = request.agent(app);

    const loginRes = await userAgent.post("/auth/login").send({
        username: userUsername,
        password: userPassword
    });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.ok).toBe(true);

    // 4) Before redeem: /me/worlds should be empty (or missing the world)
    const meWorldsBefore = await userAgent.get("/me/worlds");
    expect(meWorldsBefore.status).toBe(200);
    expect(meWorldsBefore.body.ok).toBe(true);
    expect(Array.isArray(meWorldsBefore.body.worlds)).toBe(true);

    // 5) Redeem invite to link user -> world_user_links
    const redeemRes = await userAgent.post("/invites/redeem").send({ code: inviteCode });
    expect(redeemRes.status).toBe(200);
    expect(redeemRes.body.ok).toBe(true);
    expect(redeemRes.body.worldId).toBe("test-world");
    expect(redeemRes.body.foundryUserId).toBe("foundry-user-2");

    // 6) After redeem: /auth/me/worlds includes test-world
    const meWorldsAfter = await userAgent.get("/me/worlds");
    expect(meWorldsAfter.status).toBe(200);
    expect(meWorldsAfter.body.ok).toBe(true);

    const worlds = meWorldsAfter.body.worlds as Array<{ id?: string; worldId?: string; foundryUserId: string }>;
    expect(worlds.some(w => (w.worldId ?? w.id) === "test-world")).toBe(true);

    // 7) PROVE requireWorldMember works:
    // ✅ linked world should allow reads
    const actorsOk = await userAgent.get("/worlds/test-world/actors");
    expect(actorsOk.status).toBe(200);

    // ❌ not-linked world should be blocked by authz (membership)
    const actorsNo = await userAgent.get("/worlds/__not_linked__/actors");
    expect([403, 404]).toContain(actorsNo.status);
    // If your requireWorldMember runs before filesystem access, you’ll consistently get 403.
    });

  it("non-logged-in user cannot redeem invite (requires session user)", async () => {
    const res = await request(app).post("/invites/redeem").send({ code: "nope" });
    expect([401, 403]).toContain(res.status);
  });

  it("GET /me/worlds returns linked worlds for session user", async () => {
    const res = await agent.get("/me/worlds");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.worlds)).toBe(true);
    });

  it("set-password rejects empty and too-short passwords", async () => {
    const user = await createAndLoginUser(app, "setpw-policy");

    const emptyRes = await user.agent.post("/auth/set-password").send({ newPassword: "   " });
    expect(emptyRes.status).toBe(400);
    expect(String(emptyRes.body?.error ?? "")).toContain("required");

    const shortRes = await user.agent.post("/auth/set-password").send({ newPassword: "short" });
    expect(shortRes.status).toBe(400);
    expect(String(shortRes.body?.error ?? "")).toContain("at least 8");

    const validPassword = "Updated_password_123";
    const okRes = await user.agent.post("/auth/set-password").send({ newPassword: validPassword });
    expect(okRes.status).toBe(200);
    expect(okRes.body.ok).toBe(true);

    const relogin = await request(app).post("/auth/login").send({
      username: user.username,
      password: validPassword,
    });
    expect(relogin.status).toBe(200);
    expect(relogin.body.ok).toBe(true);
  });

  it("reset-password rejects invalid newPassword values", async () => {
    const username = `resetpw_${uuid().slice(0, 8)}`;
    const user = createVaultUserInDb({ username, password: "Reset_old_password_123" });
    const firstReset = authStore.createPasswordReset(user.id);

    const emptyRes = await request(app).post("/auth/reset-password").send({
      token: firstReset.token,
      newPassword: "",
    });
    expect(emptyRes.status).toBe(400);
    expect(String(emptyRes.body?.error ?? "")).toContain("required");

    const shortRes = await request(app).post("/auth/reset-password").send({
      token: firstReset.token,
      newPassword: "short",
    });
    expect(shortRes.status).toBe(400);
    expect(String(shortRes.body?.error ?? "")).toContain("at least 8");

    const secondReset = authStore.createPasswordReset(user.id);
    const okRes = await request(app).post("/auth/reset-password").send({
      token: secondReset.token,
      newPassword: "Reset_new_password_123",
    });
    expect(okRes.status).toBe(200);
    expect(okRes.body.ok).toBe(true);
  });

  it("wrong API key is rejected", async () => {
    const res = await apiKeyAuth(request(app).get("/worlds"), "wrong-key");
    expect([401, 403]).toContain(res.status);
  });

  it("import status returns 404 for unknown import ids", async () => {
    const user = await createAndLoginUser(app, "import-status");
    authStore.linkUserToWorld({
      vaultUserId: user.userId,
      worldId: "test-world",
      foundryUserId: "foundry-user-import-status",
      role: "player",
    });

    const res = await user.agent.get("/worlds/test-world/imports/__missing_import__/status");
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.worldId).toBe("test-world");
    expect(res.body.importId).toBe("__missing_import__");
    expect(res.body.status).toEqual(
      expect.objectContaining({
        id: "__missing_import__",
        worldId: "test-world",
        status: "not_found",
      })
    );
  });

  it("player actor list only includes linked character actors", async () => {
    const player = await createAndLoginUser(app, "actors");
    authStore.linkUserToWorld({
      vaultUserId: player.userId,
      worldId: "test-world",
      foundryUserId: "foundry-user-perm-actors",
      role: "player"
    });
    authStore.linkActorToUser({
      worldId: "test-world",
      actorId: "actorA",
      vaultUserId: player.userId,
      permission: "owner"
    });
    authStore.linkActorToUser({
      worldId: "test-world",
      actorId: "actorB",
      vaultUserId: player.userId,
      permission: "owner"
    });

    const res = await player.agent.get("/worlds/test-world/actors");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.actors)).toBe(true);

    const actorIds = (res.body.actors as any[]).map((actor: any) => String(actor?.id ?? ""));
    expect(actorIds).toContain("actorA");
    expect(actorIds).not.toContain("actorB");
    expect((res.body.actors as any[]).every((actor: any) => String(actor?.type ?? "").toLowerCase() === "character")).toBe(true);
  });

  it("player cannot open NPC actor detail even if linked", async () => {
    const player = await createAndLoginUser(app, "npcdetail");
    authStore.linkUserToWorld({
      vaultUserId: player.userId,
      worldId: "test-world",
      foundryUserId: "foundry-user-perm-npc",
      role: "player"
    });
    authStore.linkActorToUser({
      worldId: "test-world",
      actorId: "actorB",
      vaultUserId: player.userId,
      permission: "owner"
    });

    const res = await player.agent.get("/worlds/test-world/actors/actorB");
    expect(res.status).toBe(403);
  });

  it("party endpoint returns summary-safe character rows for players", async () => {
    const player = await createAndLoginUser(app, "party");
    const teammate = await createAndLoginUser(app, "party-teammate");
    authStore.linkUserToWorld({
      vaultUserId: player.userId,
      worldId: "test-world",
      foundryUserId: "foundry-user-perm-party",
      role: "player"
    });
    authStore.linkUserToWorld({
      vaultUserId: teammate.userId,
      worldId: "test-world",
      foundryUserId: "foundry-user-perm-party-teammate",
      role: "player"
    });
    authStore.linkActorToUser({
      worldId: "test-world",
      actorId: "actorA",
      vaultUserId: player.userId,
      permission: "owner"
    });
    authStore.linkActorToUser({
      worldId: "test-world",
      actorId: "actorC",
      vaultUserId: teammate.userId,
      permission: "owner"
    });

    const res = await player.agent.get("/worlds/test-world/party");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.party)).toBe(true);

    const ids = (res.body.party as any[]).map((row: any) => String(row?.id ?? ""));
    expect(ids).toContain("actorA");
    expect(ids).toContain("actorC");
    expect(ids).not.toContain("actorB");

    const row = (res.body.party as any[]).find((entry: any) => String(entry?.id ?? "") === "actorA");
    expect(row).toEqual(
      expect.objectContaining({
        id: "actorA",
        name: expect.any(String),
        ownerNames: expect.any(String),
        isOwnedByRequester: true,
        activeMember: expect.any(Boolean),
        deceased: expect.any(Boolean),
        location: expect.any(String)
      })
    );

    const teammateRow = (res.body.party as any[]).find((entry: any) => String(entry?.id ?? "") === "actorC");
    expect(teammateRow).toEqual(
      expect.objectContaining({
        id: "actorC",
        ownerNames: expect.any(String),
        isOwnedByRequester: false,
      })
    );

    expect((res.body.party as any[]).every((entry: any) => entry?.ownerIds === undefined)).toBe(true);
    expect(row.system).toBeUndefined();
    expect(row.items).toBeUndefined();
    expect(row.effects).toBeUndefined();
    expect(row.ownership).toBeUndefined();
  });

  it("dm vendor pack import merges and dedupes existing vendors/items", async () => {
    const dm = await createAndLoginUser(app, "vendor-pack-dm");
    const worldId = `vendor-pack-${uuid().slice(0, 8)}`;
    authStore.linkUserToWorld({
      vaultUserId: dm.userId,
      worldId,
      foundryUserId: "foundry-user-vendor-pack-dm",
      role: "dm",
    });

    const unique = uuid().slice(0, 6);
    const createRes = await dm.agent.post(`/worlds/${worldId}/vendors`).send({
      name: `Arcane Outfitter ${unique}`,
      description: "Test export vendor",
      gold: 250,
      greetings: ["Welcome, traveler."],
    });
    expect(createRes.status).toBe(200);
    const vendorId = createRes.body?.vendor?.id;
    expect(typeof vendorId).toBe("string");

    const addItemRes = await dm.agent.post(`/worlds/${worldId}/vendors/${vendorId}/items`).send({
      name: "Potion of Testing",
      priceGold: 35,
      quantity: 7,
      maxQuantity: 10,
      restockAmount: 1,
      restockIntervalSeconds: 3600,
    });
    expect(addItemRes.status).toBe(200);

    const exportRes = await dm.agent.get(`/worlds/${worldId}/vendor-packs/export?vendorId=${encodeURIComponent(vendorId)}`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.body?.pack?.format).toBe("vaulthero.vendorPack");
    expect(Array.isArray(exportRes.body?.pack?.data?.vendors)).toBe(true);
    expect(exportRes.body.pack.data.vendors).toHaveLength(1);
    expect(exportRes.body.pack.data.vendors[0]?.items?.length).toBe(1);

    const modifiedPack = JSON.parse(JSON.stringify(exportRes.body.pack));
    modifiedPack.data.vendors[0].description = "Merged description";
    modifiedPack.data.vendors[0].items[0].priceGold = 99;

    const importRes = await dm.agent.post(`/worlds/${worldId}/vendor-packs/import`).send({
      pack: modifiedPack,
    });
    expect(importRes.status).toBe(200);
    expect(importRes.body?.imported).toEqual(
      expect.objectContaining({
        vendors: 0,
        items: 0,
        mergedVendors: 1,
        mergedItems: 1,
      })
    );

    const listRes = await dm.agent.get(`/worlds/${worldId}/vendors`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body?.vendors)).toBe(true);
    expect((listRes.body.vendors as any[]).length).toBe(1);

    const detailRes = await dm.agent.get(`/worlds/${worldId}/vendors/${vendorId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body?.vendor?.description).toBe("Merged description");
    expect(Array.isArray(detailRes.body?.vendor?.items)).toBe(true);
    expect(detailRes.body.vendor.items).toHaveLength(1);
    expect(detailRes.body.vendor.items[0]?.priceGold).toBe(99);
  });

  it("vendor pack export with vendorId returns only requested vendor", async () => {
    const dm = await createAndLoginUser(app, "vendor-export-scope");
    const worldId = `vendor-scope-${uuid().slice(0, 8)}`;
    authStore.linkUserToWorld({
      vaultUserId: dm.userId,
      worldId,
      foundryUserId: "foundry-user-vendor-scope-dm",
      role: "dm",
    });

    const a = await dm.agent.post(`/worlds/${worldId}/vendors`).send({ name: "Scope A", gold: 10 });
    const b = await dm.agent.post(`/worlds/${worldId}/vendors`).send({ name: "Scope B", gold: 20 });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const targetId = String(a.body?.vendor?.id ?? "");
    const exportRes = await dm.agent.get(`/worlds/${worldId}/vendor-packs/export?vendorId=${encodeURIComponent(targetId)}`);
    expect(exportRes.status).toBe(200);
    expect(Array.isArray(exportRes.body?.pack?.data?.vendors)).toBe(true);
    expect(exportRes.body.pack.data.vendors).toHaveLength(1);
    expect(String(exportRes.body.pack.data.vendors[0]?.externalId ?? "")).toBe(targetId);
  });

  it("vendor pack import returns 400 for invalid payloads", async () => {
    const dm = await createAndLoginUser(app, "vendor-import-invalid");
    const worldId = `vendor-invalid-${uuid().slice(0, 8)}`;
    authStore.linkUserToWorld({
      vaultUserId: dm.userId,
      worldId,
      foundryUserId: "foundry-user-vendor-invalid-dm",
      role: "dm",
    });

    const res = await dm.agent.post(`/worlds/${worldId}/vendor-packs/import`).send({ pack: {} });
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toContain("data.vendors");
  });

  it("vendor import uses externalId precedence over name and foundryId fallbacks", async () => {
    const dm = await createAndLoginUser(app, "vendor-import-precedence");
    const worldId = `vendor-precedence-${uuid().slice(0, 8)}`;
    authStore.linkUserToWorld({
      vaultUserId: dm.userId,
      worldId,
      foundryUserId: "foundry-user-vendor-precedence-dm",
      role: "dm",
    });

    // Vendor A (will be targeted by externalId)
    const va = await dm.agent.post(`/worlds/${worldId}/vendors`).send({
      name: "Vendor A",
      description: "A-before",
      gold: 100,
    });
    // Vendor B (name collision target for fallback)
    const vb = await dm.agent.post(`/worlds/${worldId}/vendors`).send({
      name: "Vendor B",
      description: "B-before",
      gold: 200,
    });
    expect(va.status).toBe(200);
    expect(vb.status).toBe(200);
    const vendorAId = String(va.body?.vendor?.id ?? "");
    const vendorBId = String(vb.body?.vendor?.id ?? "");

    // Create two items in Vendor A.
    const itemA = await dm.agent.post(`/worlds/${worldId}/vendors/${vendorAId}/items`).send({
      name: "Item A",
      foundryItemId: "FA",
      priceGold: 10,
      quantity: 3,
    });
    const itemB = await dm.agent.post(`/worlds/${worldId}/vendors/${vendorAId}/items`).send({
      name: "Item B",
      foundryItemId: "FB",
      priceGold: 20,
      quantity: 4,
    });
    expect(itemA.status).toBe(200);
    expect(itemB.status).toBe(200);
    const itemAId = String(itemA.body?.item?.id ?? "");

    // Import pack should match Vendor A by externalId even though name points to Vendor B,
    // and match Item A by externalId even though foundryItemId points to Item B's foundry id.
    const pack = {
      format: "vaulthero.vendorPack",
      version: 1,
      data: {
        vendors: [
          {
            externalId: vendorAId,
            name: "Vendor B",
            description: "A-after",
            gold: 777,
            isActive: true,
            greetings: [],
            items: [
              {
                externalId: itemAId,
                name: "Item A Updated",
                foundryItemId: "FB",
                priceGold: 99,
                quantity: 8,
                maxQuantity: 8,
                restockIntervalSeconds: 0,
                restockAmount: 1,
                sortOrder: 0,
              },
            ],
          },
        ],
      },
    };

    const importRes = await dm.agent.post(`/worlds/${worldId}/vendor-packs/import`).send({ pack });
    expect(importRes.status).toBe(200);
    expect(importRes.body?.imported).toEqual(
      expect.objectContaining({
        vendors: 0,
        items: 0,
        mergedVendors: 1,
        mergedItems: 1,
      })
    );

    const list = await dm.agent.get(`/worlds/${worldId}/vendors`);
    expect(list.status).toBe(200);
    const vendorsList = Array.isArray(list.body?.vendors) ? list.body.vendors : [];
    expect(vendorsList).toHaveLength(2);

    const vendorA = vendorsList.find((v: any) => String(v?.id ?? "") === vendorAId);
    const vendorB = vendorsList.find((v: any) => String(v?.id ?? "") === vendorBId);
    expect(vendorA?.description).toBe("A-after");
    expect(Number(vendorA?.gold ?? 0)).toBe(777);
    expect(vendorB?.description).toBe("B-before");
    expect(Number(vendorB?.gold ?? 0)).toBe(200);

    const detail = await dm.agent.get(`/worlds/${worldId}/vendors/${vendorAId}`);
    expect(detail.status).toBe(200);
    const items = Array.isArray(detail.body?.vendor?.items) ? detail.body.vendor.items : [];
    expect(items).toHaveLength(2);
    const updatedItem = items.find((i: any) => String(i?.id ?? "") === itemAId);
    const untouchedItemB = items.find((i: any) => String(i?.name ?? "") === "Item B");
    expect(updatedItem?.name).toBe("Item A Updated");
    expect(Number(updatedItem?.priceGold ?? 0)).toBe(99);
    expect(Number(untouchedItemB?.priceGold ?? 0)).toBe(20);
  });
});
