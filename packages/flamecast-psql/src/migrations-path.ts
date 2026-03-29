import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PSQL_RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveRuntimeSibling(basename: string): string {
  const jsPath = path.join(PSQL_RUNTIME_DIR, `${basename}.js`);
  if (existsSync(jsPath)) {
    return jsPath;
  }

  return path.join(PSQL_RUNTIME_DIR, `${basename}.ts`);
}

/** Absolute path to Drizzle migration files for the PSQL state manager. */
export const PSQL_MIGRATIONS_FOLDER = path.join(PSQL_RUNTIME_DIR, "migrations");

/** Absolute path to the Drizzle schema module for studio/config generation. */
export const PSQL_SCHEMA_FILE = resolveRuntimeSibling("schema");
