// src/config.ts
import path from "node:path";
import "dotenv/config";

export type Config = {
  vaultRoot: string;
  port: number;
  apiKey: string;
  vaultDBPath: string;

  corsOrigins: string[];
  foundryDataRoot: string | null;
  foundryPublicRoot: string | null;
};

function isDevLikeEnv(envName: string | undefined): boolean {
  const normalized = String(envName ?? "").trim().toLowerCase();
  return !normalized || normalized === "development" || normalized === "dev" || normalized === "test";
}

export function validateSecurityCriticalEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (isDevLikeEnv(env.NODE_ENV)) return;

  const issues: string[] = [];
  const apiKey = String(env.VAULT_API_KEY ?? "").trim();
  const sessionSecret = String(env.SESSION_SECRET ?? "").trim();
  const bootstrapPassword = String(env.BOOTSTRAP_ADMIN_PASSWORD ?? "").trim();

  if (!apiKey) issues.push("VAULT_API_KEY is required in non-dev environments.");
  else if (apiKey === "dev-key") issues.push("VAULT_API_KEY must not use insecure default value 'dev-key'.");

  if (!sessionSecret) issues.push("SESSION_SECRET is required in non-dev environments.");
  else if (sessionSecret === "dev-session-secret") {
    issues.push("SESSION_SECRET must not use insecure default value 'dev-session-secret'.");
  }

  if (!bootstrapPassword) issues.push("BOOTSTRAP_ADMIN_PASSWORD is required in non-dev environments.");
  else if (bootstrapPassword === "change_me") {
    issues.push("BOOTSTRAP_ADMIN_PASSWORD must not use insecure default value 'change_me'.");
  }

  if (issues.length) {
    throw new Error(`VaultAPI security config validation failed:\n- ${issues.join("\n- ")}`);
  }
}

function resolveVaultRoot(): string {
  const raw =
    process.env.VAULT_ROOT ??
    path.resolve(process.cwd(), "vault");

  return path.resolve(raw);
}

function resolvePort(): number {
  const raw = process.env.PORT;
  const port = raw ? Number(raw) : 4000;

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${raw}`);
  }

  return port;
}

function resolveApiKey(): string {
  return process.env.VAULT_API_KEY ?? "dev-key";
}

function resolveVaultDBPath(): string {
  const raw =
    process.env.VAULT_DB_PATH ??
    path.resolve(process.cwd(), "data/vaultapi.sqlite"); // default file

  return path.resolve(raw);
}

function resolveCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS;
  if (!raw) return [];

  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function resolveFoundryDataRoot(): string | null {
  const raw = process.env.FOUNDRY_DATA_ROOT;
  return raw ? path.resolve(raw) : null;
}

function resolveFoundryPublicRoot(): string | null {
  const raw = process.env.FOUNDRY_PUBLIC_ROOT;
  return raw ? path.resolve(raw) : null;
}

/**
 * Resolved configuration (singleton-style).
 * Safe to import anywhere.
 */
export const config: Config = {
  vaultRoot: resolveVaultRoot(),
  port: resolvePort(),
  apiKey: resolveApiKey(),
  vaultDBPath: resolveVaultDBPath(),
  corsOrigins: resolveCorsOrigins(),
  foundryDataRoot: resolveFoundryDataRoot(),
  foundryPublicRoot: resolveFoundryPublicRoot() 
};
