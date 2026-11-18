import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Matches the "@/*" path in tsconfig.json. fileURLToPath, not URL.pathname,
    // because the project path has spaces, which pathname would encode as %20.
    alias: { "@/": fileURLToPath(new URL("./src/", import.meta.url)) },
  },
});
