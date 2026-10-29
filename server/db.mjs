/**
 * SQLite persistence for SoloCart, using Node's built-in `node:sqlite`.
 * No Postgres, no Docker: one file under `data/`, WAL mode, foreign keys on.
 *
 * Migrations are plain `.sql` files in `server/migrations/`, applied in
 * filename order and recorded in `schema_migrations`. Each file runs inside
 * a transaction, so a failing migration leaves the database untouched.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = fileURLToPath(new URL('..', import.meta.url));
const migrationsDir = join(rootDir, 'server', 'migrations');

/** Where the database lives. `:memory:` is supported for tests. */
export function dbPath() {
  return process.env.SOLOCART_DB || join(rootDir, 'data', 'solocart.db');
}

let instance = null;

/** The process-wide database handle, opened (and migrated) on first use. */
export function getDb() {
  if (instance) return instance;
  const path = dbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  instance = new DatabaseSync(path);
  instance.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(instance);
  return instance;
}

/** Applies every pending migration file. Exported so tests can open their own handle. */
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name));
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sqlText = readFileSync(join(migrationsDir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sqlText);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${error.message}`);
    }
  }
}

export function closeDb() {
  if (instance) {
    instance.close();
    instance = null;
  }
}
