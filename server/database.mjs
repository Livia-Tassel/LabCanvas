import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SCHEMA_VERSION = 3;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS collection_names
    ON collections(project_id, IFNULL(parent_id, ''), name);
  -- An entry is the unit that is classified, placed on a canvas and deleted.
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS entries_project ON entries(project_id, deleted_at);
  CREATE UNIQUE INDEX IF NOT EXISTS entry_keys ON entries(project_id, key) WHERE key IS NOT NULL;
  -- An entry owns one or more files; bytes live once in the content-addressed object store.
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    source_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    -- Version of the source file this figure was last known to match.
    source_version INTEGER
  );
  CREATE INDEX IF NOT EXISTS files_entry ON files(entry_id, position);
  CREATE TABLE IF NOT EXISTS file_versions (
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    preview TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (file_id, number)
  );
  CREATE TABLE IF NOT EXISTS memberships (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    PRIMARY KEY (collection_id, entry_id)
  );
  CREATE INDEX IF NOT EXISTS memberships_entry ON memberships(entry_id);
  -- Card positions belong to a view (all entries, or one collection), not to the entry.
  CREATE TABLE IF NOT EXISTS layouts (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    view_key TEXT NOT NULL,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    x REAL NOT NULL,
    y REAL NOT NULL,
    w REAL NOT NULL,
    PRIMARY KEY (project_id, view_key, entry_id)
  );
  CREATE TABLE IF NOT EXISTS viewports (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    view_key TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    zoom REAL NOT NULL,
    PRIMARY KEY (project_id, view_key)
  );
`;

/** Everything added in schema 3. Safe to run on a database that already has it. */
const SCHEMA_V3 = `
  CREATE INDEX IF NOT EXISTS file_versions_sha ON file_versions(sha256);
  CREATE INDEX IF NOT EXISTS files_source ON files(source_file_id) WHERE source_file_id IS NOT NULL;
  -- Free-form properties of an entry, such as experiment parameters.
  CREATE TABLE IF NOT EXISTS entry_fields (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (entry_id, name)
  );
  -- Notes and frames drawn on a canvas. Like card positions, they belong to a view.
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    view_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    w REAL NOT NULL,
    h REAL NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS annotations_view ON annotations(project_id, view_key);
  -- Searchable text extracted from file contents, stored once per distinct content.
  CREATE TABLE IF NOT EXISTS file_text (sha256 TEXT PRIMARY KEY, content TEXT NOT NULL);
  -- One search document per entry; the row id of the document in search_fts is "id".
  CREATE TABLE IF NOT EXISTS search_docs (id INTEGER PRIMARY KEY, entry_id TEXT UNIQUE NOT NULL, project_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS search_docs_project ON search_docs(project_id);
  -- Entries whose search document is out of date. Triggers fill it, so writes made by any process are covered.
  CREATE TABLE IF NOT EXISTS search_dirty (entry_id TEXT PRIMARY KEY);
  CREATE TRIGGER IF NOT EXISTS search_entry_insert AFTER INSERT ON entries BEGIN
    INSERT OR IGNORE INTO search_dirty VALUES (new.id); END;
  CREATE TRIGGER IF NOT EXISTS search_entry_update AFTER UPDATE OF title, note, key, date ON entries BEGIN
    INSERT OR IGNORE INTO search_dirty VALUES (new.id); END;
  CREATE TRIGGER IF NOT EXISTS search_entry_delete AFTER DELETE ON entries BEGIN
    INSERT OR IGNORE INTO search_dirty VALUES (old.id); END;
  CREATE TRIGGER IF NOT EXISTS search_file_insert AFTER INSERT ON files BEGIN
    INSERT OR IGNORE INTO search_dirty VALUES (new.entry_id); END;
  CREATE TRIGGER IF NOT EXISTS search_file_update AFTER UPDATE OF name, entry_id, current_version ON files BEGIN
    INSERT OR IGNORE INTO search_dirty VALUES (new.entry_id);
    INSERT OR IGNORE INTO search_dirty VALUES (old.entry_id); END;
  CREATE TRIGGER IF NOT EXISTS search_file_delete AFTER DELETE ON files BEGIN
    INSERT OR IGNORE INTO search_dirty VALUES (old.entry_id); END;
  CREATE TRIGGER IF NOT EXISTS search_field_insert AFTER INSERT ON entry_fields BEGIN
    INSERT OR IGNORE INTO search_dirty VALUES (new.entry_id); END;
  CREATE TRIGGER IF NOT EXISTS search_field_update AFTER UPDATE ON entry_fields BEGIN
    INSERT OR IGNORE INTO search_dirty VALUES (new.entry_id); END;
  CREATE TRIGGER IF NOT EXISTS search_field_delete AFTER DELETE ON entry_fields BEGIN
    INSERT OR IGNORE INTO search_dirty VALUES (old.entry_id); END;
  CREATE TRIGGER IF NOT EXISTS search_text_insert AFTER INSERT ON file_text BEGIN
    INSERT OR IGNORE INTO search_dirty
      SELECT f.entry_id FROM file_versions v JOIN files f ON f.id = v.file_id AND f.current_version = v.number
      WHERE v.sha256 = new.sha256; END;
`;

/**
 * The full-text index. With the trigram tokenizer, substring matches (including Chinese) use the index;
 * where FTS5 is unavailable an ordinary table answers the same queries by scanning.
 */
function ensureSearch(db) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_fts'").get()) return;
  try {
    db.exec("CREATE VIRTUAL TABLE search_fts USING fts5(text, tokenize='trigram')");
  } catch {
    db.exec('CREATE TABLE IF NOT EXISTS search_fts (text TEXT NOT NULL)');
  }
  db.exec('DELETE FROM search_docs; INSERT OR IGNORE INTO search_dirty SELECT id FROM entries;');
}

function migrateV2(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value !== '2') {
      db.exec('COMMIT');
      return;
    }
    if (!db.prepare('PRAGMA table_info(files)').all().some(column => column.name === 'source_version')) {
      db.exec('ALTER TABLE files ADD COLUMN source_version INTEGER');
    }
    db.exec(SCHEMA_V3);
    // Existing figures are taken to match the current version of their source.
    db.exec(`UPDATE files SET source_version = (SELECT s.current_version FROM files s WHERE s.id = files.source_file_id)
      WHERE source_file_id IS NOT NULL AND source_version IS NULL`);
    // Collections used to be shown by name; keep that order now that they can be arranged by hand.
    const collections = db.prepare('SELECT id, project_id, parent_id, name FROM collections').all();
    const groups = new Map();
    for (const row of collections) {
      const key = `${row.project_id}:${row.parent_id ?? ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const place = db.prepare('UPDATE collections SET position = ? WHERE id = ?');
    for (const rows of groups.values()) {
      rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      rows.forEach((row, index) => place.run(index + 1, row.id));
    }
    db.exec("UPDATE meta SET value='3' WHERE key='schema_version'; COMMIT;");
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const V1_TABLES = [
  'projects', 'collections', 'runs', 'items', 'versions', 'memberships', 'groups',
  'group_members', 'group_collections', 'sources', 'layouts', 'viewports', 'imports'
];

/**
 * v1 kept files ("items") and optional "groups" as separate classifiable things.
 * v2 folds both into entries: a group becomes one entry holding its members,
 * and every ungrouped item becomes a single-file entry.
 */
function migrateV1(db, home) {
  const backup = path.join(home, 'labcanvas.v1-backup.sqlite');
  if (!existsSync(backup)) {
    const temporary = `${backup}.${randomUUID()}`;
    try {
      db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
      chmodSync(temporary, 0o600);
      try {
        linkSync(temporary, backup);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  try {
    if (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value !== '1') {
      db.exec('COMMIT;');
      return;
    }
    for (const table of V1_TABLES) db.exec(`ALTER TABLE ${table} RENAME TO v1_${table}`);
    db.exec('DROP INDEX IF EXISTS collection_names; DROP INDEX IF EXISTS items_project;');
    db.exec(SCHEMA);
    db.exec(`
      INSERT INTO projects SELECT id, slug, name, created_at FROM v1_projects;
      INSERT INTO collections
        SELECT id, project_id, parent_id, name, rowid, created_at FROM v1_collections;

      -- Each live item belongs to at most one entry: its earliest group, or itself.
      CREATE TEMP TABLE item_entry AS
        SELECT i.id AS item_id,
          COALESCE(
            CASE WHEN i.deleted_at IS NULL THEN (
              SELECT g.id FROM v1_group_members m JOIN v1_groups g ON g.id = m.group_id
              WHERE m.item_id = i.id ORDER BY g.created_at, g.id LIMIT 1
            ) END,
            'ent_' || i.id
          ) AS entry_id
        FROM v1_items i;

      INSERT INTO entries (id, project_id, title, note, date, created_at, updated_at, deleted_at)
        SELECT g.id, g.project_id, g.title, '',
          (SELECT substr(MIN(i.occurred_at), 1, 10) FROM v1_items i
            JOIN item_entry e ON e.item_id = i.id WHERE e.entry_id = g.id),
          g.created_at, g.created_at, NULL
        FROM v1_groups g WHERE g.id IN (SELECT entry_id FROM item_entry);
      INSERT INTO entries (id, project_id, title, note, date, created_at, updated_at, deleted_at)
        SELECT e.entry_id, i.project_id, i.title, i.description, substr(i.occurred_at, 1, 10),
          i.created_at, i.updated_at, i.deleted_at
        FROM v1_items i JOIN item_entry e ON e.item_id = i.id
        WHERE e.entry_id = 'ent_' || i.id;

      INSERT INTO files (id, entry_id, name, kind, position, source_file_id, source_version, current_version, created_at)
        SELECT i.id, e.entry_id,
          (SELECT original_name FROM v1_versions v WHERE v.item_id = i.id AND v.number = i.current_version),
          i.kind,
          CASE WHEN g.primary_item_id = i.id THEN 0 ELSE COALESCE(m.position + 1, 0) END,
          s.source_item_id, s.source_version,
          i.current_version, i.created_at
        FROM v1_items i JOIN item_entry e ON e.item_id = i.id
        LEFT JOIN v1_group_members m ON m.group_id = e.entry_id AND m.item_id = i.id
        LEFT JOIN v1_groups g ON g.id = m.group_id
        LEFT JOIN v1_sources s ON s.rowid = (SELECT rowid FROM v1_sources WHERE item_id = i.id ORDER BY rowid LIMIT 1);
      INSERT INTO file_versions
        SELECT item_id, number, object_key, sha256, size, mime, preview, created_at FROM v1_versions;

      INSERT OR IGNORE INTO memberships
        SELECT m.collection_id, e.entry_id FROM v1_memberships m
          JOIN item_entry e ON e.item_id = m.item_id;
      INSERT OR IGNORE INTO memberships
        SELECT collection_id, group_id FROM v1_group_collections
          WHERE group_id IN (SELECT id FROM entries);

      INSERT OR IGNORE INTO layouts
        SELECT l.project_id, l.view_key, l.target_id, l.x, l.y, l.width FROM v1_layouts l
          WHERE l.target_id IN (SELECT id FROM entries);
      INSERT OR IGNORE INTO layouts
        SELECT l.project_id, l.view_key, 'ent_' || l.target_id, l.x, l.y, l.width FROM v1_layouts l
          WHERE 'ent_' || l.target_id IN (SELECT id FROM entries);
      INSERT INTO viewports SELECT project_id, view_key, x, y, zoom FROM v1_viewports
        WHERE view_key = 'all' OR view_key LIKE 'collection:%';

      DROP TABLE item_entry;
    `);
    for (const table of V1_TABLES) db.exec(`DROP TABLE v1_${table}`);
    db.exec("UPDATE meta SET value='2' WHERE key='schema_version'; COMMIT;");
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
}

export function defaultHome() {
  return path.resolve(process.env.LABCANVAS_HOME || path.join(os.homedir(), '.labcanvas'));
}

export function openDatabase(home = defaultHome()) {
  home = path.resolve(home);
  for (const name of ['', 'objects', 'previews', 'tmp']) {
    mkdirSync(path.join(home, name), { recursive: true, mode: 0o700 });
  }
  const file = path.join(home, 'labcanvas.sqlite');
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec('PRAGMA busy_timeout=8000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const read = () => db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  let version = read();
  if (version === undefined) {
    db.exec(`BEGIN IMMEDIATE; ${SCHEMA} ${SCHEMA_V3}
      INSERT OR IGNORE INTO meta VALUES ('schema_version', '${SCHEMA_VERSION}');
      COMMIT;`);
  } else {
    if (version === '1') {
      migrateV1(db, home);
      version = read();
    }
    if (version === '2') {
      migrateV2(db);
      version = read();
    }
    if (version !== String(SCHEMA_VERSION)) {
      db.close();
      throw new Error(`不支持的资料库版本：${version}`);
    }
  }
  ensureSearch(db);
  return { db, home };
}
