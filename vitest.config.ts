import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 20_000,
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    exclude: ["dist/**", "node_modules/**", "src/**/__tests__/integration/**"],
  }
});
