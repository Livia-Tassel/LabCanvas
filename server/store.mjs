import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { openDatabase } from './database.mjs';
import { assert, AppError, nameOf, dateOf } from './errors.mjs';
import { stageBuffer, stageFile, roleOf, kindOf, MAX_FILE, readTable, tableSlice, patchedTable } from './files.mjs';
const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value || '{}');
const sha = value => createHash('sha256').update(value).digest('hex');
const refList = z.array(z.string().min(1).max(500)).max(200).default([]);
export const manifestSchema = z.object({
  version: z.literal(1).default(1),
  import_key: z.string().min(1).max(200),
  items: z.array(z.object({
    key: z.string().min(1).max(120), path: z.string().min(1), filename: z.string().min(1).max(255).optional(),
    title: z.string().trim().min(1).max(200).optional(), role: z.enum(['result', 'supporting']).optional(),
    description: z.string().max(100000).default(''), collections: refList, derived_from: refList,
    occurred_at: z.string().optional(), metadata: z.record(z.string(), z.unknown()).default({})
  }).strict()).min(1).max(200),
  groups: z.array(z.object({
    key: z.string().min(1).max(120), title: z.string().trim().min(1).max(200),
    members: z.array(z.string()).min(2).max(200), primary: z.string().optional(), collections: refList
  }).strict()).max(100).default([]),
  run: z.object({ id: z.string().optional(), title: z.string().trim().min(1).max(200).optional(), occurred_at: z.string().optional(), command: z.string().max(20000).default('') }).strict().optional()
}).strict();

export class Store {
  constructor(home) { const opened = openDatabase(home); this.db = opened.db; this.home = opened.home; }
  close() { this.db.close(); }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  exec(sql, ...args) { return this.db.prepare(sql).run(...args); }
  tx(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  projects() { return this.all('SELECT * FROM projects ORDER BY created_at'); }
  project(ref) {
    assert(typeof ref === 'string' && ref.length > 0, '请提供有效的项目标识');
    const project = this.one('SELECT * FROM projects WHERE id=? OR slug=?', ref, ref) || this.one('SELECT * FROM projects WHERE name=?', ref);
    assert(project, '项目不存在', 404, 'NOT_FOUND'); return project;
  }
  createProject({ name, slug, description = '', is_demo = false }) {
    name = nameOf(name, '项目名称');
    slug ||= name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `project-${randomUUID().slice(0, 8)}`;
    assert(/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug), '项目 slug 仅支持小写字母、数字和连字符');
    assert(!this.one('SELECT id FROM projects WHERE slug=?', slug), '项目标识已存在', 409, 'CONFLICT');
    const projectId = id('prj');
    this.exec('INSERT INTO projects (id,slug,name,description,is_demo,created_at) VALUES (?,?,?,?,?,?)', projectId, slug, name, String(description).slice(0, 20000), is_demo ? 1 : 0, now());
    return this.project(projectId);
  }
  updateProject(ref, input) {
    const p = this.project(ref);
    this.exec('UPDATE projects SET name=?,description=? WHERE id=?', nameOf(input.name ?? p.name), String(input.description ?? p.description).slice(0, 20000), p.id);
    return this.project(p.id);
  }
  collections(projectRef) {
    const p = this.project(projectRef);
    const rows = this.all('SELECT * FROM collections WHERE project_id=? ORDER BY created_at,name', p.id);
    const getPath = (c, seen = new Set()) => {
      if (!c || seen.has(c.id)) return ''; seen.add(c.id);
      const parent = rows.find(r => r.id === c.parent_id);
      return parent ? `${getPath(parent, seen)}/${c.name}` : c.name;
    };
    return rows.map(c => ({ ...c, path: getPath(c) }));
  }
  collection(projectRef, ref, create = false) {
    assert(typeof ref === 'string' && ref.trim().length > 0, '请提供有效的分类标识或路径');
    const p = this.project(projectRef);
    const direct = this.one('SELECT * FROM collections WHERE id=? AND project_id=?', ref, p.id);
    if (direct) return direct;
    assert(!String(ref).startsWith('col_'), '分类不存在或属于其他项目', 404, 'NOT_FOUND');
    const parts = String(ref).split('/').map(s => s.trim());
    assert(parts.length <= 12 && parts.every(s => s.length > 0 && s.length <= 100), '分类路径须为最多 12 层的有效名称');
    let parent = null, found;
    for (const part of parts) {
      found = this.one('SELECT * FROM collections WHERE project_id=? AND parent_id IS ? AND name=?', p.id, parent, part);
      if (!found && create) {
        const collectionId = id('col');
        this.exec('INSERT INTO collections VALUES (?,?,?,?,?)', collectionId, p.id, parent, part, now());
        found = this.one('SELECT * FROM collections WHERE id=?', collectionId);
      }
      assert(found, `分类不存在：${ref}`, 404, 'NOT_FOUND'); parent = found.id;
    }
    return found;
  }
  createCollection(projectRef, input) {
    return this.tx(() => {
      const name = nameOf(input.name, '分类名称'); assert(!name.includes('/'), '分类名称不能包含 /');
      const parent = input.parent_id ? this.collection(projectRef, input.parent_id) : null;
      const fullPath = parent ? `${this.collections(projectRef).find(c => c.id === parent.id).path}/${name}` : name;
      return this.collection(projectRef, fullPath, true);
    });
  }
  updateCollection(projectRef, ref, input) {
    const c = this.collection(projectRef, ref); const name = nameOf(input.name);
    assert(!name.includes('/'), '分类名称不能包含 /');
    assert(!this.one('SELECT id FROM collections WHERE project_id=? AND parent_id IS ? AND name=? AND id<>?', c.project_id, c.parent_id, name, c.id), '同层分类名称已存在', 409, 'CONFLICT');
    this.exec('UPDATE collections SET name=? WHERE id=?', name, c.id); return this.collection(projectRef, c.id);
  }
  deleteCollection(projectRef, ref) { const c = this.collection(projectRef, ref); this.exec('DELETE FROM collections WHERE id=?', c.id); return { removed: c.id, items_preserved: true }; }
  itemRaw(itemId) { assert(typeof itemId === 'string' && itemId.length > 0, '请提供有效的条目标识'); const i = this.one('SELECT * FROM items WHERE id=?', itemId); assert(i, '资料条目不存在', 404, 'NOT_FOUND'); return i; }
  current(itemId) {
    const item = this.itemRaw(itemId);
    const version = this.one('SELECT * FROM versions WHERE item_id=? AND number=?', itemId, item.current_version);
    assert(version, '文件版本不存在', 404, 'NOT_FOUND'); return version;
  }
  item(itemId) {
    const row = this.itemRaw(itemId), v = this.current(itemId);
    const collectionIds = this.all(`SELECT collection_id FROM memberships WHERE item_id=? UNION SELECT gc.collection_id FROM group_collections gc JOIN group_members gm ON gm.group_id=gc.group_id WHERE gm.item_id=?`, itemId, itemId).map(c => c.collection_id);
    const directCollectionIds = this.all('SELECT collection_id FROM memberships WHERE item_id=?', itemId).map(c => c.collection_id);
    const sources = this.all(`SELECT s.*,i.title,i.current_version,i.deleted_at FROM sources s JOIN items i ON s.source_item_id=i.id WHERE s.item_id=?`, itemId).map(s => ({ ...s, stale: s.source_version !== s.current_version }));
    return { ...row, metadata: parse(row.metadata), original_name: v.original_name, size: v.size, mime: v.mime, sha256: v.sha256, preview: parse(v.preview), collectionIds, directCollectionIds, sources };
  }
  items(projectRef, { trash = false, role, collection, query } = {}) {
    const p = this.project(projectRef);
    let rows = this.all('SELECT id FROM items WHERE project_id=? AND deleted_at IS ' + (trash ? 'NOT NULL' : 'NULL') + ' ORDER BY created_at DESC,id', p.id).map(r => this.item(r.id));
    if (role) rows = rows.filter(i => i.role === role);
    if (collection) { const c = this.collection(p.id, collection); rows = rows.filter(i => i.collectionIds.includes(c.id)); }
    if (query) { const q = String(query).toLowerCase(); rows = rows.filter(i => `${i.title} ${i.original_name} ${i.description}`.toLowerCase().includes(q)); }
    return rows;
  }
  group(groupId) {
    assert(typeof groupId === 'string' && groupId.length > 0, '请提供有效的组合标识');
    const g = this.one('SELECT * FROM groups WHERE id=?', groupId); assert(g, '组合不存在', 404, 'NOT_FOUND');
    const members = this.all('SELECT i.id,i.deleted_at FROM group_members gm JOIN items i ON i.id=gm.item_id WHERE gm.group_id=? ORDER BY gm.position', g.id);
    return { ...g, memberIds: members.filter(m => !m.deleted_at).map(m => m.id), allMemberIds: members.map(m => m.id), collectionIds: this.all('SELECT collection_id FROM group_collections WHERE group_id=?', g.id).map(c => c.collection_id) };
  }
  groups(projectRef) { return this.all('SELECT id FROM groups WHERE project_id=? ORDER BY created_at', this.project(projectRef).id).map(g => this.group(g.id)); }
  target(projectRef, targetId) {
    const p = this.project(projectRef);
    const group = this.one('SELECT id FROM groups WHERE id=? AND project_id=?', targetId, p.id);
    if (group) return { type: 'group', value: this.group(targetId) };
    const item = this.itemRaw(targetId); assert(item.project_id === p.id, '资料属于其他项目', 409, 'CROSS_PROJECT');
    return { type: 'item', value: this.item(targetId) };
  }
  addMembership(projectRef, targetId, collectionRef) {
    return this.tx(() => {
      const target = this.target(projectRef, targetId), c = this.collection(projectRef, collectionRef, true);
      if (target.type === 'group') this.exec('INSERT OR IGNORE INTO group_collections VALUES (?,?)', targetId, c.id);
      else this.exec('INSERT OR IGNORE INTO memberships VALUES (?,?)', c.id, targetId);
      return { target_id: targetId, collection_id: c.id };
    });
  }
  removeMembership(projectRef, targetId, collectionRef) {
    const t = this.target(projectRef, targetId), c = this.collection(projectRef, collectionRef);
    if (t.type === 'group') this.exec('DELETE FROM group_collections WHERE group_id=? AND collection_id=?', targetId, c.id);
    else {
      const inherited = this.one('SELECT gm.item_id FROM group_members gm JOIN group_collections gc ON gc.group_id=gm.group_id WHERE gm.item_id=? AND gc.collection_id=?', targetId, c.id);
      assert(!inherited, '该分类来自结果组合，请对组合执行移除，或先将此资料移出组合', 409, 'INHERITED_MEMBERSHIP');
      this.exec('DELETE FROM memberships WHERE item_id=? AND collection_id=?', targetId, c.id);
    }
    return { target_id: targetId, collection_id: c.id, item_preserved: true };
  }
  createGroup(projectRef, input) {
    return this.tx(() => {
      const p = this.project(projectRef), title = nameOf(input.title), members = [...new Set(input.members || [])];
      assert(members.length >= 2 && members.length <= 200, '组合须包含 2–200 份资料');
      for (const m of members) { const i = this.itemRaw(m); assert(i.project_id === p.id && !i.deleted_at && i.role === 'result', '组合成员须为当前项目中未删除的结果资料', 409, 'INVALID_MEMBER'); }
      const primary = input.primary || members[0]; assert(members.includes(primary), '主预览须属于组合');
      const groupId = id('grp'); this.exec('INSERT INTO groups VALUES (?,?,?,?,?)', groupId, p.id, title, primary, now());
      members.forEach((m, index) => this.exec('INSERT INTO group_members VALUES (?,?,?)', groupId, m, index));
      for (const c of input.collections || []) this.addMembership(p.id, groupId, c);
      return this.group(groupId);
    });
  }
  updateGroup(projectRef, groupId, input) {
    const g = this.group(groupId); assert(g.project_id === this.project(projectRef).id, '组合属于其他项目', 409, 'CROSS_PROJECT');
    const primary = input.primary || (g.memberIds.includes(g.primary_item_id) ? g.primary_item_id : g.memberIds[0]); assert(g.memberIds.includes(primary), '主预览须为未删除的组合成员');
    this.exec('UPDATE groups SET title=?,primary_item_id=? WHERE id=?', nameOf(input.title ?? g.title), primary, groupId); return this.group(groupId);
  }
  dissolveGroup(projectRef, groupId) {
    return this.tx(() => {
      const g = this.group(groupId); assert(g.project_id === this.project(projectRef).id, '组合属于其他项目', 409, 'CROSS_PROJECT');
      // Preserve collection visibility when the optional presentation layer is removed.
      for (const c of g.collectionIds) for (const m of g.allMemberIds) this.exec('INSERT OR IGNORE INTO memberships VALUES (?,?)', c, m);
      this.exec('DELETE FROM groups WHERE id=?', groupId);
      return { dissolved: groupId, items_preserved: g.allMemberIds };
    });
  }
  removeGroupMember(projectRef, groupId, itemId) {
    return this.tx(() => {
      const g = this.group(groupId); assert(g.project_id === this.project(projectRef).id && g.allMemberIds.includes(itemId), '组合成员不存在', 404, 'NOT_FOUND');
      for (const c of g.collectionIds) this.exec('INSERT OR IGNORE INTO memberships VALUES (?,?)', c, itemId);
      if (g.allMemberIds.length <= 2) return this.dissolveGroup(projectRef, groupId);
      this.exec('DELETE FROM group_members WHERE group_id=? AND item_id=?', groupId, itemId);
      if (g.primary_item_id === itemId) this.exec('UPDATE groups SET primary_item_id=? WHERE id=?', g.memberIds.find(m => m !== itemId) || g.allMemberIds.find(m => m !== itemId), groupId);
      return this.group(groupId);
    });
  }
  setSources(itemId, sourceIds) {
    const item = this.itemRaw(itemId); assert(Array.isArray(sourceIds) && sourceIds.length <= 200, '来源列表无效');
    return this.tx(() => {
      this.exec('DELETE FROM sources WHERE item_id=?', itemId);
      for (const sourceId of new Set(sourceIds)) {
        const source = this.itemRaw(sourceId);
        assert(source.project_id === item.project_id && !source.deleted_at, '来源须为同项目中未删除的资料', 409, 'CROSS_PROJECT');
        assert(sourceId !== itemId, '资料不能以自身为来源', 409, 'SOURCE_CYCLE');
        const reachable = this.all(`WITH RECURSIVE chain(id) AS (SELECT source_item_id FROM sources WHERE item_id=? UNION SELECT s.source_item_id FROM sources s JOIN chain c ON s.item_id=c.id) SELECT id FROM chain`, sourceId);
        assert(!reachable.some(r => r.id === itemId), '来源关系不能形成循环', 409, 'SOURCE_CYCLE');
        this.exec('INSERT INTO sources VALUES (?,?,?)', itemId, sourceId, source.current_version);
      }
      return this.item(itemId);
    });
  }
  updateItem(itemId, input) {
    const item = this.itemRaw(itemId); assert(!item.deleted_at, '请先恢复回收站中的资料', 409, 'ITEM_TRASHED');
    const role = input.role ?? item.role; assert(['result', 'supporting'].includes(role), '用途无效');
    if (role === 'supporting') assert(!this.one('SELECT group_id FROM group_members WHERE item_id=?', itemId), '请先将资料移出组合，再改为辅助资料');
    this.exec('UPDATE items SET title=?,description=?,role=?,occurred_at=?,updated_at=? WHERE id=?', nameOf(input.title ?? item.title), String(input.description ?? item.description).slice(0, 100000), role, dateOf(input.occurred_at, item.occurred_at), now(), itemId);
    return this.item(itemId);
  }
  trashItems(projectRef, ids, restore = false) {
    assert(Array.isArray(ids) && ids.length > 0 && ids.length <= 1000, '请选择资料条目');
    return this.tx(() => {
      const p = this.project(projectRef);
      for (const itemId of ids) { const item = this.itemRaw(itemId); assert(item.project_id === p.id, '资料属于其他项目', 409, 'CROSS_PROJECT'); }
      for (const itemId of ids) this.exec('UPDATE items SET deleted_at=?,updated_at=? WHERE id=?', restore ? null : now(), now(), itemId);
      return { ids, restored: restore, references_preserved: true };
    });
  }
  createRun(projectRef, input = {}) {
    const p = this.project(projectRef);
    if (input.id) { const run = this.one('SELECT * FROM runs WHERE id=?', input.id); assert(run && run.project_id === p.id, '运行记录不存在或属于其他项目', 404, 'NOT_FOUND'); return run; }
    const runId = id('run'), time = dateOf(input.occurred_at);
    this.exec('INSERT INTO runs VALUES (?,?,?,?,?,?)', runId, p.id, nameOf(input.title || `导入记录 ${time.slice(0, 16).replace('T', ' ')}`), time, String(input.command || '').slice(0, 20000), now());
    return this.one('SELECT * FROM runs WHERE id=?', runId);
  }
  runs(projectRef) {
    return this.all('SELECT * FROM runs WHERE project_id=? ORDER BY occurred_at DESC', this.project(projectRef).id).map(r => ({ ...r, itemIds: this.all('SELECT id FROM items WHERE run_id=? AND deleted_at IS NULL ORDER BY role,title', r.id).map(i => i.id) }));
  }
  insertVersion(itemId, number, file) {
    this.exec('INSERT INTO versions VALUES (?,?,?,?,?,?,?,?,?,?)', id('ver'), itemId, number, file.objectKey, file.sha256, file.size, file.originalName, file.mime, json(file.preview), now());
  }
  async importManifest(projectRef, input, { baseDir = process.cwd(), dryRun = false } = {}) {
    const p = this.project(projectRef);
    let manifest;
    try { manifest = manifestSchema.parse(input); } catch (e) { throw new AppError('导入清单格式不正确', 422, 'INVALID_MANIFEST', e.issues); }
    const keys = [...manifest.items.map(i => i.key), ...manifest.groups.map(g => g.key)];
    assert(new Set(keys).size === keys.length, '清单中的 key 不能重复', 422, 'DUPLICATE_KEY');
    const prepared = [], errors = []; let total = 0;
    for (const entry of manifest.items) {
      try {
        const source = path.resolve(baseDir, entry.path), stat = await fs.stat(source);
        assert(stat.isFile() && stat.size <= MAX_FILE, '文件不存在、不是普通文件或超过 100 MB');
        total += stat.size; assert(total <= 500 * 1024 * 1024, '每批最多支持 500 MB');
        const buffer = await fs.readFile(source), filename = entry.filename || path.basename(source);
        const role = entry.role || roleOf(filename); dateOf(entry.occurred_at);
        for (const c of entry.collections) this.validateCollectionRef(p.id, c);
        prepared.push({ ...entry, filename, buffer, hash: sha(buffer), role });
      } catch (e) { errors.push({ key: entry.key, message: e.code === 'ENOENT' ? '文件不存在' : e.message }); }
    }
    if (manifest.run?.occurred_at) dateOf(manifest.run.occurred_at);
    if (manifest.run?.id) { const r = this.one('SELECT * FROM runs WHERE id=? AND project_id=?', manifest.run.id, p.id); assert(r, '运行记录不存在或属于其他项目'); }
    const itemKeys = new Set(manifest.items.map(i => i.key));
    const validateRef = ref => {
      if (itemKeys.has(ref)) return;
      const i = this.itemRaw(ref); assert(i.project_id === p.id && !i.deleted_at, '引用资料不存在或属于其他项目', 409, 'CROSS_PROJECT');
    };
    for (const entry of manifest.items) for (const source of entry.derived_from) { try { validateRef(source); assert(source !== entry.key, '资料不能以自身为来源'); } catch (e) { errors.push({ key: entry.key, message: e.message }); } }
    for (const group of manifest.groups) {
      try {
        assert(new Set(group.members).size >= 2, '组合须包含至少两份不同资料');
        for (const m of group.members) {
          validateRef(m); const role = prepared.find(i => i.key === m)?.role ?? this.itemRaw(m).role;
          assert(role === 'result', '辅助资料不能作为结果组合成员');
        }
        assert(!group.primary || group.members.includes(group.primary), '主预览不属于组合');
        for (const c of group.collections) this.validateCollectionRef(p.id, c);
      } catch (e) { errors.push({ key: group.key, message: e.message }); }
    }
    // Validate both incoming and existing provenance edges before any persistent writes.
    const graph = new Map();
    for (const e of this.all('SELECT s.item_id,s.source_item_id FROM sources s JOIN items i ON i.id=s.item_id WHERE i.project_id=?', p.id)) graph.set(e.item_id, [...(graph.get(e.item_id) || []), e.source_item_id]);
    for (const entry of manifest.items) graph.set(entry.key, entry.derived_from);
    const visiting = new Set(), visited = new Set();
    const walk = key => { if (visiting.has(key)) throw new AppError('来源关系不能形成循环', 422, 'SOURCE_CYCLE'); if (visited.has(key)) return; visiting.add(key); for (const s of graph.get(key) || []) walk(s); visiting.delete(key); visited.add(key); };
    for (const key of graph.keys()) walk(key);
    if (errors.length) throw new AppError('导入预检失败，未创建任何条目', 422, 'PREFLIGHT_FAILED', errors);
    const fingerprint = sha(json({ manifest, files: prepared.map(f => ({ key: f.key, hash: f.hash })) }));
    const existing = this.one('SELECT * FROM imports WHERE project_id=? AND import_key=?', p.id, manifest.import_key);
    if (existing) {
      assert(existing.fingerprint === fingerprint, '导入标识已用于其他内容，请使用新的 import_key', 409, 'IDEMPOTENCY_CONFLICT');
      return { ...parse(existing.result), replayed: true, ...(dryRun ? { dry_run: true, valid: true } : {}) };
    }
    if (dryRun) return { valid: true, dry_run: true, project_id: p.id, import_key: manifest.import_key, items: prepared.map(f => ({ key: f.key, filename: f.filename, size: f.buffer.length, role: f.role, kind: kindOf(f.filename) })), groups: manifest.groups.length };
    const files = [];
    for (const f of prepared) files.push(await stageBuffer(this.home, f.buffer, f.filename));
    return this.tx(() => {
      const check = this.one('SELECT * FROM imports WHERE project_id=? AND import_key=?', p.id, manifest.import_key);
      if (check) { assert(check.fingerprint === fingerprint, '导入标识冲突', 409, 'IDEMPOTENCY_CONFLICT'); return { ...parse(check.result), replayed: true }; }
      const mapping = {}, results = [], groupResults = [];
      const run = manifest.run || prepared.some(f => f.role === 'supporting') ? this.createRun(p.id, manifest.run || {}) : null;
      for (let index = 0; index < prepared.length; index++) {
        const f = prepared[index], file = files[index], itemId = id('itm'), time = now(); mapping[f.key] = itemId;
        this.exec('INSERT INTO items (id,project_id,title,kind,role,description,occurred_at,created_at,updated_at,run_id,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?)', itemId, p.id, nameOf(f.title || f.filename), file.kind, f.role, f.description, dateOf(f.occurred_at, run?.occurred_at || time), time, time, run?.id || null, json(f.metadata));
        this.insertVersion(itemId, 1, file);
        for (const c of f.collections) this.addMembership(p.id, itemId, c);
        results.push({ key: f.key, id: itemId, status: 'created', version: 1, preview_status: file.preview.status, ...(file.preview.warning ? { warning: file.preview.warning } : {}) });
      }
      for (const f of prepared) if (f.derived_from.length) this.setSources(mapping[f.key], f.derived_from.map(s => mapping[s] || s));
      for (const g of manifest.groups) {
        const group = this.createGroup(p.id, { title: g.title, members: g.members.map(m => mapping[m] || m), primary: g.primary ? mapping[g.primary] || g.primary : undefined, collections: g.collections });
        groupResults.push({ key: g.key, id: group.id, status: 'created' });
      }
      const result = { project_id: p.id, import_key: manifest.import_key, replayed: false, items: results, groups: groupResults, run_id: run?.id || null };
      this.exec('INSERT INTO imports VALUES (?,?,?,?,?)', p.id, manifest.import_key, fingerprint, json(result), now()); return result;
    });
  }
  validateCollectionRef(projectRef, ref) {
    if (ref.startsWith('col_')) return this.collection(projectRef, ref);
    const parts = ref.split('/').map(s => s.trim()); assert(parts.length <= 12 && parts.every(s => s.length > 0 && s.length <= 100), '分类路径无效');
  }
  async addFile(projectRef, filePath, options = {}) {
    return this.importManifest(projectRef, { import_key: options.import_key || id('import'), items: [{ key: 'file', path: filePath, ...(options.title ? { title: options.title } : {}), ...(options.role ? { role: options.role } : {}), collections: options.collections || [], derived_from: options.derived_from || [], description: options.description || '' }], ...(options.run ? { run: options.run } : {}) }, options);
  }
  versions(itemId) { this.itemRaw(itemId); return this.all('SELECT id,number,size,sha256,original_name,created_at FROM versions WHERE item_id=? ORDER BY number DESC', itemId); }
  async newVersion(itemId, file, expectedVersion) {
    return this.tx(() => {
      const i = this.itemRaw(itemId); assert(!i.deleted_at, '请先恢复资料', 409, 'ITEM_TRASHED');
      assert(Number.isInteger(expectedVersion) && i.current_version === expectedVersion, '资料已更新，请重新载入后再保存', 409, 'VERSION_CONFLICT');
      assert(file.kind === i.kind, '新版本须保持相同的资料类型');
      if (file.sha256 === this.current(itemId).sha256) return this.item(itemId);
      this.insertVersion(itemId, i.current_version + 1, file);
      this.exec('UPDATE items SET current_version=?,updated_at=? WHERE id=?', i.current_version + 1, now(), itemId);
      return this.item(itemId);
    });
  }
  async replaceFile(itemId, filePath, expectedVersion) { const v = this.current(itemId); return this.newVersion(itemId, await stageFile(this.home, filePath, v.original_name), expectedVersion); }
  async editTable(itemId, changes, expectedVersion) {
    const i = this.itemRaw(itemId); assert(i.kind === 'table', '该资料不是表格');
    assert(i.current_version === expectedVersion, '资料已更新，请重新载入后再保存', 409, 'VERSION_CONFLICT');
    const file = await patchedTable(this.home, this.current(itemId), changes); return this.newVersion(itemId, file, expectedVersion);
  }
  async editText(itemId, content, expectedVersion) {
    const i = this.itemRaw(itemId), v = this.current(itemId); assert(i.kind === 'text', '该资料不是文本');
    assert(typeof content === 'string' && Buffer.byteLength(content) <= 2 * 1024 * 1024, '文本编辑最大支持 2 MB');
    return this.newVersion(itemId, await stageBuffer(this.home, Buffer.from(content), v.original_name), expectedVersion);
  }
  async restoreVersion(itemId, number, expectedVersion) {
    const version = this.one('SELECT * FROM versions WHERE item_id=? AND number=?', itemId, Number(number)); assert(version, '历史版本不存在', 404, 'NOT_FOUND');
    const i = this.itemRaw(itemId);
    return this.newVersion(itemId, { objectKey: version.object_key, sha256: version.sha256, size: version.size, originalName: version.original_name, mime: version.mime, kind: i.kind, preview: parse(version.preview) }, expectedVersion);
  }
  async table(itemId, options = {}) {
    const i = this.itemRaw(itemId); assert(i.kind === 'table', '资料不是表格'); const v = this.current(itemId);
    const { sheet = 0, offset = 0, limit = 100, colOffset = 0, colLimit = 60 } = options;
    for (const n of [sheet, offset, limit, colOffset, colLimit]) assert(Number.isInteger(n) && n >= 0, '分页参数无效');
    assert(limit > 0 && limit <= 200 && colLimit > 0 && colLimit <= 100, '分页大小超出范围');
    const result = tableSlice(await readTable(path.join(this.home, 'objects', v.object_key), v.original_name), sheet, offset, limit, colOffset, colLimit);
    return { ...result, version: v.number };
  }
  async text(itemId) {
    const i = this.itemRaw(itemId), v = this.current(itemId); assert(i.kind === 'text', '资料不是文本');
    const file = await fs.open(path.join(this.home, 'objects', v.object_key), 'r');
    try {
      const buffer = Buffer.alloc(Math.min(v.size, 2 * 1024 * 1024)); await file.read(buffer, 0, buffer.length, 0);
      return { content: buffer.toString('utf8'), truncated: v.size > buffer.length, version: v.number };
    } finally { await file.close(); }
  }
  layout(projectRef, viewKey) {
    const p = this.project(projectRef); this.validateView(p.id, viewKey);
    return { positions: this.all('SELECT target_id,x,y,width FROM layouts WHERE project_id=? AND view_key=?', p.id, viewKey), viewport: this.one('SELECT x,y,zoom FROM viewports WHERE project_id=? AND view_key=?', p.id, viewKey) || { x: 52, y: 44, zoom: 0.85 } };
  }
  validateView(projectRef, key) {
    assert(typeof key === 'string' && key.length <= 300, '视图标识无效');
    if (key.startsWith('collection:')) this.collection(projectRef, key.slice(11));
    else assert(['all', 'recent'].includes(key), '该视图不支持画布');
  }
  saveLayout(projectRef, viewKey, { positions = [], viewport }) {
    const p = this.project(projectRef); this.validateView(p.id, viewKey); assert(Array.isArray(positions) && positions.length <= 2000, '布局数据无效');
    return this.tx(() => {
      for (const position of positions) {
        this.target(p.id, position.target_id);
        const { x, y, width = 360 } = position; assert([x, y, width].every(Number.isFinite) && Math.abs(x) < 1e7 && Math.abs(y) < 1e7 && width >= 240 && width <= 1200, '布局坐标无效');
        this.exec('INSERT INTO layouts VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,view_key,target_id) DO UPDATE SET x=excluded.x,y=excluded.y,width=excluded.width', p.id, viewKey, position.target_id, x, y, width);
      }
      if (viewport) {
        assert([viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) && viewport.zoom >= 0.15 && viewport.zoom <= 2.5, '缩放参数无效');
        this.exec('INSERT INTO viewports VALUES (?,?,?,?,?) ON CONFLICT(project_id,view_key) DO UPDATE SET x=excluded.x,y=excluded.y,zoom=excluded.zoom', p.id, viewKey, viewport.x, viewport.y, viewport.zoom);
      }
      return this.layout(p.id, viewKey);
    });
  }
  snapshot(projectRef) {
    const p = this.project(projectRef);
    return { project: p, collections: this.collections(p.id), items: this.items(p.id), trash: this.items(p.id, { trash: true }), groups: this.groups(p.id), runs: this.runs(p.id) };
  }
}
