import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function openDatabase(home = process.env.LABCANVAS_HOME || path.join(os.homedir(), '.labcanvas')) {
  home = path.resolve(home);
  for (const name of ['', 'objects', 'previews', 'tmp']) mkdirSync(path.join(home, name), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(home, 'labcanvas.sqlite'));
  chmodSync(path.join(home, 'labcanvas.sqlite'), 0o600);
  db.exec(`PRAGMA busy_timeout=8000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO meta VALUES ('schema_version', '1');
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#a6bcb0', is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES collections(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS collection_names ON collections(project_id, IFNULL(parent_id, ''), name);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, occurred_at TEXT NOT NULL, command TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('result','supporting')),
      description TEXT NOT NULL DEFAULT '', occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, run_id TEXT REFERENCES runs(id), metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS items_project ON items(project_id, deleted_at, role);
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      number INTEGER NOT NULL, object_key TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
      original_name TEXT NOT NULL, mime TEXT NOT NULL, preview TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(item_id, number)
    );
    CREATE TABLE IF NOT EXISTS memberships (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, PRIMARY KEY(collection_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, primary_item_id TEXT NOT NULL REFERENCES items(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(group_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS group_collections (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      PRIMARY KEY(group_id, collection_id)
    );
    CREATE TABLE IF NOT EXISTS sources (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      source_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      source_version INTEGER NOT NULL, PRIMARY KEY(item_id, source_item_id)
    );
    CREATE TABLE IF NOT EXISTS layouts (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, view_key TEXT NOT NULL,
      target_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL DEFAULT 360,
      PRIMARY KEY(project_id, view_key, target_id)
    );
    CREATE TABLE IF NOT EXISTS viewports (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, view_key TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 60, y REAL NOT NULL DEFAULT 60, zoom REAL NOT NULL DEFAULT 1,
      PRIMARY KEY(project_id, view_key)
    );
    CREATE TABLE IF NOT EXISTS imports (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, import_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, import_key)
    );
  `);
  const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  if (version !== '1') { db.close(); throw new Error(`不支持的资料库版本：${version}`); }
  return { db, home };
}
