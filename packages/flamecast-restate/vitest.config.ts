import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    server: {
      deps: {
        // acp-sdk's instrumentation.js does `import pkg from '../package.json'`
        // without `with { type: "json" }`. Inlining lets Vite handle JSON imports.
        inline: ["acp-sdk"],
      },
    },
  },
});
