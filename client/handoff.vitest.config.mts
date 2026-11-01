import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: "../migration/.local/legacy-vitest-cache",
  test: {
    environment: "node",
    include: ["src/crypto/deviceHandoff.test.ts"],
    testTimeout: 15000,
  },
});
