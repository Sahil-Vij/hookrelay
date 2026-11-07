import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    // Same origin in development, so the API key never has to cross a CORS boundary.
    proxy: { "/api": "http://localhost:4000" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
  },
});
