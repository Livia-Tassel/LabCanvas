import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import { promises as fs, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { assert, AppError } from './errors.mjs';
import { MAX_FILE } from './files.mjs';
import { MAX_ARCHIVE, writeZip } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;
const CSP = [
  "default-src 'self'", "img-src 'self' data: blob:", "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval'", "font-src 'self' blob: data:", "worker-src 'self' blob:",
  "connect-src 'self'", "frame-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"
].join('; ');

const wrap = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
const optionalInt = value => (value == null || value === '' ? undefined : Number(value));

export function createApp({ home, store = new Store(home), staticDir = path.join(root, 'dist') } = {}) {
  const app = express();
  app.disable('x-powered-by');

  // The server is a private backend for the desktop window: loopback only, same-origin only.
  app.use((req, res, next) => {
    if (!LOCAL_HOST.test(req.headers.host || '')) return next(new AppError('只允许本机访问', 403, 'LOCAL_ONLY'));
    if (req.headers.origin) {
      let hostname = '';
      try { hostname = new URL(req.headers.origin).hostname; } catch { /* rejected below */ }
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return next(new AppError('请求来源不受支持', 403, 'ORIGIN_BLOCKED'));
    }
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP
    });
    next();
  });
  app.use(express.json({ limit: '32mb' }));

  // ------------------------------------------------------------ live updates
  const listeners = new Set();
  const broadcast = () => {
    for (const res of listeners) res.write('event: change\ndata: {}\n\n');
  };
  let dataVersion = store.dataVersion();
  const watcher = setInterval(() => {
    try {
      const current = store.dataVersion();
      if (current !== dataVersion) {
        dataVersion = current;
        broadcast();
      }
    } catch { /* the store is closing */ }
  }, 700);
  watcher.unref();
  app.use((req, res, next) => {
    // Canvas arrangement is private to the window that changes it; other views need not reload.
    const quiet = req.method === 'GET' || req.path.endsWith('/layout') || req.path.includes('/annotations');
    if (!quiet) res.on('finish', () => { if (res.statusCode < 400) broadcast(); });
    next();
  });

  const upload = multer({
    storage: multer.diskStorage({ destination: path.join(store.home, 'tmp') }),
    limits: { fileSize: MAX_FILE, files: 200 }
  });
  // Multipart filenames arrive as latin1 bytes; restore the UTF-8 name and always clean up the temp copy.
  const uploaded = handler => [upload.array('files', 200), wrap(async (req, res) => {
    const files = (req.files || []).map(file => ({
      path: file.path,
      name: Buffer.from(file.originalname, 'latin1').toString('utf8')
    }));
    try {
      await handler(req, res, files, req.body.meta ? JSON.parse(req.body.meta) : {});
    } finally {
      await Promise.all(files.map(file => fs.unlink(file.path).catch(() => {})));
    }
  })];

  // Files imported before the search index existed get their text extracted once, in the background.
  store.reindex().catch(error => console.error(error));

  const api = express.Router();
  api.get('/info', (req, res) => {
    const stamp = new Date();
    const day = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}`;
    res.json({ name: 'LabCanvas', version: VERSION, home: store.home, backup_suggestion: path.join(os.homedir(), `LabCanvas 备份 ${day}`) });
  });
  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 1500\n\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
  });

  api.get('/projects', (req, res) => res.json(store.projects()));
  api.post('/projects', (req, res) => res.status(201).json(store.createProject(req.body)));
  api.patch('/projects/:project', (req, res) => res.json(store.updateProject(req.params.project, req.body)));
  api.delete('/projects/:project', wrap(async (req, res) => res.json(await store.deleteProject(req.params.project))));
  api.get('/projects/:project/snapshot', (req, res) => res.json(store.snapshot(req.params.project)));

  api.get('/projects/:project/search', (req, res) => res.json(store.search(req.params.project, req.query.q, { limit: optionalInt(req.query.limit) })));
  api.get('/projects/:project/export', wrap(async (req, res) => {
    const files = store.exportList(req.params.project, String(req.query.entries || '').split(',').filter(Boolean));
    const total = files.reduce((sum, file) => sum + file.size, 0);
    assert(total <= MAX_ARCHIVE, '导出内容超过 3.9 GB，请分批导出', 413, 'EXPORT_TOO_LARGE');
    const name = files.length ? files[0].name.split('/')[0] : 'LabCanvas';
    const label = new Set(files.map(file => file.name.split('/')[0])).size > 1 ? `${store.project(req.params.project).name} 导出` : name;
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${label}.zip`)}`
    });
    await writeZip(res, files);
    res.end();
  }));
  api.post('/backup', wrap(async (req, res) => res.status(201).json(await store.backup(req.body.target))));
  api.patch('/projects/:project/entries', (req, res) => res.json(store.updateEntries(req.params.project, req.body.entry_ids, req.body.patch)));
  api.post('/projects/:project/collections/sort', (req, res) => res.json(store.sortCollections(req.params.project)));
  api.post('/projects/:project/annotations', (req, res) => res.status(201).json(store.createAnnotation(req.params.project, req.query.view, req.body)));
  api.patch('/annotations/:id', (req, res) => res.json(store.updateAnnotation(req.params.id, req.body)));
  api.delete('/annotations/:id', (req, res) => res.json(store.deleteAnnotation(req.params.id)));

  api.post('/projects/:project/collections', (req, res) => res.status(201).json(store.createCollection(req.params.project, req.body)));
  api.patch('/collections/:id', (req, res) => res.json(store.updateCollection(req.params.id, req.body)));
  api.delete('/collections/:id', (req, res) => res.json(store.deleteCollection(req.params.id)));

  // meta: { mode: 'single' | 'separate', title?, note?, date?, collections? }
  api.post('/projects/:project/entries', ...uploaded(async (req, res, files, meta) => {
    assert(files.length > 0, '请至少提供一个文件');
    const { mode = 'single', ...spec } = meta;
    assert(['single', 'separate'].includes(mode), '导入模式无效');
    const groups = mode === 'separate' ? files.map(file => [file]) : [files];
    const created = await store.createEntries(req.params.project, groups.map(group => ({ ...spec, files: group })));
    res.status(201).json({ entries: created });
  }));
  api.post('/projects/:project/tables', wrap(async (req, res) => res.status(201).json(await store.createTable(req.params.project, req.body))));
  api.post('/projects/:project/memberships', (req, res) => {
    const { entry_ids, collection_id, member = true } = req.body;
    res.json(store.setMembership(req.params.project, entry_ids, collection_id, member));
  });
  api.post('/projects/:project/trash', (req, res) => res.json(store.trash(req.params.project, req.body.entry_ids, true)));
  api.post('/projects/:project/restore', (req, res) => res.json(store.trash(req.params.project, req.body.entry_ids, false)));
  api.post('/projects/:project/purge', wrap(async (req, res) => res.json(await store.purge(req.params.project, req.body.entry_ids))));
  api.post('/projects/:project/empty-trash', wrap(async (req, res) => res.json(await store.emptyTrash(req.params.project))));
  api.post('/projects/:project/merge', (req, res) => res.json(store.merge(req.params.project, req.body.entry_ids, req.body)));
  api.get('/projects/:project/layout', (req, res) => res.json(store.layout(req.params.project, req.query.view)));
  api.put('/projects/:project/layout', (req, res) => res.json(store.saveLayout(req.params.project, req.query.view, req.body)));

  api.get('/entries/:id', (req, res) => res.json(store.entry(req.params.id)));
  api.patch('/entries/:id', (req, res) => res.json(store.updateEntry(req.params.id, req.body)));
  api.post('/entries/:id/files', ...uploaded(async (req, res, files) => {
    res.status(201).json(await store.addFiles(req.params.id, files));
  }));

  api.patch('/files/:id', (req, res) => res.json(store.updateFile(req.params.id, req.body)));
  api.delete('/files/:id', wrap(async (req, res) => res.json(await store.deleteFile(req.params.id))));
  api.post('/files/:id/split', (req, res) => res.status(201).json(store.splitFile(req.params.id)));
  api.post('/files/:id/replace', ...uploaded(async (req, res, files) => {
    assert(files.length === 1, '请提供一个文件');
    res.json(await store.replaceFile(req.params.id, { path: files[0].path }));
  }));
  api.get('/files/:id/raw', (req, res) => {
    const version = store.version(req.params.id, optionalInt(req.query.version));
    res.set({
      'Content-Type': version.mime === 'image/svg+xml' || !req.query.download ? version.mime : 'application/octet-stream',
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(version.name)}`,
      // Uploaded SVG and HTML must never run scripts in the application's origin.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      'Cache-Control': 'private, max-age=31536000, immutable'
    });
    res.sendFile(version.path);
  });
  api.get('/files/:id/thumbnail', (req, res) => {
    const version = store.version(req.params.id, optionalInt(req.query.version));
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(path.join(store.home, 'previews', `${version.sha256}.png`), error => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });
  api.get('/files/:id/table', wrap(async (req, res) => {
    res.json(await store.table(req.params.id, {
      sheet: optionalInt(req.query.sheet) ?? 0,
      offset: optionalInt(req.query.offset) ?? 0,
      limit: optionalInt(req.query.limit),
      version: optionalInt(req.query.version)
    }));
  }));
  api.patch('/files/:id/table', wrap(async (req, res) => {
    res.json(await store.editTable(req.params.id, req.body.operations, req.body.expected_version));
  }));
  api.get('/files/:id/text', wrap(async (req, res) => {
    res.json(await store.text(req.params.id, { version: optionalInt(req.query.version), tail: req.query.tail === '1' }));
  }));
  api.put('/files/:id/text', wrap(async (req, res) => {
    res.json(await store.saveText(req.params.id, req.body.content, req.body.expected_version));
  }));
  api.get('/files/:id/versions', (req, res) => res.json(store.versions(req.params.id)));
  api.post('/files/:id/versions/:number/restore', (req, res) => {
    res.json(store.restoreVersion(req.params.id, Number(req.params.number)));
  });

  api.use((req, res, next) => next(new AppError('接口不存在', 404, 'NOT_FOUND')));
  app.use('/api', api);

  app.use(express.static(staticDir, { index: false, setHeaders: res => res.set('Cache-Control', 'no-cache') }));
  app.get(/.*/, (req, res, next) => res.sendFile(path.join(staticDir, 'index.html'), error => {
    if (error) next(new AppError('界面尚未构建，请先运行 npm run build', 503, 'NOT_BUILT'));
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      error = new AppError(error.code === 'LIMIT_FILE_SIZE' ? '单个文件最大支持 200 MB' : error.message, 413, 'FILE_TOO_LARGE');
    } else if (error instanceof SyntaxError || error.type === 'entity.parse.failed') {
      error = new AppError('请求内容不是有效的 JSON', 400, 'INVALID_JSON');
    }
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: { code: error.code || 'INTERNAL', message: error.message, ...(error.details ? { details: error.details } : {}) } });
  });

  const close = () => {
    clearInterval(watcher);
    for (const res of listeners) res.end();
  };
  return { app, store, close };
}
