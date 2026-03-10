// @ts-nocheck
// src/__tests__/auth.test.ts
import request from "supertest";
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { createApp } from "../app.js";
import { VaultStore } from "../services/vaultStore.js";
import { migrate } from "../services/db.js";
import { authStore } from "../services/authStore.js";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { db } from "../services/db.js";
// Simple noop logger for tests
const logger = {
    info: () => { },
    warn: () => { },
    error: () => { }
};
const fixtureRoot = path.resolve("test-fixtures/vault");
const apiKey = "dev-key";
// MemoryStore is fine for tests
const sessionConfig = {
    secret: "test-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: false }
};
function apiKeyAuth(r, key = apiKey) {
    return r.set("Authorization", `Bearer ${key}`);
}
function createVaultUserInDb(args) {
    const id = uuid();
    const t = new Date().toISOString();
    const passwordHash = bcrypt.hashSync(args.password, 12);
    db.prepare(`
    INSERT INTO vault_users (id,username,email,password_hash,must_reset_password,is_superadmin,created_at,updated_at)
    VALUES (@id,@username,@email,@passwordHash,0,0,@t,@t)
  `).run({ id, username: args.username, email: `${args.username}@local`, passwordHash, t });
    return { id };
}
describe("auth + authz (session + api key)", () => {
    let app;
    let agent;
    // We’ll use these across tests
    const adminUsername = process.env.BOOTSTRAP_ADMIN_USERNAME ?? "admin";
    const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "change_me";
    beforeAll(async () => {
        // Ensure DB schema exists
        migrate();
        // Bootstrap admin (expected to exist after this)
        // Prefer returning a temp password from bootstrap for tests.
        const boot = await authStore.bootstrapAdminIfEmpty?.(adminUsername);
        app = createApp({
            vault: new VaultStore(fixtureRoot),
            vaultRoot: fixtureRoot,
            apiKey,
            authStore,
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
            throw new Error(`Login did not succeed (status=${res.status}). If you enforce must_reset_password, update this test to perform reset first. Body=${JSON.stringify(res.body)}`);
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
            throw new Error(`Admin is not a world admin for test-world. Either (1) add a fixture world_admins row in bootstrap, or (2) grant it in beforeAll via authStore. Body=${JSON.stringify(res.body)}`);
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
        const inviteCode = invRes.body.code;
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
        // 4) Before redeem: /auth/me/worlds should be empty (or missing the world)
        const meWorldsBefore = await userAgent.get("/auth/me/worlds");
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
        const meWorldsAfter = await userAgent.get("/auth/me/worlds");
        expect(meWorldsAfter.status).toBe(200);
        expect(meWorldsAfter.body.ok).toBe(true);
        const worlds = meWorldsAfter.body.worlds;
        expect(worlds.some(w => w.worldId === "test-world")).toBe(true);
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
    it("wrong API key is rejected", async () => {
        const res = await apiKeyAuth(request(app).get("/worlds"), "wrong-key");
        expect([401, 403]).toContain(res.status);
    });
});
//# sourceMappingURL=auth.test.js.map