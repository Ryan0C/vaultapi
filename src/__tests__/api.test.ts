// @ts-nocheck
import request from "supertest";
import { describe, it, expect } from "vitest";
import { createApp } from "../app.js";
import { VaultStore } from "../services/vaultStore.js";
import path from "node:path";
import session, { type SessionOptions } from "express-session";

// If you have a Logger type exported, import it and type this properly.
// import type { Logger } from "../services/logger.js";

const fixtureRoot = path.resolve("test-fixtures/vault");

// ✅ keep the test API key consistent everywhere
const TEST_API_KEY = "dev-key";

// ✅ minimal logger for tests (no noisy output)
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
  // } satisfies Logger;
};

// ✅ minimal session config for tests (MemoryStore)
const sessionConfig: SessionOptions = {
  store: new session.MemoryStore(),
  secret: "test-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false
  }
};

// ✅ minimal authStore stub (only needed if createApp wires auth/invites routes unconditionally)
// If your auth routes call methods on this in tests, expand this stub accordingly.
const authStore = {
  // bootstrapAdminIfEmpty: async () => {},
  // login: async () => ({ ok: false, error: "not implemented in tests" }),
} as any;

const app = createApp({
  vault: new VaultStore(fixtureRoot),
  vaultRoot: fixtureRoot,
  apiKey: TEST_API_KEY,
  allowUnauthedPaths: ["/health"],
  authStore,
  sessionConfig,
  logger
});

function auth(r: request.Test) {
  return r.set("Authorization", `Bearer ${TEST_API_KEY}`);
}

function authWithKey(r: request.Test, apiKey: string) {
  return r.set("Authorization", `Bearer ${apiKey}`);
}

function expectJson(res: request.Response) {
  expect(res.headers["content-type"]).toMatch(/application\/json/i);
}

/** Small helper to pick a usable fixture world id */
async function pickWorldId(): Promise<string> {
  const worldsRes = await auth(request(app).get("/worlds"));
  expect(worldsRes.status).toBe(200);
  expectJson(worldsRes);

  const worlds: Array<{ id: string; meta?: any | null }> = worldsRes.body.worlds ?? [];
  expect(Array.isArray(worlds)).toBe(true);
  expect(worlds.length).toBeGreaterThan(0);

  return worlds.find((w) => w.meta != null)?.id ?? worlds[0]!.id;
}

describe("vault-api", () => {
  /* -------------------------------------------- */
  /*  Shape assertions                            */
  /* -------------------------------------------- */

  it("GET /health works without auth (shape)", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expectJson(res);

    // shape checks (stable contract)
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        service: "vault-api",
        vaultRoot: expect.any(String),
        vaultRootAccessible: expect.any(Boolean),
        worldCount: expect.any(Number),
        worlds: expect.any(Array)
      })
    );
  });

  it("GET /worlds requires auth", async () => {
    const res = await request(app).get("/worlds");
    expect([401, 403]).toContain(res.status);
    expectJson(res);
  });

  it("GET /worlds blocks wrong API key", async () => {
    const res = await authWithKey(request(app).get("/worlds"), "wrong-key");
    expect([401, 403]).toContain(res.status);
    expectJson(res);
  });

  it("GET /worlds returns worlds array (shape)", async () => {
    const res = await auth(request(app).get("/worlds"));
    expect(res.status).toBe(200);
    expectJson(res);

    expect(res.body).toEqual(
      expect.objectContaining({
        worlds: expect.any(Array)
      })
    );

    // each world should have id + meta (null or object)
    for (const w of res.body.worlds as any[]) {
      expect(w).toEqual(
        expect.objectContaining({
          id: expect.any(String)
        })
      );
      // meta can be null or object (depending on fixture completeness)
      expect(w.meta === null || typeof w.meta === "object").toBe(true);
    }
  });

  it("World meta / actors / chat routes behave (shape)", async () => {
    const worldId = await pickWorldId();

    // meta
    const metaRes = await auth(request(app).get(`/worlds/${worldId}/meta`));
    expect(metaRes.status).toBe(200);
    expectJson(metaRes);

    // shape: world is required; others may be null depending on fixtures
    expect(metaRes.body).toEqual(
      expect.objectContaining({
        world: expect.any(Object),
        users: expect.anything(),  // null or object
        status: expect.anything(), // null or object
        vault: expect.anything()   // null or object
      })
    );

    // actors list
    const actorsRes = await auth(request(app).get(`/worlds/${worldId}/actors`));
    expect(actorsRes.status).toBe(200);
    expectJson(actorsRes);

    expect(actorsRes.body).toEqual(
      expect.objectContaining({
        actors: expect.any(Array)
      })
    );

    const actorId = actorsRes.body.actors?.[0]?.id ?? null;
    if (actorId) {
      const actorRes = await auth(request(app).get(`/worlds/${worldId}/actors/${actorId}`));
      expect(actorRes.status).toBe(200);
      expectJson(actorRes);
      expect(actorRes.body).toEqual(
        expect.objectContaining({
          ok: true,
          actor: expect.any(Object)
        })
      );
    }

    // chat days
    const daysRes = await auth(request(app).get(`/worlds/${worldId}/chat/days`));
    expect(daysRes.status).toBe(200);
    expectJson(daysRes);
    expect(daysRes.body).toEqual(
      expect.objectContaining({
        ok: true,
        days: expect.any(Array)
      })
    );

    const day = daysRes.body.days?.[0] ?? null;
    if (!day) return;

    // chat hours
    const hoursRes = await auth(request(app).get(`/worlds/${worldId}/chat/days/${day}/hours`));
    expect(hoursRes.status).toBe(200);
    expectJson(hoursRes);
    expect(hoursRes.body).toEqual(
      expect.objectContaining({
        ok: true,
        day: expect.any(String),
        hours: expect.any(Array)
      })
    );

    const hour = hoursRes.body.hours?.[0] ?? null;
    if (!hour) return;

    // shard manifest (200 or 404 is fine)
    const manifestRes = await auth(request(app).get(`/worlds/${worldId}/chat/manifests/${day}/${hour}`));
    expectJson(manifestRes);
    expect([200, 404]).toContain(manifestRes.status);

    // events list
    const eventsRes = await auth(
      request(app).get(`/worlds/${worldId}/chat/events/${day}/${hour}?afterTs=0&limit=50`)
    );
    expect(eventsRes.status).toBe(200);
    expectJson(eventsRes);

    expect(eventsRes.body).toEqual(
      expect.objectContaining({
        ok: true,
        day: expect.any(String),
        hour: expect.any(String),
        count: expect.any(Number),
        nextAfterTs: expect.any(Number),
        events: expect.any(Array)
      })
    );

    const evt = eventsRes.body.events?.[0];
    if (!evt) return;

    // single event
    const file = `${evt.ts}-${evt.op}-${evt.id}.json`;
    const oneRes = await auth(request(app).get(`/worlds/${worldId}/chat/events/${day}/${hour}/${file}`));
    expect(oneRes.status).toBe(200);
    expectJson(oneRes);
    expect(oneRes.body).toEqual(
      expect.objectContaining({
        ok: true,
        event: expect.any(Object)
      })
    );
  });

  /* -------------------------------------------- */
  /*  Negative-path tests (404/400)               */
  /* -------------------------------------------- */

  it("GET /worlds/:worldId/meta returns 404 for unknown world", async () => {
    const res = await auth(request(app).get("/worlds/__does_not_exist__/meta"));
    expectJson(res);
    expect(res.status).toBe(404);
  });

  it("GET /worlds/:worldId/actors/:actorId returns 404 for unknown actor", async () => {
    const worldId = await pickWorldId();
    const res = await auth(request(app).get(`/worlds/${worldId}/actors/__does_not_exist__`));
    expectJson(res);
    expect(res.status).toBe(404);
  });

  it("GET /worlds/:worldId/chat/events/:day/:hour/:file returns 400 for invalid filename", async () => {
    const worldId = await pickWorldId();

    // Use a real day/hour if available; otherwise skip by using placeholders that still hit 400 on filename.
    // The route validates the filename before reading.
    const res = await auth(
      request(app).get(`/worlds/${worldId}/chat/events/2026-02-11/22/not-json.txt`)
    );
    expectJson(res);
    expect(res.status).toBe(400);
  });
});