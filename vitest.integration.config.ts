import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    include: ["src/**/__tests__/integration/**/*.test.ts", "src/**/__tests__/integration/**/*.spec.ts"],
    exclude: ["dist/**", "node_modules/**"],
    passWithNoTests: true,
  }
});
