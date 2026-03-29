import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const poolEnd = vi.fn(async () => {});
  const Pool = vi.fn(function PoolMock({ connectionString }: { connectionString: string }) {
    return {
      connectionString,
      end: poolEnd,
    };
  });
  const drizzleNodePg = vi.fn(() => ({ kind: "pg-db" }));
  const migrateNodePg = vi.fn(async () => {});

  return {
    poolEnd,
    Pool,
    drizzleNodePg,
    migrateNodePg,
  };
});

vi.mock("pg", () => ({ Pool: mocks.Pool }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzleNodePg }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: mocks.migrateNodePg }));

import { createDatabase } from "../src/db.js";
import { migrateDatabase } from "../src/db.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("database client postgres branch", () => {
  test("opens postgres without auto-applying migrations", async () => {
    const bundle = await createDatabase({ url: "postgres://db/flamecast" });

    expect(mocks.Pool).toHaveBeenCalledWith({ connectionString: "postgres://db/flamecast" });
    expect(mocks.drizzleNodePg).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({
          connectionString: "postgres://db/flamecast",
        }),
      }),
    );
    expect(mocks.migrateNodePg).not.toHaveBeenCalled();
    expect(bundle.db).toEqual({ kind: "pg-db" });
    expect(bundle.driver).toBe("postgres");

    await bundle.close();
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
  });

  test("applies migrations on demand", async () => {
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
    const connectClient = {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    };
    const pool = {
      connectionString: "postgres://db/flamecast",
      end: mocks.poolEnd,
      query,
      connect: vi.fn(async () => connectClient),
    };
    mocks.Pool.mockImplementationOnce(function PoolMock() {
      return pool;
    });

    const bundle = await createDatabase({ url: "postgres://db/flamecast" });
    await migrateDatabase(bundle);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(connectClient.query).toHaveBeenNthCalledWith(
      1,
      "select pg_advisory_lock($1)",
      [1883626139],
    );
    expect(mocks.migrateNodePg).toHaveBeenCalledWith(
      { kind: "pg-db" },
      expect.objectContaining({
        migrationsFolder: expect.stringContaining(path.join("src", "migrations")),
      }),
    );
    expect(connectClient.query).toHaveBeenNthCalledWith(
      2,
      "select pg_advisory_unlock($1)",
      [1883626139],
    );
    expect(connectClient.release).toHaveBeenCalledTimes(1);
    await bundle.close();
  });
});
