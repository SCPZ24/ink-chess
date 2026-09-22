import { defineConfig } from "vitest/config";
export default defineConfig({
  build: { outDir: "dist/web", emptyOutDir: true },
  server: { host: "127.0.0.1" },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 15000 },
});
