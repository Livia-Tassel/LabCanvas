import { constants, promises as fs, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { stringify } from 'csv-stringify/sync';
import { openDatabase } from './database.mjs';
import { assert, notFound, nameOf, dayOf, AppError } from './errors.mjs';
import { MAX_FILE, kindOf, stageBuffer, stageFile, publishStaged, discardStaged, readTable, tableSlice, editTable, extractText } from './files.mjs';

const MAX_TEXT = 2 * 1024 * 1024;

const newId = prefix => `${prefix}_${randomBytes(6).toString('hex')}`;
const now = () => new Date().toISOString();
const stem = name => path.basename(name, path.extname(name)) || name;

function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

export class Store {
  constructor(home) {
    const { db, home: resolved } = openDatabase(home);
    this.db = db;
    this.home = resolved;
    this.depth = 0;
    this.statements = new Map();
    /** Objects whose removal waits for a running backup to finish copying. */
    this.deferred = null;
  }

  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      if (this.statements.size < 400) this.statements.set(sql, statement);
    }
    return statement;
  }

  close() {
    this.statements.clear();
    this.db.close();
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  one(sql, ...params) {
    return this.prepare(sql).get(...params);
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  tx(fn, { rollback = false } = {}) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec(rollback ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }

  /** Changes whenever another connection (for example the CLI) commits. */
  dataVersion() {
    return this.one('PRAGMA data_version').data_version;
  }

  // ---------------------------------------------------------------- projects

  projects() {
    return this.all(`
      SELECT p.*,
        (SELECT COUNT(*) FROM entries e WHERE e.project_id = p.id AND e.deleted_at IS NULL) AS entry_count
      FROM projects p ORDER BY p.created_at
    `);
  }

  project(ref) {
    assert(typeof ref === 'string' && ref, '请指定项目');
    const found = this.one('SELECT * FROM projects WHERE id = ? OR slug = ?', ref, ref);
    if (found) return found;
    const named = this.all('SELECT * FROM projects WHERE name = ? COLLATE NOCASE', ref);
    if (named.length === 1) return named[0];
    throw new AppError(`项目不存在：${ref}`, 404, 'PROJECT_NOT_FOUND');
  }

  createProject({ name, slug } = {}) {
    name = nameOf(name, '项目名称');
    return this.tx(() => {
      let base = slug == null ? slugify(name) : String(slug).trim();
      if (slug != null) {
        assert(/^[a-z0-9][a-z0-9-]{0,47}$/.test(base), '项目标识须为小写字母、数字和连字符');
        assert(!this.one('SELECT 1 FROM projects WHERE slug = ?', base), `项目标识已存在：${base}`, 409, 'CONFLICT');
      } else {
        if (!base) base = 'project';
        let candidate = base;
        for (let n = 2; this.one('SELECT 1 FROM projects WHERE slug = ?', candidate); n++) candidate = `${base}-${n}`;
        base = candidate;
      }
      const id = newId('prj');
      this.run('INSERT INTO projects (id, slug, name, created_at) VALUES (?, ?, ?, ?)', id, base, name, now());
      return this.project(id);
    });
  }

  updateProject(ref, { name } = {}) {
    const project = this.project(ref);
    this.run('UPDATE projects SET name = ? WHERE id = ?', nameOf(name, '项目名称'), project.id);
    return this.project(project.id);
  }

  async deleteProject(ref) {
    const project = this.project(ref);
    const objects = this.tx(() => {
      const versions = this.all(`
        SELECT v.object_key, v.sha256 FROM file_versions v JOIN files f ON f.id = v.file_id
          JOIN entries e ON e.id = f.entry_id WHERE e.project_id = ?
      `, project.id);
      this.run('DELETE FROM projects WHERE id = ?', project.id);
      return versions;
    });
    this.#collect(objects);
    return { deleted: project.id };
  }

  // ------------------------------------------------------------- collections

  collections(projectRef) {
    const project = this.project(projectRef);
    const rows = this.all(`
      SELECT c.id, c.parent_id, c.name, c.position,
        (SELECT COUNT(*) FROM memberships m JOIN entries e ON e.id = m.entry_id
          WHERE m.collection_id = c.id AND e.deleted_at IS NULL) AS entry_count
      FROM collections c WHERE c.project_id = ? ORDER BY c.position, c.name
    `, project.id);
    const byId = new Map(rows.map(row => [row.id, row]));
    const pathOf = row => (row.parent_id && byId.has(row.parent_id) ? `${pathOf(byId.get(row.parent_id))}/${row.name}` : row.name);
    return rows.map(row => ({ ...row, path: pathOf(row) }));
  }

  collection(id) {
    const row = this.one('SELECT * FROM collections WHERE id = ?', id);
    if (!row) throw notFound('分类');
    return row;
  }

  /** Accepts a collection id or a "/"-separated path; creates missing levels when asked. */
  resolveCollection(projectId, ref, { create = false } = {}) {
    assert(typeof ref === 'string' && ref.trim(), '请指定分类');
    const byId = this.one('SELECT * FROM collections WHERE id = ?', ref);
    if (byId) {
      assert(byId.project_id === projectId, '分类不属于该项目', 404, 'COLLECTION_NOT_FOUND');
      return byId;
    }
    const names = ref.split('/').map(part => part.trim()).filter(Boolean);
    assert(names.length > 0 && names.length <= 8, '分类路径无效');
    return this.tx(() => {
      let parent = null;
      for (const name of names) {
        let row = this.one(
          "SELECT * FROM collections WHERE project_id = ? AND IFNULL(parent_id, '') = ? AND name = ?",
          projectId, parent?.id ?? '', name
        );
        if (!row) {
          if (!create) throw new AppError(`分类不存在：${ref}`, 404, 'COLLECTION_NOT_FOUND');
          row = this.createCollection(projectId, { name, parent_id: parent?.id ?? null });
        }
        parent = row;
      }
      return parent;
    });
  }

  createCollection(projectRef, { name, parent_id = null } = {}) {
    const project = this.project(projectRef);
    name = nameOf(name, '分类名称');
    assert(!name.includes('/'), '分类名称不能包含 /');
    return this.tx(() => {
      if (parent_id) assert(this.collection(parent_id).project_id === project.id, '上级分类不属于该项目');
      assert(
        !this.one("SELECT 1 FROM collections WHERE project_id = ? AND IFNULL(parent_id, '') = ? AND name = ?", project.id, parent_id ?? '', name),
        `同级已有分类「${name}」`, 409, 'CONFLICT'
      );
      const id = newId('col');
      const position = this.one('SELECT IFNULL(MAX(position), 0) + 1 AS next FROM collections WHERE project_id = ?', project.id).next;
      this.run(
        'INSERT INTO collections (id, project_id, parent_id, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, project.id, parent_id, name, position, now()
      );
      return this.collection(id);
    });
  }

  /**
   * Renames, moves or reorders a collection. `before_id` places it in front of that sibling;
   * null places it last.
   */
  updateCollection(id, { name, parent_id, before_id } = {}) {
    return this.tx(() => {
      const current = this.collection(id);
      const nextName = name === undefined ? current.name : nameOf(name, '分类名称');
      assert(!nextName.includes('/'), '分类名称不能包含 /');
      const nextParent = parent_id === undefined ? current.parent_id : parent_id || null;
      if (nextParent) {
        assert(this.collection(nextParent).project_id === current.project_id, '上级分类不属于该项目');
        for (let cursor = nextParent; cursor; cursor = this.collection(cursor).parent_id) {
          assert(cursor !== id, '不能把分类移动到自身之下');
        }
      }
      const clash = this.one(
        "SELECT id FROM collections WHERE project_id = ? AND IFNULL(parent_id, '') = ? AND name = ? AND id != ?",
        current.project_id, nextParent ?? '', nextName, id
      );
      assert(!clash, `同级已有分类「${nextName}」`, 409, 'CONFLICT');
      this.run('UPDATE collections SET name = ?, parent_id = ? WHERE id = ?', nextName, nextParent, id);
      if (before_id !== undefined || nextParent !== current.parent_id) {
        const siblings = this.all(
          "SELECT id FROM collections WHERE project_id = ? AND IFNULL(parent_id, '') = ? AND id != ? ORDER BY position, name",
          current.project_id, nextParent ?? '', id
        ).map(row => row.id);
        const index = before_id ? siblings.indexOf(before_id) : siblings.length;
        assert(index >= 0, '目标位置无效');
        siblings.splice(index, 0, id);
        siblings.forEach((sibling, order) => this.run('UPDATE collections SET position = ? WHERE id = ?', order + 1, sibling));
      }
      return this.collection(id);
    });
  }

  /** Puts every level of the project's collections in name order. */
  sortCollections(projectRef) {
    const project = this.project(projectRef);
    return this.tx(() => {
      const groups = new Map();
      for (const row of this.all('SELECT id, parent_id, name FROM collections WHERE project_id = ?', project.id)) {
        const key = row.parent_id ?? '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      for (const rows of groups.values()) {
        rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
        rows.forEach((row, index) => this.run('UPDATE collections SET position = ? WHERE id = ?', index + 1, row.id));
      }
      return { sorted: groups.size };
    });
  }

  /** Removes the collection subtree. Entries are untouched; only their references go away. */
  deleteCollection(id) {
    const current = this.collection(id);
    this.run('DELETE FROM collections WHERE id = ?', id);
    this.run("DELETE FROM annotations WHERE view_key LIKE 'collection:%' AND substr(view_key, 12) NOT IN (SELECT id FROM collections)");
    this.run("DELETE FROM layouts WHERE view_key LIKE 'collection:%' AND substr(view_key, 12) NOT IN (SELECT id FROM collections)");
    this.run("DELETE FROM viewports WHERE view_key LIKE 'collection:%' AND substr(view_key, 12) NOT IN (SELECT id FROM collections)");
    return { deleted: current.id };
  }

  // ----------------------------------------------------------------- entries

  #hydrate(entries) {
    if (!entries.length) return [];
    const ids = JSON.stringify(entries.map(entry => entry.id));
    const files = this.all(`
      SELECT f.id, f.entry_id, f.name, f.kind, f.position, f.source_file_id, f.source_version, f.current_version AS version,
        v.size, v.sha256, v.mime, v.preview, v.created_at AS updated_at, f.created_at
      FROM files f JOIN file_versions v ON v.file_id = f.id AND v.number = f.current_version
      WHERE f.entry_id IN (SELECT value FROM json_each(?)) ORDER BY f.position, f.created_at
    `, ids);
    const memberships = this.all('SELECT entry_id, collection_id FROM memberships WHERE entry_id IN (SELECT value FROM json_each(?))', ids);
    const fields = this.all('SELECT entry_id, name, value FROM entry_fields WHERE entry_id IN (SELECT value FROM json_each(?)) ORDER BY position, name', ids);
    const byEntry = new Map(entries.map(entry => [entry.id, { ...entry, files: [], collection_ids: [], fields: [] }]));
    for (const field of fields) byEntry.get(field.entry_id).fields.push({ name: field.name, value: field.value });
    for (const file of files) {
      const preview = JSON.parse(file.preview);
      // Previews written by v1 stored table cells under "data".
      if (preview.data && !preview.rows) preview.rows = preview.data;
      delete preview.data;
      byEntry.get(file.entry_id).files.push({ ...file, preview });
    }
    for (const row of memberships) byEntry.get(row.entry_id).collection_ids.push(row.collection_id);
    return [...byEntry.values()];
  }

  entry(id) {
    const row = this.one('SELECT * FROM entries WHERE id = ?', id);
    if (!row) throw new AppError(`条目不存在：${id}`, 404, 'ENTRY_NOT_FOUND');
    return this.#hydrate([row])[0];
  }

  entries(projectRef, { collection, query, trash = false } = {}) {
    const project = this.project(projectRef);
    let rows = this.all(
      `SELECT * FROM entries WHERE project_id = ? AND deleted_at IS ${trash ? 'NOT NULL' : 'NULL'} ORDER BY created_at DESC`,
      project.id
    );
    let list = this.#hydrate(rows);
    if (collection) {
      const id = this.resolveCollection(project.id, collection).id;
      list = list.filter(entry => entry.collection_ids.includes(id));
    }
    if (query?.trim()) {
      const hits = new Set(this.search(project.id, query).map(hit => hit.entry_id));
      list = list.filter(entry => hits.has(entry.id));
    }
    return list;
  }

  snapshot(projectRef) {
    const project = this.project(projectRef);
    const rows = this.all('SELECT * FROM entries WHERE project_id = ? ORDER BY created_at', project.id);
    const all = this.#hydrate(rows);
    return {
      project,
      collections: this.collections(project.id),
      entries: all.filter(entry => !entry.deleted_at),
      trash: all.filter(entry => entry.deleted_at)
    };
  }

  async #stage(files) {
    const staged = [];
    try {
      for (const file of files) {
        assert(file && (file.path || file.buffer), '每个文件须提供 path');
        const result = file.buffer
          ? await stageBuffer(this.home, file.buffer, file.name)
          : await stageFile(this.home, file.path, file.name);
        staged.push({ ...result, source: file.source ?? null });
      }
      return staged;
    } catch (error) {
      await discardStaged(staged);
      throw error;
    }
  }

  async #checkFiles(files) {
    return Promise.all(files.map(async file => {
      assert(file && (file.path || file.buffer), '每个文件须提供 path');
      let size = file.buffer?.length;
      if (size == null) {
        const stat = await fs.stat(file.path).catch(() => null);
        const readable = stat?.isFile() && await fs.access(file.path, constants.R_OK).then(() => true, () => false);
        assert(readable, `文件不存在或不可读：${file.path}`, 422, 'FILE_NOT_FOUND');
        size = stat.size;
      }
      assert(size <= MAX_FILE, '单个文件最大支持 200 MB', 413, 'FILE_TOO_LARGE');
      const name = path.basename(file.name || file.path).slice(0, 255);
      return { name, size, source: file.source, kind: kindOf(name), objectKey: '', sha256: newId('check'), mime: '', preview: {} };
    }));
  }

  #insertVersion(fileId, number, staged) {
    publishStaged(this.home, staged);
    this.run(
      'INSERT INTO file_versions (file_id, number, object_key, sha256, size, mime, preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      fileId, number, staged.objectKey, staged.sha256, staged.size, staged.mime, JSON.stringify(staged.preview), now()
    );
    this.run('UPDATE files SET current_version = ? WHERE id = ?', number, fileId);
    if (staged.text != null) this.run('INSERT OR IGNORE INTO file_text (sha256, content) VALUES (?, ?)', staged.sha256, staged.text);
    this.#stampSource(fileId);
  }

  /** Records that a figure matches the current version of its source. */
  #stampSource(fileId) {
    this.run(
      `UPDATE files SET source_version = (SELECT s.current_version FROM files s WHERE s.id = files.source_file_id)
       WHERE id = ? AND source_file_id IS NOT NULL`,
      fileId
    );
  }

  /** Sets or removes properties. A null or empty value removes the property. */
  #setFields(entryId, fields) {
    if (fields == null) return;
    assert(typeof fields === 'object' && !Array.isArray(fields), 'fields 须为对象');
    for (const [rawName, raw] of Object.entries(fields)) {
      const name = nameOf(rawName, '属性名');
      assert(name.length <= 60, '属性名最多 60 个字符');
      if (raw === null || raw === '') {
        this.run('DELETE FROM entry_fields WHERE entry_id = ? AND name = ?', entryId, name);
        continue;
      }
      assert(['string', 'number', 'boolean'].includes(typeof raw), '属性值须为文本、数字或布尔值');
      const position = this.one('SELECT IFNULL(MAX(position), 0) + 1 AS next FROM entry_fields WHERE entry_id = ?', entryId).next;
      this.run(
        `INSERT INTO entry_fields (entry_id, name, value, position) VALUES (?, ?, ?, ?)
         ON CONFLICT (entry_id, name) DO UPDATE SET value = excluded.value`,
        entryId, name, String(raw).trim().slice(0, 2000), position
      );
    }
    assert(this.one('SELECT COUNT(*) AS n FROM entry_fields WHERE entry_id = ?', entryId).n <= 50, '每个条目最多 50 个属性');
  }

  #touch(entryId) {
    this.run('UPDATE entries SET updated_at = ? WHERE id = ?', now(), entryId);
  }

  /**
   * Adds staged files to an entry. With `upsert`, a file whose name already exists in the entry
   * receives a new version instead of a duplicate. With `link`, figures are tied to the entry's
   * only table as their source.
   */
  #attach(entryId, staged, { upsert = false, link = true } = {}) {
    const existing = this.all(`
      SELECT f.*, v.sha256 FROM files f JOIN file_versions v ON v.file_id = f.id AND v.number = f.current_version
      WHERE f.entry_id = ? ORDER BY f.position
    `, entryId);
    const byName = new Map(upsert ? existing.map(file => [file.name, file]) : []);
    if (upsert) {
      const names = staged.map(file => file.name);
      assert(new Set(names).size === names.length, '更新同一条目时文件名须唯一', 422, 'DUPLICATE_FILENAME');
      for (const name of names) {
        assert(existing.filter(file => file.name === name).length <= 1, `条目中有多个同名文件：${name}`, 409, 'DUPLICATE_FILENAME');
      }
    }
    let position = existing.reduce((max, file) => Math.max(max, file.position), -1);
    const results = [];
    const added = [];
    for (const item of staged) {
      const match = byName.get(item.name);
      if (match) {
        if (match.sha256 === item.sha256) {
          results.push({ id: match.id, name: match.name, status: 'unchanged', version: match.current_version });
        } else {
          this.#insertVersion(match.id, match.current_version + 1, item);
          results.push({ id: match.id, name: match.name, status: 'updated', version: match.current_version + 1 });
        }
        continue;
      }
      // The same bytes already filed elsewhere in the project are worth pointing out to the importer.
      const twin = this.one(`
        SELECT e.id, e.title FROM file_versions v
          JOIN files f ON f.id = v.file_id AND f.current_version = v.number
          JOIN entries e ON e.id = f.entry_id
        WHERE v.sha256 = ? AND e.id != ? AND e.deleted_at IS NULL
          AND e.project_id = (SELECT project_id FROM entries WHERE id = ?) LIMIT 1
      `, item.sha256, entryId, entryId);
      const id = newId('fil');
      this.run(
        'INSERT INTO files (id, entry_id, name, kind, position, current_version, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        id, entryId, item.name, item.kind, ++position, now()
      );
      this.#insertVersion(id, 1, item);
      added.push({ id, ...item });
      results.push({ id, name: item.name, status: 'added', version: 1, ...(twin ? { duplicate_of: { entry_id: twin.id, title: twin.title } } : {}) });
    }
    const files = this.all('SELECT id, name, kind FROM files WHERE entry_id = ?', entryId);
    const tables = files.filter(file => file.kind === 'table');
    for (const file of added) {
      let source = null;
      if (file.source) {
        source = files.find(other => (other.id === file.source || other.name === file.source) && other.id !== file.id);
        assert(source, `找不到来源文件：${file.source}`, 422, 'SOURCE_NOT_FOUND');
      } else if (link && tables.length === 1 && ['image', 'pdf'].includes(file.kind)) {
        source = tables[0];
      }
      if (source) this.#setSource(file.id, source.id);
    }
    // A figure imported together with its table matches it, whatever order the two were written in.
    for (const result of results) if (result.status !== 'unchanged') this.#stampSource(result.id);
    this.#touch(entryId);
    return results;
  }

  #defaultTitle(staged) {
    const lead = staged.find(file => file.kind === 'table') ?? staged[0];
    return stem(lead.name);
  }

  /**
   * Creates one entry holding the given files. When `key` matches an existing entry in the project,
   * that entry is updated in place instead, which makes repeated agent imports safe.
   */
  async createEntry(projectRef, spec = {}, { dryRun = false } = {}) {
    const [entry] = await this.createEntries(projectRef, [spec], { dryRun });
    return entry;
  }

  /** Stages every file before committing the batch of grouped or independent entries. */
  async createEntries(projectRef, specs, { dryRun = false } = {}) {
    const project = this.project(projectRef);
    const keys = new Set();
    const prepared = [];
    try {
      for (const spec of specs) {
        const files = spec.files ?? [];
        assert(Array.isArray(files) && files.length <= 200, '每个条目最多添加 200 个文件');
        const key = spec.key == null || spec.key === '' ? null : String(spec.key).trim();
        assert(key === null || (key.length > 0 && key.length <= 200), 'key 须为 1–200 个字符');
        if (key) {
          assert(!keys.has(key), `批次包含重复导入标识：${key}`, 422, 'DUPLICATE_KEY');
          keys.add(key);
        }
        const collections = spec.collections ?? [];
        assert(Array.isArray(collections) && collections.every(ref => typeof ref === 'string'), 'collections 须为字符串数组');
        const date = spec.date == null || spec.date === '' ? null : dayOf(spec.date);
        const title = spec.title ? nameOf(spec.title, '标题') : null;
        const staged = dryRun ? await this.#checkFiles(files) : await this.#stage(files);
        prepared.push({ ...spec, title, key, collections, date, staged });
        if (key) assert(new Set(staged.map(file => file.name)).size === staged.length, '带 key 的条目须使用不同文件名', 422, 'DUPLICATE_FILENAME');
      }
      return this.tx(() => prepared.map(spec => this.#writeEntry(project.id, spec, dryRun)), { rollback: dryRun });
    } catch (error) {
      if (!dryRun) this.#collect(prepared.flatMap(spec => spec.staged.map(file => ({ object_key: file.objectKey, sha256: file.sha256 }))));
      throw error;
    } finally {
      await discardStaged(prepared.flatMap(spec => spec.staged));
    }
  }

  #writeEntry(projectId, { title, note, link, key, collections, date, fields, staged }, dryRun) {
    const current = key ? this.one('SELECT * FROM entries WHERE project_id = ? AND key = ?', projectId, key) : null;
    assert(current || staged.length > 0, '请至少提供一个文件');
    let id;
    if (current) {
      id = current.id;
      this.run(
        'UPDATE entries SET title = ?, note = ?, date = ?, deleted_at = NULL WHERE id = ?',
        title ?? current.title,
        note == null ? current.note : String(note).slice(0, 20000),
        date ?? current.date,
        id
      );
    } else {
      id = newId('ent');
      const stamp = now();
      this.run(
        'INSERT INTO entries (id, project_id, key, title, note, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, projectId, key, title ?? this.#defaultTitle(staged),
        String(note ?? '').slice(0, 20000), date ?? dayOf(), stamp, stamp
      );
    }
    const fileResults = this.#attach(id, staged, { upsert: !!current, link: link !== false });
    this.#setFields(id, fields);
    for (const ref of collections) {
      const collection = this.resolveCollection(projectId, ref, { create: true });
      this.run('INSERT OR IGNORE INTO memberships (collection_id, entry_id) VALUES (?, ?)', collection.id, id);
    }
    if (dryRun) return { dry_run: true, status: current ? 'updated' : 'created', id: current?.id ?? null, files: staged.length, collections };
    const entry = this.entry(id);
    return { id, status: current ? 'updated' : 'created', title: entry.title, date: entry.date, files: fileResults, collection_ids: entry.collection_ids };
  }

  async addFiles(entryId, files, options = {}) {
    this.entry(entryId);
    assert(Array.isArray(files) && files.length > 0 && files.length <= 200, '请提供 1–200 个文件');
    const staged = await this.#stage(files);
    try {
      return this.tx(() => ({ id: entryId, files: this.#attach(entryId, staged, options) }));
    } catch (error) {
      this.#collect(staged.map(file => ({ object_key: file.objectKey, sha256: file.sha256 })));
      throw error;
    } finally {
      await discardStaged(staged);
    }
  }

  updateEntry(id, { title, note, date, fields } = {}) {
    return this.tx(() => {
      const current = this.entry(id);
      this.run(
        'UPDATE entries SET title = ?, note = ?, date = ?, updated_at = ? WHERE id = ?',
        title === undefined ? current.title : nameOf(title, '标题'),
        note === undefined ? current.note : String(note).slice(0, 20000),
        date === undefined ? current.date : dayOf(date),
        now(), id
      );
      this.#setFields(id, fields);
      return this.entry(id);
    });
  }

  /** Applies the same change to several entries of one project. */
  updateEntries(projectRef, entryIds, patch) {
    const project = this.project(projectRef);
    return this.tx(() => this.#owned(project.id, entryIds).map(id => this.updateEntry(id, patch)));
  }

  #owned(projectId, entryIds) {
    assert(Array.isArray(entryIds) && entryIds.length > 0, '请指定条目');
    for (const id of entryIds) {
      const row = this.one('SELECT project_id FROM entries WHERE id = ?', id);
      if (!row || row.project_id !== projectId) throw new AppError(`条目不存在：${id}`, 404, 'ENTRY_NOT_FOUND');
    }
    return [...new Set(entryIds)];
  }

  /** Adds or removes collection references. The entries themselves are never changed. */
  setMembership(projectRef, entryIds, collectionRef, member = true) {
    const project = this.project(projectRef);
    return this.tx(() => {
      const ids = this.#owned(project.id, entryIds);
      const collection = this.resolveCollection(project.id, collectionRef, { create: member });
      for (const id of ids) {
        if (member) this.run('INSERT OR IGNORE INTO memberships (collection_id, entry_id) VALUES (?, ?)', collection.id, id);
        else {
          this.run('DELETE FROM memberships WHERE collection_id = ? AND entry_id = ?', collection.id, id);
          this.run('DELETE FROM layouts WHERE view_key = ? AND entry_id = ?', `collection:${collection.id}`, id);
        }
      }
      return { collection_id: collection.id, entry_ids: ids, member };
    });
  }

  trash(projectRef, entryIds, deleted = true) {
    const project = this.project(projectRef);
    return this.tx(() => {
      const ids = this.#owned(project.id, entryIds);
      for (const id of ids) this.run('UPDATE entries SET deleted_at = ? WHERE id = ?', deleted ? now() : null, id);
      return { entry_ids: ids, trashed: deleted };
    });
  }

  /** Permanently deletes entries, their files and every collection reference. */
  async purge(projectRef, entryIds) {
    const project = this.project(projectRef);
    const { ids, objects } = this.tx(() => {
      const ids = this.#owned(project.id, entryIds);
      const objects = this.all(`
        SELECT v.object_key, v.sha256 FROM file_versions v JOIN files f ON f.id = v.file_id
        WHERE f.entry_id IN (SELECT value FROM json_each(?))
      `, JSON.stringify(ids));
      for (const id of ids) this.run('DELETE FROM entries WHERE id = ?', id);
      return { ids, objects };
    });
    this.#collect(objects);
    return { deleted: ids };
  }

  async emptyTrash(projectRef) {
    const project = this.project(projectRef);
    const ids = this.all('SELECT id FROM entries WHERE project_id = ? AND deleted_at IS NOT NULL', project.id).map(row => row.id);
    if (!ids.length) return { deleted: [] };
    return this.purge(project.id, ids);
  }

  /** Folds several entries into the first one. Files and collection references are kept. */
  merge(projectRef, entryIds, { title } = {}) {
    const project = this.project(projectRef);
    return this.tx(() => {
      const ids = this.#owned(project.id, entryIds);
      assert(ids.length >= 2, '请选择至少两个条目');
      const [target, ...rest] = ids;
      let position = this.one('SELECT IFNULL(MAX(position), -1) AS max FROM files WHERE entry_id = ?', target).max;
      for (const id of rest) {
        for (const file of this.all('SELECT id FROM files WHERE entry_id = ? ORDER BY position', id)) {
          this.run('UPDATE files SET entry_id = ?, position = ? WHERE id = ?', target, ++position, file.id);
        }
        this.run('INSERT OR IGNORE INTO memberships (collection_id, entry_id) SELECT collection_id, ? FROM memberships WHERE entry_id = ?', target, id);
        this.run('INSERT OR IGNORE INTO entry_fields (entry_id, name, value, position) SELECT ?, name, value, position + 100 FROM entry_fields WHERE entry_id = ?', target, id);
        this.run('DELETE FROM entries WHERE id = ?', id);
      }
      if (title) this.run('UPDATE entries SET title = ? WHERE id = ?', nameOf(title, '标题'), target);
      const tables = this.all("SELECT id FROM files WHERE entry_id = ? AND kind = 'table'", target);
      if (tables.length === 1) {
        const figures = this.all("SELECT id FROM files WHERE entry_id = ? AND kind IN ('image', 'pdf') AND source_file_id IS NULL", target);
        for (const figure of figures) this.#setSource(figure.id, tables[0].id);
      }
      this.#touch(target);
      return this.entry(target);
    });
  }

  // ------------------------------------------------------------------- files

  file(id) {
    const row = this.one(`
      SELECT f.*, e.project_id, v.object_key, v.sha256, v.size, v.mime
      FROM files f JOIN entries e ON e.id = f.entry_id
      JOIN file_versions v ON v.file_id = f.id AND v.number = f.current_version
      WHERE f.id = ?
    `, id);
    if (!row) throw new AppError(`文件不存在：${id}`, 404, 'FILE_NOT_FOUND');
    return row;
  }

  version(fileId, number) {
    const file = this.file(fileId);
    const row = this.one('SELECT * FROM file_versions WHERE file_id = ? AND number = ?', fileId, number ?? file.current_version);
    if (!row) throw notFound('版本');
    return { ...row, name: file.name, path: path.join(this.home, 'objects', row.object_key) };
  }

  versions(fileId) {
    const file = this.file(fileId);
    return this.all('SELECT number, size, sha256, created_at FROM file_versions WHERE file_id = ? ORDER BY number DESC', fileId)
      .map(row => ({ ...row, current: row.number === file.current_version }));
  }

  #commitVersion(file, staged, expectedVersion) {
    return this.tx(() => {
      const fresh = this.file(file.id);
      if (expectedVersion != null) {
        assert(fresh.current_version === expectedVersion, '文件已被其他操作更新，请重新打开', 409, 'VERSION_CONFLICT');
      }
      if (fresh.sha256 === staged.sha256) return { id: file.id, version: fresh.current_version, changed: false };
      const number = this.one('SELECT MAX(number) AS max FROM file_versions WHERE file_id = ?', file.id).max + 1;
      this.#insertVersion(file.id, number, staged);
      this.#touch(fresh.entry_id);
      return { id: file.id, version: number, changed: true };
    });
  }

  async replaceFile(fileId, { path: source, buffer }, expectedVersion) {
    const file = this.file(fileId);
    const staged = buffer ? await stageBuffer(this.home, buffer, file.name) : await stageFile(this.home, source, file.name);
    return this.#commitStagedVersion(file, staged, expectedVersion);
  }

  async #commitStagedVersion(file, staged, expectedVersion) {
    try {
      return this.#commitVersion(file, staged, expectedVersion);
    } catch (error) {
      this.#collect([{ object_key: staged.objectKey, sha256: staged.sha256 }]);
      throw error;
    } finally {
      await discardStaged([staged]);
    }
  }

  restoreVersion(fileId, number) {
    const file = this.file(fileId);
    const old = this.one('SELECT * FROM file_versions WHERE file_id = ? AND number = ?', fileId, number);
    if (!old) throw notFound('版本');
    return this.#commitVersion(file, {
      objectKey: old.object_key, sha256: old.sha256, size: old.size, mime: old.mime, preview: JSON.parse(old.preview)
    });
  }

  #setSource(id, sourceId) {
    if (sourceId) {
      const chain = this.one(`
        WITH RECURSIVE ancestors(id) AS (
          VALUES (?) UNION SELECT f.source_file_id
            FROM files f JOIN ancestors a ON a.id = f.id WHERE f.source_file_id IS NOT NULL
        ) SELECT 1 FROM ancestors WHERE id = ?
      `, sourceId, id);
      assert(!chain, '来源关系不能形成循环', 422, 'SOURCE_CYCLE');
    }
    this.run('UPDATE files SET source_file_id = ?, source_version = NULL WHERE id = ?', sourceId, id);
    this.#stampSource(id);
  }

  updateFile(id, { name, source_file_id, position, source_checked } = {}) {
    return this.tx(() => {
      const file = this.file(id);
      if (name !== undefined) {
        name = nameOf(name, '文件名');
        assert(!/[\\/]/.test(name), '文件名不能包含路径分隔符');
        assert(path.extname(name).toLowerCase() === path.extname(file.name).toLowerCase(), '不能更改文件扩展名');
        this.run('UPDATE files SET name = ? WHERE id = ?', name, id);
      }
      if (source_file_id !== undefined) {
        if (source_file_id) {
          assert(source_file_id !== id, '文件不能以自身为来源');
          assert(this.file(source_file_id).project_id === file.project_id, '来源文件不属于该项目');
        }
        this.#setSource(id, source_file_id || null);
      }
      // The user has checked the figure against the newer source and it still holds.
      if (source_checked) this.#stampSource(id);
      if (position !== undefined) {
        assert(Number.isInteger(position) && position >= 0, 'position 无效');
        const order = this.all('SELECT id FROM files WHERE entry_id = ? ORDER BY position, created_at', file.entry_id).map(row => row.id).filter(other => other !== id);
        order.splice(Math.min(position, order.length), 0, id);
        order.forEach((fileId, index) => this.run('UPDATE files SET position = ? WHERE id = ?', index, fileId));
      }
      this.#touch(file.entry_id);
      return this.entry(file.entry_id);
    });
  }

  /** Moves one file out of a multi-file entry into its own entry with the same classification. */
  splitFile(id) {
    return this.tx(() => {
      const file = this.file(id);
      const entry = this.entry(file.entry_id);
      assert(entry.files.length > 1, '条目只有一个文件，无需拆分');
      const entryId = newId('ent');
      const stamp = now();
      this.run(
        'INSERT INTO entries (id, project_id, title, note, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        entryId, entry.project_id, stem(file.name), '', entry.date, stamp, stamp
      );
      this.run('UPDATE files SET entry_id = ?, position = 0 WHERE id = ?', entryId, id);
      this.run('INSERT INTO memberships (collection_id, entry_id) SELECT collection_id, ? FROM memberships WHERE entry_id = ?', entryId, entry.id);
      this.run('INSERT INTO entry_fields (entry_id, name, value, position) SELECT ?, name, value, position FROM entry_fields WHERE entry_id = ?', entryId, entry.id);
      this.run('INSERT INTO layouts SELECT project_id, view_key, ?, x + w + 24, y, 360 FROM layouts WHERE entry_id = ?', entryId, entry.id);
      this.#touch(entry.id);
      return this.entry(entryId);
    });
  }

  async deleteFile(id) {
    const { entryId, objects } = this.tx(() => {
      const file = this.file(id);
      const count = this.one('SELECT COUNT(*) AS n FROM files WHERE entry_id = ?', file.entry_id).n;
      assert(count > 1, '这是条目中唯一的文件，请删除整个条目', 409, 'LAST_FILE');
      const objects = this.all('SELECT object_key, sha256 FROM file_versions WHERE file_id = ?', id);
      this.run('DELETE FROM files WHERE id = ?', id);
      this.#touch(file.entry_id);
      return { entryId: file.entry_id, objects };
    });
    this.#collect(objects);
    return this.entry(entryId);
  }

  async table(fileId, { sheet = 0, offset = 0, limit = 500, version } = {}) {
    const file = this.file(fileId);
    assert(file.kind === 'table', '该文件不是表格', 422, 'NOT_A_TABLE');
    assert(Number.isInteger(sheet) && sheet >= 0 && Number.isInteger(offset) && offset >= 0, '表格范围无效');
    limit = Math.min(Math.max(Number(limit) || 500, 1), 20000);
    const stored = this.version(fileId, version);
    const table = await readTable(stored.path, file.name);
    return { ...tableSlice(table, sheet, offset, limit), version: stored.number, editable: true };
  }

  async editTable(fileId, operations, expectedVersion) {
    const file = this.file(fileId);
    assert(file.kind === 'table', '该文件不是表格', 422, 'NOT_A_TABLE');
    if (expectedVersion != null) assert(file.current_version === expectedVersion, '文件已被其他操作更新，请重新打开', 409, 'VERSION_CONFLICT');
    const staged = await editTable(this.home, file, file.name, operations);
    return this.#commitStagedVersion(file, staged, expectedVersion);
  }

  /** Reads a text file. Files over the limit return their beginning, or their end with `tail`. */
  async text(fileId, { version, tail = false } = {}) {
    const stored = this.version(fileId, version);
    const handle = await fs.open(stored.path);
    try {
      const truncated = stored.size > MAX_TEXT;
      const start = truncated && tail ? stored.size - MAX_TEXT : 0;
      const buffer = Buffer.alloc(Math.min(stored.size, MAX_TEXT));
      await handle.read(buffer, 0, buffer.length, start);
      let content = buffer.toString('utf8');
      // A window cut out of the file starts mid-line; begin at the next whole line.
      if (start > 0) content = content.slice(content.indexOf('\n') + 1);
      return { content, truncated, tail: start > 0, size: stored.size, version: stored.number };
    } finally {
      await handle.close();
    }
  }

  async saveText(fileId, content, expectedVersion) {
    const file = this.file(fileId);
    assert(typeof content === 'string' && Buffer.byteLength(content) <= MAX_TEXT, '文本最大支持 2 MB');
    assert(file.size <= MAX_TEXT, '文件过大，无法在应用内编辑', 413, 'FILE_TOO_LARGE');
    return this.#commitStagedVersion(file, await stageBuffer(this.home, Buffer.from(content), file.name), expectedVersion);
  }

  async createTable(projectRef, { title, rows = 12, columns = 5, collections = [] } = {}) {
    title = nameOf(title, '标题');
    assert(Number.isInteger(rows) && rows >= 1 && rows <= 1000 && Number.isInteger(columns) && columns >= 1 && columns <= 100, '行列数无效');
    const grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ''));
    const name = `${title.replace(/[\\/:*?"<>|]/g, '-')}.csv`;
    return this.createEntry(projectRef, { title, collections, files: [{ buffer: Buffer.from(stringify(grid)), name }] });
  }

  // ------------------------------------------------------------------ canvas

  #view(projectId, view) {
    assert(typeof view === 'string' && view, '请指定视图');
    if (view === 'all' || view === 'unfiled') return view;
    assert(view.startsWith('collection:'), '视图无效');
    assert(this.collection(view.slice(11)).project_id === projectId, '视图无效');
    return view;
  }

  layout(projectRef, view) {
    const project = this.project(projectRef);
    view = this.#view(project.id, view);
    return {
      view,
      positions: this.all('SELECT entry_id, x, y, w FROM layouts WHERE project_id = ? AND view_key = ?', project.id, view),
      annotations: this.all('SELECT id, kind, x, y, w, h, text FROM annotations WHERE project_id = ? AND view_key = ? ORDER BY created_at', project.id, view),
      viewport: this.one('SELECT x, y, zoom FROM viewports WHERE project_id = ? AND view_key = ?', project.id, view) ?? null
    };
  }

  saveLayout(projectRef, view, { positions = [], viewport } = {}) {
    const project = this.project(projectRef);
    view = this.#view(project.id, view);
    const finite = (...values) => values.every(value => typeof value === 'number' && Number.isFinite(value));
    return this.tx(() => {
      for (const position of positions) {
        assert(finite(position.x, position.y, position.w) && position.w >= 160 && position.w <= 4000, '位置无效');
        const owner = this.one('SELECT project_id FROM entries WHERE id = ?', position.entry_id);
        if (owner?.project_id !== project.id) continue;
        this.run(
          `INSERT INTO layouts (project_id, view_key, entry_id, x, y, w) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, view_key, entry_id) DO UPDATE SET x = excluded.x, y = excluded.y, w = excluded.w`,
          project.id, view, position.entry_id, position.x, position.y, position.w
        );
      }
      if (viewport) {
        assert(finite(viewport.x, viewport.y, viewport.zoom) && viewport.zoom > 0.01 && viewport.zoom < 20, '视口无效');
        this.run(
          `INSERT INTO viewports (project_id, view_key, x, y, zoom) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (project_id, view_key) DO UPDATE SET x = excluded.x, y = excluded.y, zoom = excluded.zoom`,
          project.id, view, viewport.x, viewport.y, viewport.zoom
        );
      }
      return { saved: positions.length };
    });
  }

  #annotationBox({ x, y, w, h }) {
    const finite = [x, y, w, h].every(value => typeof value === 'number' && Number.isFinite(value));
    assert(finite && w >= 40 && w <= 20000 && h >= 24 && h <= 20000, '标注位置无效');
  }

  /** Adds a text note or a frame to the canvas of one view. */
  createAnnotation(projectRef, view, { id, kind, x, y, w, h, text = '' } = {}) {
    const project = this.project(projectRef);
    view = this.#view(project.id, view);
    assert(['note', 'frame'].includes(kind), '标注类型无效');
    this.#annotationBox({ x, y, w, h });
    assert(typeof text === 'string' && text.length <= 20000, '标注文字过长');
    // An id is supplied when a deleted annotation is brought back by undo.
    assert(id === undefined || /^ann_[0-9a-f]{12}$/.test(id), '标注标识无效');
    id ??= newId('ann');
    this.run(
      `INSERT INTO annotations (id, project_id, view_key, kind, x, y, w, h, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, text = excluded.text`,
      id, project.id, view, kind, x, y, w, h, text, now()
    );
    return this.one('SELECT id, kind, x, y, w, h, text FROM annotations WHERE id = ?', id);
  }

  updateAnnotation(id, patch = {}) {
    const current = this.one('SELECT * FROM annotations WHERE id = ?', id);
    if (!current) throw notFound('标注');
    const next = { ...current };
    for (const key of ['x', 'y', 'w', 'h', 'text']) if (patch[key] !== undefined) next[key] = patch[key];
    this.#annotationBox(next);
    assert(typeof next.text === 'string' && next.text.length <= 20000, '标注文字过长');
    this.run('UPDATE annotations SET x = ?, y = ?, w = ?, h = ?, text = ? WHERE id = ?', next.x, next.y, next.w, next.h, next.text, id);
    return this.one('SELECT id, kind, x, y, w, h, text FROM annotations WHERE id = ?', id);
  }

  deleteAnnotation(id) {
    this.run('DELETE FROM annotations WHERE id = ?', id);
    return { deleted: id };
  }

  // ------------------------------------------------------------------ search

  /** Brings the search documents of changed entries up to date. */
  #flushSearch() {
    for (;;) {
      const dirty = this.all('SELECT entry_id FROM search_dirty LIMIT 500').map(row => row.entry_id);
      if (!dirty.length) return;
      this.tx(() => {
        for (const entryId of dirty) {
          const doc = this.one('SELECT id FROM search_docs WHERE entry_id = ?', entryId);
          const entry = this.one('SELECT project_id, title, note, key, date FROM entries WHERE id = ?', entryId);
          if (doc) this.run('DELETE FROM search_fts WHERE rowid = ?', doc.id);
          if (!entry) {
            if (doc) this.run('DELETE FROM search_docs WHERE id = ?', doc.id);
          } else {
            const fields = this.all('SELECT name, value FROM entry_fields WHERE entry_id = ? ORDER BY position', entryId);
            const files = this.all(`
              SELECT f.name, t.content FROM files f
                JOIN file_versions v ON v.file_id = f.id AND v.number = f.current_version
                LEFT JOIN file_text t ON t.sha256 = v.sha256
              WHERE f.entry_id = ? ORDER BY f.position
            `, entryId);
            const text = [
              entry.title, entry.key, entry.date, entry.note,
              ...fields.map(field => `${field.name}: ${field.value}`),
              ...files.map(file => file.name),
              ...files.map(file => file.content)
            ].filter(Boolean).join('\n');
            const id = doc?.id ?? Number(this.run('INSERT INTO search_docs (entry_id, project_id) VALUES (?, ?)', entryId, entry.project_id).lastInsertRowid);
            this.run('INSERT INTO search_fts (rowid, text) VALUES (?, ?)', id, text);
          }
          this.run('DELETE FROM search_dirty WHERE entry_id = ?', entryId);
        }
      });
    }
  }

  /**
   * Finds entries whose title, note, properties, file names or file contents contain every word of the query.
   * Returns the matching entry ids with a short excerpt around the first word.
   */
  search(projectRef, query, { limit = 2000 } = {}) {
    const project = this.project(projectRef);
    const terms = String(query ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    this.#flushSearch();
    const clauses = [];
    const params = [];
    for (const term of terms) {
      // An ESCAPE clause keeps the index from being used, so add it only when it is needed.
      const special = /[\\%_]/.test(term);
      clauses.push(special ? "s.text LIKE ? ESCAPE '\\'" : 's.text LIKE ?');
      params.push(`%${special ? term.replace(/[\\%_]/g, '\\$&') : term}%`);
    }
    const rows = this.all(`
      SELECT d.entry_id, substr(s.text, max(1, instr(lower(s.text), lower(?)) - 30), 110) AS snippet
      FROM search_fts s JOIN search_docs d ON d.id = s.rowid
      WHERE ${clauses.join(' AND ')} AND d.project_id = ? LIMIT ?
    `, terms[0], ...params, project.id, Math.min(Math.max(Number(limit) || 2000, 1), 5000));
    return rows.map(row => ({ entry_id: row.entry_id, snippet: row.snippet.replace(/\s+/g, ' ').trim() }));
  }

  /** Extracts searchable text for files stored before the search index existed. */
  async reindex() {
    const rows = this.all(`
      SELECT DISTINCT v.sha256, v.object_key, f.name FROM files f
        JOIN file_versions v ON v.file_id = f.id AND v.number = f.current_version
      WHERE f.kind IN ('table', 'text') AND v.sha256 NOT IN (SELECT sha256 FROM file_text)
    `);
    for (const row of rows) {
      const content = await extractText(path.join(this.home, 'objects', row.object_key), row.name);
      this.run('INSERT OR IGNORE INTO file_text (sha256, content) VALUES (?, ?)', row.sha256, content);
    }
    this.#flushSearch();
    return { indexed: rows.length };
  }

  // ------------------------------------------------------------------ export

  /** Files of the given entries with the path each should have inside an archive. */
  exportList(projectRef, entryIds) {
    const project = this.project(projectRef);
    const ids = this.#owned(project.id, entryIds);
    const clean = name => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim().slice(0, 120) || '未命名';
    const taken = new Set();
    const unique = name => {
      let candidate = name;
      for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
        const ext = path.extname(name);
        candidate = `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
      }
      taken.add(candidate.toLowerCase());
      return candidate;
    };
    const list = [];
    for (const entry of ids.map(id => this.entry(id))) {
      const folder = unique(clean(entry.title));
      for (const file of entry.files) {
        const stored = this.version(file.id);
        list.push({ name: unique(`${folder}/${clean(file.name)}`), path: stored.path, size: stored.size });
      }
    }
    return list;
  }

  /**
   * Copies the library to a new directory. With `lock`, writers in other processes wait until the copy is done;
   * without it (inside the running server) removals are postponed instead, so the copy stays complete.
   */
  async backup(target, { lock = false } = {}) {
    assert(typeof target === 'string' && target.trim(), '请提供备份目录');
    target = target.trim();
    if (target === '~' || target.startsWith('~/')) target = path.join(os.homedir(), target.slice(1));
    assert(path.isAbsolute(target) || lock, '备份目录须为完整路径');
    target = path.resolve(target);
    assert(target !== this.home && !target.startsWith(`${this.home}${path.sep}`), '备份目录须位于资料库之外');
    assert(!(await fs.stat(target).catch(() => null)), '备份目标已存在，请选择一个新目录', 409, 'CONFLICT');
    assert(!this.deferred, '已有备份正在进行', 409, 'CONFLICT');
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const reader = new DatabaseSync(path.join(this.home, 'labcanvas.sqlite'), { readOnly: true });
    this.deferred = [];
    if (lock) this.db.exec('BEGIN IMMEDIATE');
    try {
      await backup(reader, path.join(target, 'labcanvas.sqlite'));
      for (const directory of ['objects', 'previews']) {
        await fs.cp(path.join(this.home, directory), path.join(target, directory), { recursive: true });
      }
    } finally {
      if (lock) this.db.exec('ROLLBACK');
      reader.close();
      const waiting = this.deferred;
      this.deferred = null;
      this.#collect(waiting);
    }
    return { backup: target };
  }

  // ------------------------------------------------------------- maintenance

  /** Checks all remaining references while excluding concurrent object publication. */
  #collect(versions) {
    if (!versions.length) return;
    if (this.deferred) {
      this.deferred.push(...versions);
      return;
    }
    this.tx(() => {
      const used = this.all('SELECT DISTINCT object_key, sha256 FROM file_versions');
      const objects = new Set(used.map(file => file.object_key));
      const previews = new Set(used.map(file => file.sha256));
      const remove = (dir, names) => {
        for (const name of new Set(names)) {
          try {
            unlinkSync(path.join(this.home, dir, name));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      };
      remove('objects', versions.filter(file => !objects.has(file.object_key)).map(file => file.object_key));
      remove('previews', versions.filter(file => !previews.has(file.sha256)).map(file => `${file.sha256}.png`));
      for (const file of versions) if (!previews.has(file.sha256)) this.run('DELETE FROM file_text WHERE sha256 = ?', file.sha256);
    });
  }

  async doctor() {
    const integrity = this.one('PRAGMA integrity_check').integrity_check;
    const missing = [];
    for (const row of this.all('SELECT file_id, number, object_key FROM file_versions')) {
      if (!(await fs.stat(path.join(this.home, 'objects', row.object_key)).catch(() => null))) missing.push(row);
    }
    return { ok: integrity === 'ok' && missing.length === 0, home: this.home, integrity, missing_files: missing };
  }
}
