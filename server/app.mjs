import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { stringify } from 'csv-stringify/sync';
import { Store, manifestSchema } from './store.mjs';
import { assert, AppError } from './errors.mjs';
import { MAX_FILE, roleOf } from './files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
const integer = (value, fallback) => value == null ? fallback : Number(value);
export function createApp({ home, store = new Store(home), staticDir = path.join(root, 'dist') } = {}) {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return next(new AppError('只允许本机访问', 403, 'LOCAL_ONLY'));
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !['http:', 'https:'].includes(origin.protocol)) throw new Error();
      } catch { return next(new AppError('请求来源不受支持', 403, 'ORIGIN_BLOCKED')); }
    }
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; font-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'" });
    next();
  });
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', (req, _res, next) => { if (!req.body) req.body = {}; next(); });
  const upload = multer({ dest: path.join(store.home, 'tmp'), limits: { fileSize: MAX_FILE, files: 200, fields: 20, fieldSize: 1024 * 1024 } });
  app.get('/api', (_req, res) => res.json({ name: 'LabCanvas', version: '1.0.0', schema: '/api/schema/import', documentation: '/api/help', storage: 'local' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '1.0.0' }));
  app.get('/api/info', (_req, res) => res.json({ version: '1.0.0', home: store.home, max_file_bytes: MAX_FILE }));
  app.get('/api/schema/import', (_req, res) => res.json(z.toJSONSchema(manifestSchema)));
  app.get('/api/help', wrap(async (_req, res) => res.type('text/plain').send(await fs.readFile(path.join(root, 'docs', 'AGENT_API.md'), 'utf8'))));
  app.get('/api/projects', (_req, res) => res.json(store.projects()));
  app.post('/api/projects', wrap((req, res) => res.status(201).json(store.createProject(req.body))));
  app.patch('/api/projects/:p', wrap((req, res) => res.json(store.updateProject(req.params.p, req.body))));
  app.get('/api/projects/:p/snapshot', wrap((req, res) => res.json(store.snapshot(req.params.p))));
  app.get('/api/projects/:p/collections', wrap((req, res) => res.json(store.collections(req.params.p))));
  app.post('/api/projects/:p/collections', wrap((req, res) => res.status(201).json(store.createCollection(req.params.p, req.body))));
  app.patch('/api/projects/:p/collections/:id', wrap((req, res) => res.json(store.updateCollection(req.params.p, req.params.id, req.body))));
  app.delete('/api/projects/:p/collections/:id', wrap((req, res) => res.json(store.deleteCollection(req.params.p, req.params.id))));
  app.put('/api/projects/:p/memberships', wrap((req, res) => res.json(store.addMembership(req.params.p, req.body.target_id, req.body.collection_id))));
  app.delete('/api/projects/:p/memberships', wrap((req, res) => res.json(store.removeMembership(req.params.p, req.body.target_id, req.body.collection_id))));
  app.get('/api/projects/:p/items', wrap((req, res) => res.json(store.items(req.params.p, { trash: req.query.trash === 'true', role: req.query.role, collection: req.query.collection, query: req.query.q }))));
  app.get('/api/items/:id', wrap((req, res) => res.json(store.item(req.params.id))));
  app.patch('/api/items/:id', wrap((req, res) => res.json(store.updateItem(req.params.id, req.body))));
  app.put('/api/items/:id/sources', wrap((req, res) => res.json(store.setSources(req.params.id, req.body.sources))));
  app.post('/api/projects/:p/trash', wrap((req, res) => res.json(store.trashItems(req.params.p, req.body.ids))));
  app.post('/api/projects/:p/restore', wrap((req, res) => res.json(store.trashItems(req.params.p, req.body.ids, true))));
  app.get('/api/projects/:p/groups', wrap((req, res) => res.json(store.groups(req.params.p))));
  app.post('/api/projects/:p/groups', wrap((req, res) => res.status(201).json(store.createGroup(req.params.p, req.body))));
  app.patch('/api/projects/:p/groups/:id', wrap((req, res) => res.json(store.updateGroup(req.params.p, req.params.id, req.body))));
  app.delete('/api/projects/:p/groups/:id', wrap((req, res) => res.json(store.dissolveGroup(req.params.p, req.params.id))));
  app.delete('/api/projects/:p/groups/:id/members/:item', wrap((req, res) => res.json(store.removeGroupMember(req.params.p, req.params.id, req.params.item))));
  app.get('/api/projects/:p/runs', wrap((req, res) => res.json(store.runs(req.params.p))));
  app.get('/api/projects/:p/layout', wrap((req, res) => res.json(store.layout(req.params.p, String(req.query.view || 'all')))));
  app.put('/api/projects/:p/layout', wrap((req, res) => res.json(store.saveLayout(req.params.p, String(req.query.view || 'all'), req.body))));
  app.post('/api/projects/:p/import', wrap(async (req, res) => res.json(await store.importManifest(req.params.p, req.body.manifest || req.body, { baseDir: req.body.base_dir || process.cwd(), dryRun: req.query.dry_run === 'true' }))));
  app.post('/api/projects/:p/uploads', upload.array('files'), wrap(async (req, res) => {
    const files = req.files || [];
    try {
      assert(files.length > 0, '请选择文件');
      const roles = JSON.parse(req.body.roles || '[]'), collections = JSON.parse(req.body.collections || '[]');
      const manifest = { import_key: req.body.import_key || `gui-${randomUUID()}`, items: files.map((f, index) => ({ key: `file-${index}`, path: f.path, filename: Buffer.from(f.originalname, 'latin1').toString('utf8'), role: roles[index] || roleOf(f.originalname), collections })), ...(req.body.run ? { run: JSON.parse(req.body.run) } : {}) };
      res.status(201).json(await store.importManifest(req.params.p, manifest));
    } finally { await Promise.all(files.map(f => fs.unlink(f.path).catch(() => {}))); }
  }));
  app.post('/api/projects/:p/tables', wrap(async (req, res) => {
    const name = String(req.body.name || '未命名表格').trim();
    const rowCount = integer(req.body.rows, 10), columns = integer(req.body.columns, 5);
    assert(Number.isInteger(rowCount) && rowCount >= 1 && rowCount <= 1000 && Number.isInteger(columns) && columns >= 1 && columns <= 100, '初始表格支持 1–1000 行、1–100 列');
    const temp = path.join(store.home, 'tmp', `${randomUUID()}.csv`);
    await fs.writeFile(temp, stringify(Array.from({ length: rowCount }, (_, r) => Array.from({ length: columns }, (_, c) => r === 0 ? `列 ${c + 1}` : ''))));
    try {
      const result = await store.importManifest(req.params.p, { import_key: `table-${randomUUID()}`, items: [{ key: 'table', path: temp, filename: `${name.replace(/\.csv$/i, '')}.csv`, title: name, collections: req.body.collections || [] }] });
      res.status(201).json(result);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }));
  app.get('/api/items/:id/table', wrap(async (req, res) => res.json(await store.table(req.params.id, { sheet: integer(req.query.sheet, 0), offset: integer(req.query.offset, 0), limit: integer(req.query.limit, 100), colOffset: integer(req.query.col_offset, 0), colLimit: integer(req.query.col_limit, 60) }))));
  app.patch('/api/items/:id/table', wrap(async (req, res) => res.json(await store.editTable(req.params.id, req.body.changes, req.body.expected_version))));
  app.get('/api/items/:id/text', wrap(async (req, res) => res.json(await store.text(req.params.id))));
  app.patch('/api/items/:id/text', wrap(async (req, res) => res.json(await store.editText(req.params.id, req.body.content, req.body.expected_version))));
  app.get('/api/items/:id/versions', wrap((req, res) => res.json(store.versions(req.params.id))));
  app.post('/api/items/:id/versions/:version/restore', wrap(async (req, res) => res.json(await store.restoreVersion(req.params.id, Number(req.params.version), req.body.expected_version))));
  app.get('/api/items/:id/file', wrap((req, res) => {
    const current = store.current(req.params.id);
    const version = req.query.version ? store.one('SELECT * FROM versions WHERE item_id=? AND number=?', req.params.id, Number(req.query.version)) : current;
    assert(version, '文件版本不存在', 404, 'NOT_FOUND');
    res.set({ 'Content-Type': version.mime, 'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="download"; filename*=UTF-8''${encodeURIComponent(version.original_name)}`, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    res.sendFile(path.join(store.home, 'objects', version.object_key), { dotfiles: 'allow' });
  }));
  app.get('/api/items/:id/preview', wrap((req, res) => {
    const v = store.current(req.params.id), preview = JSON.parse(v.preview); assert(preview.image, '没有图片预览', 404, 'NO_PREVIEW');
    res.type('png').sendFile(path.join(store.home, 'previews', preview.image), { dotfiles: 'allow' });
  }));
  app.use('/api', (_req, _res, next) => next(new AppError('接口不存在', 404, 'NOT_FOUND')));
  app.use(express.static(staticDir, { index: 'index.html', dotfiles: 'deny' }));
  app.get('/{*path}', (_req, res, next) => res.sendFile(path.join(staticDir, 'index.html'), error => error && next(error)));
  app.use((err, req, res, _next) => {
    if (req.files) for (const f of req.files) fs.unlink(f.path).catch(() => {});
    const status = err.status || (err instanceof multer.MulterError ? 413 : err instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: { code: err.code || (status === 500 ? 'INTERNAL_ERROR' : 'INVALID_INPUT'), message: status === 500 ? '操作失败，请查看服务日志' : err.message, ...(err.details ? { details: err.details } : {}) } });
  });
  return { app, store };
}
