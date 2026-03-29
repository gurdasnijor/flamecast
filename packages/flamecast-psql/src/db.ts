import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePgLite } from "drizzle-orm/pglite";
import { migrate as migratePgLite } from "drizzle-orm/pglite/migrator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";
import { PSQL_MIGRATIONS_FOLDER } from "./migrations-path.js";
import * as schema from "./schema.js";

const MIGRATION_LOCK_ID = 1_883_626_139;
const DRIZZLE_MIGRATIONS_TABLE = "drizzle.__drizzle_migrations";

type JournalEntry = {
  tag: string;
  when: number;
};

type Journal = {
  entries: JournalEntry[];
};

type AppliedMigrationRow = {
  hash: string;
  created_at: number;
};

type MigrationTableLookupRow = {
  table_name: string | null;
};

export type PsqlConnectionOptions = {
  url?: string;
  dataDir?: string;
};

export type ResolvedPsqlConnection =
  | {
      driver: "postgres";
      url: string;
    }
  | {
      driver: "pglite";
      dataDir: string;
    };

export type MigrationRecord = {
  tag: string;
  hash: string;
  createdAt: number;
};

export type MigrationStatus = {
  applied: MigrationRecord[];
  pending: MigrationRecord[];
  current: MigrationRecord | null;
  latest: MigrationRecord | null;
  isUpToDate: boolean;
};

type NodePsqlDb = NodePgDatabase<typeof schema>;
type PglitePsqlDb = PgliteDatabase<typeof schema>;

export type DatabaseBundle =
  | {
      driver: "postgres";
      url: string;
      db: NodePsqlDb;
      client: Pool;
      close: () => Promise<void>;
    }
  | {
      driver: "pglite";
      dataDir: string;
      db: PglitePsqlDb;
      client: PGlite;
      close: () => Promise<void>;
    };

function toPgliteStartupError(dataDir: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Aborted()")) {
    return new Error(
      `Failed to open the local PGlite database at "${dataDir}". ` +
        "This usually means another Flamecast process is already using that directory, " +
        "or it was left locked after a crash. Stop the other dev server, or set " +
        "FLAMECAST_PGLITE_DIR to a different path before starting Flamecast again.",
    );
  }

  return error instanceof Error ? error : new Error(message);
}

async function readMigrationMetadata(): Promise<MigrationRecord[]> {
  const migrations = readMigrationFiles({ migrationsFolder: PSQL_MIGRATIONS_FOLDER });
  const journalPath = path.join(PSQL_MIGRATIONS_FOLDER, "meta", "_journal.json");
  const journal: Journal = JSON.parse(await readFile(journalPath, "utf8"));

  if (journal.entries.length !== migrations.length) {
    throw new Error("Drizzle migration journal is out of sync with migration SQL files");
  }

  return journal.entries.map((entry, index) => ({
    tag: entry.tag,
    hash: migrations[index].hash,
    createdAt: entry.when,
  }));
}

async function queryRows<TRow extends Record<string, unknown>>(
  bundle: DatabaseBundle,
  query: string,
): Promise<TRow[]> {
  if (bundle.driver === "postgres") {
    const result = await bundle.client.query<TRow>(query);
    return result.rows;
  }

  const result: { rows: TRow[] } = await bundle.client.query(query);
  return result.rows;
}

async function listAppliedMigrationRows(bundle: DatabaseBundle): Promise<AppliedMigrationRow[]> {
  const lookupRows = await queryRows<MigrationTableLookupRow>(
    bundle,
    `select to_regclass('${DRIZZLE_MIGRATIONS_TABLE}') as table_name`,
  );

  if (lookupRows[0]?.table_name === null) {
    return [];
  }

  return queryRows<AppliedMigrationRow>(
    bundle,
    `select hash, created_at from ${DRIZZLE_MIGRATIONS_TABLE} order by id asc`,
  );
}

async function withPostgresMigrationLock<T>(
  bundle: Extract<DatabaseBundle, { driver: "postgres" }>,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await bundle.client.connect();

  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

export function resolvePsqlConnection(options: PsqlConnectionOptions = {}): ResolvedPsqlConnection {
  if (options.url) {
    return {
      driver: "postgres",
      url: options.url,
    };
  }

  return {
    driver: "pglite",
    dataDir: path.resolve(
      options.dataDir ??
        process.env.FLAMECAST_PGLITE_DIR ??
        path.join(process.cwd(), ".flamecast", "pglite"),
    ),
  };
}

/** Open a **Postgres** or **PGLite** database bundle without applying migrations. */
export async function createDatabase(options: PsqlConnectionOptions = {}): Promise<DatabaseBundle> {
  const connection = resolvePsqlConnection(options);

  if (connection.driver === "postgres") {
    const client = new Pool({ connectionString: connection.url });
    const db = drizzleNodePg({ client, schema });
    return {
      driver: "postgres",
      url: connection.url,
      client,
      db,
      close: async () => {
        await client.end();
      },
    };
  }

  await mkdir(connection.dataDir, { recursive: true });

  let client: Awaited<ReturnType<typeof PGlite.create>>;
  try {
    client = await PGlite.create(connection.dataDir);
  } catch (error) {
    throw toPgliteStartupError(connection.dataDir, error);
  }

  const db = drizzlePgLite({ client, schema });
  return {
    driver: "pglite",
    dataDir: connection.dataDir,
    client,
    db,
    close: async () => {
      await client.close();
    },
  };
}

export async function getMigrationStatus(bundle: DatabaseBundle): Promise<MigrationStatus> {
  const [records, appliedRows] = await Promise.all([
    readMigrationMetadata(),
    listAppliedMigrationRows(bundle),
  ]);
  const appliedHashes = new Set(appliedRows.map((row) => row.hash));
  const applied = records.filter((record) => appliedHashes.has(record.hash));
  const pending = records.filter((record) => !appliedHashes.has(record.hash));

  return {
    applied,
    pending,
    current: applied[applied.length - 1] ?? null,
    latest: records[records.length - 1] ?? null,
    isUpToDate: pending.length === 0,
  };
}

export function getMigrationStatusMessage(status: MigrationStatus): string {
  if (status.isUpToDate) {
    return status.current
      ? `Database schema is up to date at ${status.current.tag}.`
      : "Database schema has no pending migrations.";
  }

  const pendingTags = status.pending.map((record) => record.tag).join(", ");
  return (
    `Database schema is behind (${pendingTags}). ` +
    'Run "flamecast db migrate" before starting Flamecast.'
  );
}

export async function assertDatabaseReady(bundle: DatabaseBundle): Promise<MigrationStatus> {
  const status = await getMigrationStatus(bundle);
  if (!status.isUpToDate) {
    throw new Error(getMigrationStatusMessage(status));
  }

  return status;
}

export async function migrateDatabase(
  bundle: DatabaseBundle,
): Promise<{ applied: MigrationRecord[]; status: MigrationStatus }> {
  const before = await getMigrationStatus(bundle);
  if (before.pending.length === 0) {
    return { applied: [], status: before };
  }

  const migrationsFolder = PSQL_MIGRATIONS_FOLDER;

  if (bundle.driver === "postgres") {
    await withPostgresMigrationLock(bundle, async () => {
      await migrateNodePg(bundle.db, { migrationsFolder });
    });
  } else {
    await migratePgLite(bundle.db, { migrationsFolder });
  }

  const status = await getMigrationStatus(bundle);
  const appliedHashes = new Set(status.applied.map((record) => record.hash));
  const applied = before.pending.filter((record) => appliedHashes.has(record.hash));

  return { applied, status };
}
