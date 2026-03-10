// @ts-nocheck
// src/server.ts
import session from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { VaultStore } from "./services/vaultStore.js";
import fs from "node:fs";
import path from "node:path";
import { migrate } from "./services/db.js";
import { createLogger } from "./services/logger.js";
import { authStore } from "./stores/authStore.js";
import { WorldStore } from "./stores/worldStore.js";
import { ActorsStore } from "./stores/actorsStore.js";
import { ItemsPacksStore } from "./stores/itemsPacksStore.js";
import { ImportsStore } from "./stores/importStore.js";
const logger = createLogger(process.env.LOG_LEVEL ?? "info");
// 1) DB migrations
migrate();
// 2) Bootstrap admin if needed
authStore.bootstrapAdminIfEmpty(process.env.BOOTSTRAP_ADMIN_USERNAME ??
    process.env.BOOTSTRAP_ADMIN_EMAIL ??
    "admin");
const sessionDir = process.env.SESSION_DB_DIR ??
    path.resolve(process.cwd(), "data");
// Ensure directory exists
fs.mkdirSync(sessionDir, { recursive: true });
const SQLiteStore = SQLiteStoreFactory(session);
const isProd = process.env.NODE_ENV === "production";
logger.info("session store configured", {
    sessionDir,
    sessionDb: process.env.SESSION_DB_NAME ?? "vaultapi-sessions.sqlite"
});
const sessionConfig = {
    store: new SQLiteStore({
        db: process.env.SESSION_DB_NAME ?? "vaultapi-sessions.sqlite",
        dir: sessionDir
    }),
    name: "vaultapi.sid", // don’t use default "connect.sid"
    secret: process.env.SESSION_SECRET ?? "dev-session-secret",
    resave: false,
    saveUninitialized: false,
    rolling: true, // refresh expiration on activity
    cookie: {
        httpOnly: true, // JS cannot access cookie
        secure: isProd, // HTTPS only in production
        sameSite: isProd ? "lax" : "lax",
        maxAge: 1000 * 60 * 60 * 8, // 8 hours
        path: "/"
    }
};
// Real vault root for the running server
const vaultRoot = config.vaultRoot;
logger.info("foundry root", { foundryDataRoot: config.foundryDataRoot });
const vault = new VaultStore(vaultRoot);
const itemsPacksStore = new ItemsPacksStore({
    foundryDataRoot: config.foundryDataRoot
});
const importsStore = new ImportsStore({
    dataRoot: config.vaultRoot
});
const worldStore = new WorldStore(config.foundryDataRoot);
const actorsStore = new ActorsStore({
    dataRoot: config.foundryDataRoot, // <-- this should be .../Data
    vaultDirName: "vault",
    allowLegacyWorldRoot: true,
});
const app = createApp({
    vault,
    vaultRoot,
    apiKey: config.apiKey,
    authStore,
    worldStore,
    actorsStore,
    itemsPacksStore,
    importsStore,
    allowUnauthedPaths: [
        "/health",
        "/auth/login",
        "/auth/reset-password",
        "/invites/redeem",
        "/redeem-invite",
        "/auth/me",
        "/me",
        "/me/worlds",
    ],
    sessionConfig,
    logger,
    corsOrigins: config.corsOrigins,
    corsAllowCredentials: true,
    foundryDataRoot: config.foundryDataRoot,
    foundryPublicRoot: config.foundryPublicRoot,
});
app.listen(config.port, () => {
    logger.info("vault-api starting", {
        port: config.port,
        vaultRoot: config.vaultRoot
    });
});
// Background inbox cleanup — delete processed/failed inbox files that VaultSync
// cannot remove itself (Foundry modules lack delete privileges).
// Runs immediately on startup then every 30 seconds.
async function runInboxCleanup() {
    try {
        await importsStore.cleanupAllWorlds();
    }
    catch (err) {
        logger.warn("inbox cleanup error", { error: err instanceof Error ? err.message : String(err) });
    }
}
void runInboxCleanup();
setInterval(runInboxCleanup, 30_000);
process.on("SIGINT", () => {
    logger.info("shutdown: SIGINT");
    process.exit(0);
});
process.on("SIGTERM", () => {
    logger.info("shutdown: SIGTERM");
    process.exit(0);
});
//# sourceMappingURL=server.js.map