import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const PackageJsonSchema = z.object({
  name: z.string(),
  main: z.string(),
  types: z.string(),
  exports: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())])),
  files: z.array(z.string()),
});

describe("package contract", () => {
  it("exports the public flamecast package surface", async () => {
    const packageJsonPath = new URL("../../package.json", import.meta.url);
    const packageJson = PackageJsonSchema.parse(
      JSON.parse(await readFile(packageJsonPath, "utf8")),
    );

    expect(packageJson.name).toBe("@flamecast/sdk");
    expect(packageJson.files).toEqual(["dist"]);

    // Core entrypoint
    expect(packageJson.exports["."]).toEqual({
      types: "./src/index.ts",
      import: "./src/index.ts",
    });

    // ACP client
    expect(packageJson.exports["./acp"]).toEqual({
      types: "./src/acp/client.ts",
      import: "./src/acp/client.ts",
    });

    // Restate services
    expect(packageJson.exports["./restate"]).toEqual({
      types: "./src/restate/index.ts",
      import: "./src/restate/index.ts",
    });

    // Removed sub-paths should not exist
    expect(packageJson.exports["./client"]).toBeUndefined();
    expect(packageJson.exports["./edge"]).toBeUndefined();
    expect(packageJson.exports["./api"]).toBeUndefined();

    const entry = await import("../../src/index.js");
    expect(entry.AcpSession).toBeDefined();
    expect(entry.AcpAgents).toBeDefined();
    expect(entry.createAcpCtxClient).toBeTypeOf("function");
  });
});
