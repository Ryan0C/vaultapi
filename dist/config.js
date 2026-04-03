// src/config.ts
import path from "node:path";
import "dotenv/config";
function isDevLikeEnv(envName) {
    const normalized = String(envName ?? "").trim().toLowerCase();
    return !normalized || normalized === "development" || normalized === "dev" || normalized === "test";
}
export function validateSecurityCriticalEnv(env = process.env) {
    if (isDevLikeEnv(env.NODE_ENV))
        return;
    const issues = [];
    const apiKey = String(env.VAULT_API_KEY ?? "").trim();
    const sessionSecret = String(env.SESSION_SECRET ?? "").trim();
    const bootstrapPassword = String(env.BOOTSTRAP_ADMIN_PASSWORD ?? "").trim();
    if (!apiKey)
        issues.push("VAULT_API_KEY is required in non-dev environments.");
    else if (apiKey === "dev-key")
        issues.push("VAULT_API_KEY must not use insecure default value 'dev-key'.");
    if (!sessionSecret)
        issues.push("SESSION_SECRET is required in non-dev environments.");
    else if (sessionSecret === "dev-session-secret") {
        issues.push("SESSION_SECRET must not use insecure default value 'dev-session-secret'.");
    }
    if (!bootstrapPassword)
        issues.push("BOOTSTRAP_ADMIN_PASSWORD is required in non-dev environments.");
    else if (bootstrapPassword === "change_me") {
        issues.push("BOOTSTRAP_ADMIN_PASSWORD must not use insecure default value 'change_me'.");
    }
    if (issues.length) {
        throw new Error(`VaultAPI security config validation failed:\n- ${issues.join("\n- ")}`);
    }
}
function resolveVaultRoot() {
    const raw = process.env.VAULT_ROOT ??
        path.resolve(process.cwd(), "vault");
    return path.resolve(raw);
}
function resolvePort() {
    const raw = process.env.PORT;
    const port = raw ? Number(raw) : 4000;
    if (Number.isNaN(port) || port <= 0) {
        throw new Error(`Invalid PORT value: ${raw}`);
    }
    return port;
}
function resolveApiKey() {
    return process.env.VAULT_API_KEY ?? "dev-key";
}
function resolveVaultDBPath() {
    const raw = process.env.VAULT_DB_PATH ??
        path.resolve(process.cwd(), "data/vaultapi.sqlite"); // default file
    return path.resolve(raw);
}
function resolveCorsOrigins() {
    const raw = process.env.CORS_ORIGINS;
    if (!raw)
        return [];
    return raw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
}
function resolveFoundryDataRoot() {
    const raw = process.env.FOUNDRY_DATA_ROOT;
    return raw ? path.resolve(raw) : null;
}
function resolveFoundryPublicRoot() {
    const raw = process.env.FOUNDRY_PUBLIC_ROOT;
    return raw ? path.resolve(raw) : null;
}
/**
 * Resolved configuration (singleton-style).
 * Safe to import anywhere.
 */
export const config = {
    vaultRoot: resolveVaultRoot(),
    port: resolvePort(),
    apiKey: resolveApiKey(),
    vaultDBPath: resolveVaultDBPath(),
    corsOrigins: resolveCorsOrigins(),
    foundryDataRoot: resolveFoundryDataRoot(),
    foundryPublicRoot: resolveFoundryPublicRoot()
};
//# sourceMappingURL=config.js.map