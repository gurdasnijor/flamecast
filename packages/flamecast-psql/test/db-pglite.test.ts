import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mkdir = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const createPGlite = vi.fn();
  const drizzlePgLite = vi.fn();
  const migratePgLite = vi.fn(async () => {});

  return {
    mkdir,
    close,
    createPGlite,
    drizzlePgLite,
    migratePgLite,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: mocks.mkdir,
  };
});
vi.mock("@electric-sql/pglite", () => ({
  PGlite: { create: mocks.createPGlite },
}));
vi.mock("drizzle-orm/pglite", () => ({ drizzle: mocks.drizzlePgLite }));
vi.mock("drizzle-orm/pglite/migrator", () => ({ migrate: mocks.migratePgLite }));

import { createDatabase, migrateDatabase } from "../src/db.js";

function resetPgliteMocks() {
  mocks.mkdir.mockReset().mockImplementation(async () => {});
  mocks.close.mockReset().mockImplementation(async () => {});
  mocks.createPGlite.mockReset().mockImplementation(async () => ({ close: mocks.close }));
  mocks.drizzlePgLite.mockReset().mockImplementation(() => ({ kind: "pglite" }));
  mocks.migratePgLite.mockReset().mockImplementation(async () => {});
}

resetPgliteMocks();

afterEach(() => {
  delete process.env.FLAMECAST_PGLITE_DIR;
  resetPgliteMocks();
  vi.restoreAllMocks();
});

describe("database client pglite branch", () => {
  test("falls back to pglite with explicit data dir, FLAMECAST_PGLITE_DIR, and the default cwd path", async () => {
    process.env.FLAMECAST_PGLITE_DIR = "/tmp/flamecast-env-pglite";

    const explicit = await createDatabase({ dataDir: "/tmp/explicit-pglite" });
    const flamecastEnvBundle = await createDatabase({});
    delete process.env.FLAMECAST_PGLITE_DIR;
    const defaultBundle = await createDatabase({});

    expect(mocks.createPGlite).toHaveBeenNthCalledWith(1, path.resolve("/tmp/explicit-pglite"));
    expect(mocks.createPGlite).toHaveBeenNthCalledWith(
      2,
      path.resolve("/tmp/flamecast-env-pglite"),
    );
    expect(mocks.createPGlite).toHaveBeenNthCalledWith(
      3,
      path.resolve(path.join(process.cwd(), ".flamecast", "pglite")),
    );
    expect(mocks.mkdir).toHaveBeenCalledTimes(3);
    expect(mocks.migratePgLite).not.toHaveBeenCalled();
    expect(mocks.drizzlePgLite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        client: expect.any(Object),
      }),
    );
    expect(explicit.db).toEqual({ kind: "pglite" });
    expect(flamecastEnvBundle.db).toEqual({ kind: "pglite" });
    expect(defaultBundle.db).toEqual({ kind: "pglite" });
    expect(explicit.driver).toBe("pglite");

    await explicit.close();
    await flamecastEnvBundle.close();
    await defaultBundle.close();
    expect(mocks.close).toHaveBeenCalledTimes(3);
  });

  test("applies migrations only when requested", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ table_name: "drizzle.__drizzle_migrations" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ table_name: "drizzle.__drizzle_migrations" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            hash: "hash-1",
            created_at: 1774302395391,
          },
          {
            hash: "hash-2",
            created_at: 1774470884025,
          },
          {
            hash: "hash-3",
            created_at: 1774570000000,
          },
          {
            hash: "hash-4",
            created_at: 1774520594695,
          },
          {
            hash: "hash-5",
            created_at: 1774600000000,
          },
          {
            hash: "hash-6",
            created_at: 1774601000000,
          },
          {
            hash: "hash-7",
            created_at: 1774680000000,
          },
          {
            hash: "hash-8",
            created_at: 1774817000000,
          },
        ],
      });
    mocks.createPGlite.mockResolvedValueOnce({
      close: mocks.close,
      query,
    });

    const bundle = await createDatabase({ dataDir: "/tmp/migrate-pglite" });
    await migrateDatabase(bundle);

    expect(mocks.migratePgLite).toHaveBeenCalledWith(
      { kind: "pglite" },
      expect.objectContaining({
        migrationsFolder: expect.stringContaining(path.join("src", "migrations")),
      }),
    );
    await bundle.close();
  });

  test("rewrites locked-directory startup failures to a friendlier message", async () => {
    mocks.createPGlite.mockRejectedValueOnce(new Error("sqlite backend: Aborted()"));
    const startup = createDatabase({ dataDir: "/tmp/locked-pglite" });

    await expect(startup).rejects.toThrow(
      'Failed to open the local PGlite database at "/tmp/locked-pglite".',
    );
    await expect(startup).rejects.toThrow(/FLAMECAST_PGLITE_DIR/);
  });

  test("preserves non-lock startup Error values", async () => {
    const failure = new Error("disk offline");
    mocks.createPGlite.mockRejectedValueOnce(failure);

    await expect(createDatabase({ dataDir: "/tmp/broken-pglite" })).rejects.toBe(failure);
  });

  test("wraps non-Error startup failures", async () => {
    mocks.createPGlite.mockRejectedValueOnce("boom");

    await expect(createDatabase({ dataDir: "/tmp/broken-pglite" })).rejects.toThrow("boom");
  });
});
