import { describe, expect, it } from "vitest";
import { validateSecurityCriticalEnv } from "../config.js";

describe("validateSecurityCriticalEnv", () => {
  it("allows dev/test environments to use local defaults", () => {
    expect(() =>
      validateSecurityCriticalEnv({
        NODE_ENV: "test",
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it("fails closed in production when required secrets are missing or weak", () => {
    expect(() =>
      validateSecurityCriticalEnv({
        NODE_ENV: "production",
        VAULT_API_KEY: "dev-key",
        SESSION_SECRET: "dev-session-secret",
        BOOTSTRAP_ADMIN_PASSWORD: "change_me",
      } as NodeJS.ProcessEnv)
    ).toThrowError(/security config validation failed/i);
  });

  it("accepts production config when required secrets are explicitly set", () => {
    expect(() =>
      validateSecurityCriticalEnv({
        NODE_ENV: "production",
        VAULT_API_KEY: "vault-prod-api-key",
        SESSION_SECRET: "vault-prod-session-secret",
        BOOTSTRAP_ADMIN_PASSWORD: "vault-prod-bootstrap-password",
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });
});
