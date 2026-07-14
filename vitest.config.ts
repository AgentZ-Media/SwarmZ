import { defineConfig } from "vitest/config";
import path from "path";

// Dedicated test config — kept separate from the Tauri-tuned vite.config.ts so
// test runs never pick up the dev-server / plugin machinery. The pure Vibe /
// orchestrator modules under test need no DOM, so the default "node"
// environment is enough; only the "@/" alias has to match the app.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
