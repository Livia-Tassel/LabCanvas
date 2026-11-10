#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { seedDemo } from '../server/demo.mjs';
import { assert } from '../server/errors.mjs';

const HELP = `LabCanvas v1.0.0 — 本机科研资料管理

labcanvas serve [--port 4317] [--no-demo]
labcanvas demo
labcanvas projects list
labcanvas projects create --name NAME [--slug SLUG]
labcanvas projects update --id PROJECT --name NAME
labcanvas collections list --project PROJECT
labcanvas collections create --project PROJECT --name NAME [--parent ID]
labcanvas collections rename|delete --project PROJECT --id COLLECTION [--name NAME]
labcanvas import FILE... --project PROJECT [--collection PATH ...] [--role result|supporting]
labcanvas import --project PROJECT --manifest FILE [--dry-run]
labcanvas items list --project PROJECT [--collection ID|PATH] [--query TEXT] [--trash]
labcanvas items get|table|text --id ITEM
labcanvas items update --id ITEM [--name NAME] [--role ROLE] [--description TEXT]
labcanvas items trash|restore --project PROJECT --id ITEM [--id ITEM ...]
labcanvas items export --id ITEM --output FILE
labcanvas membership add|remove --project PROJECT --id ITEM_OR_GROUP --collection ID|PATH
labcanvas groups list --project PROJECT
labcanvas groups create --project PROJECT --name NAME --members ID,ID [--primary ID] [--collection PATH ...]
labcanvas groups update --project PROJECT --id GROUP [--name NAME] [--primary ID]
labcanvas groups dissolve --project PROJECT --id GROUP
labcanvas groups remove --project PROJECT --id GROUP --member ITEM
labcanvas sources set --id ITEM --source ITEM [--source ITEM ...]
labcanvas runs list --project PROJECT
labcanvas versions list --id ITEM
labcanvas versions add --id ITEM --file FILE --expected-version N
labcanvas versions restore --id ITEM --version N --expected-version N
labcanvas layout get --project PROJECT [--view all|collection:ID]
labcanvas layout set --project PROJECT --view VIEW --file FILE
labcanvas backup --output DIRECTORY
labcanvas doctor

所有输出为 JSON；错误写入 stderr 并返回非零退出码。
--home DIRECTORY 或 LABCANVAS_HOME 指定资料库，默认 ~/.labcanvas。
路径在批量清单中相对于清单文件；导入复制原文件。
详见 docs/AGENT_API.md 和 examples/manifest.json。
`;
let store;
try {
  const { values: v, positionals: pos } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, home: { type: 'string' }, project: { type: 'string', short: 'p' },
    name: { type: 'string' }, slug: { type: 'string' }, id: { type: 'string', multiple: true },
    collection: { type: 'string', multiple: true, short: 'c' }, role: { type: 'string' },
    manifest: { type: 'string' }, 'dry-run': { type: 'boolean' }, key: { type: 'string' },
    description: { type: 'string' }, source: { type: 'string', multiple: true },
    parent: { type: 'string' }, members: { type: 'string' }, member: { type: 'string' }, primary: { type: 'string' },
    output: { type: 'string', short: 'o' }, file: { type: 'string' }, 'expected-version': { type: 'string' },
    version: { type: 'string' }, view: { type: 'string' }, port: { type: 'string' }, 'no-demo': { type: 'boolean' },
    query: { type: 'string' }, trash: { type: 'boolean' }, json: { type: 'boolean' },
    sheet: { type: 'string' }, offset: { type: 'string' }, limit: { type: 'string' }, run: { type: 'string' }
  } });
  if (v.help || !pos.length) { console.log(HELP); process.exit(0); }
  const [command, action] = pos;
  if (command === 'serve') {
    const { startServer } = await import('../server/index.mjs');
    const running = await startServer({ home: v.home, port: Number(v.port || 4317), demo: !v['no-demo'] });
    process.on('SIGINT', () => running.server.close(() => { running.store.close(); process.exit(0); }));
    process.on('SIGTERM', () => running.server.close(() => { running.store.close(); process.exit(0); }));
  } else {
    store = new Store(v.home);
    const project = () => { assert(v.project, '请提供 --project'); return v.project; };
    const itemId = () => { assert(v.id?.length === 1, '请提供一个 --id'); return v.id[0]; };
    const required = (key) => { assert(v[key], `请提供 --${key}`); return v[key]; };
    let result;
    if (command === 'demo') result = await seedDemo(store, { force: true });
    else if (command === 'projects') {
      if (action === 'list') result = store.projects();
      else if (action === 'create') result = store.createProject({ name: v.name, slug: v.slug, description: v.description });
      else if (action === 'update') result = store.updateProject(itemId(), { name: v.name, description: v.description });
    } else if (command === 'collections') {
      if (action === 'list') result = store.collections(project());
      else if (action === 'create') result = store.createCollection(project(), { name: v.name, parent_id: v.parent });
      else if (action === 'rename') result = store.updateCollection(project(), itemId(), { name: v.name });
      else if (action === 'delete') result = store.deleteCollection(project(), itemId());
    } else if (command === 'import') {
      if (v.manifest) {
        const file = path.resolve(v.manifest);
        result = await store.importManifest(project(), JSON.parse(await fs.readFile(file, 'utf8')), { baseDir: path.dirname(file), dryRun: !!v['dry-run'] });
      } else {
        const files = pos.slice(1); assert(files.length > 0, '请提供文件路径或 --manifest');
        result = await store.importManifest(project(), { import_key: v.key || `cli-${randomUUID()}`, items: files.map((f, i) => ({ key: `file-${i}`, path: path.resolve(f), collections: v.collection || [], ...(v.role ? { role: v.role } : {}), ...(v.name && files.length === 1 ? { title: v.name } : {}), derived_from: v.source || [], description: v.description || '' })), ...(v.run ? { run: { id: v.run } } : {}) }, { dryRun: !!v['dry-run'] });
      }
    } else if (command === 'items') {
      if (action === 'list') result = store.items(project(), { trash: !!v.trash, collection: v.collection?.[0], role: v.role, query: v.query });
      else if (action === 'get') result = store.item(itemId());
      else if (action === 'table') result = await store.table(itemId(), { sheet: Number(v.sheet || 0), offset: Number(v.offset || 0), limit: Number(v.limit || 100) });
      else if (action === 'text') result = await store.text(itemId());
      else if (action === 'update') result = store.updateItem(itemId(), { title: v.name, role: v.role, description: v.description });
      else if (action === 'trash' || action === 'restore') result = store.trashItems(project(), v.id, action === 'restore');
      else if (action === 'export') { const current = store.current(itemId()); const output = path.resolve(required('output')); assert(!(await fs.stat(output).catch(() => null)), '目标文件已存在，请选择新路径'); await fs.copyFile(path.join(store.home, 'objects', current.object_key), output, 1); result = { exported: output, item_id: itemId(), version: current.number }; }
    } else if (command === 'membership') {
      const collection = v.collection?.[0]; assert(collection, '请提供 --collection');
      if (action === 'add') result = store.addMembership(project(), itemId(), collection);
      else if (action === 'remove') result = store.removeMembership(project(), itemId(), collection);
    } else if (command === 'groups') {
      if (action === 'list') result = store.groups(project());
      else if (action === 'create') result = store.createGroup(project(), { title: v.name, members: required('members').split(','), primary: v.primary, collections: v.collection || [] });
      else if (action === 'update') result = store.updateGroup(project(), itemId(), { title: v.name, primary: v.primary });
      else if (action === 'dissolve') result = store.dissolveGroup(project(), itemId());
      else if (action === 'remove') result = store.removeGroupMember(project(), itemId(), required('member'));
    } else if (command === 'sources' && action === 'set') result = store.setSources(itemId(), v.source || []);
    else if (command === 'runs' && action === 'list') result = store.runs(project());
    else if (command === 'versions') {
      if (action === 'list') result = store.versions(itemId());
      else if (action === 'add') result = await store.replaceFile(itemId(), required('file'), Number(required('expected-version')));
      else if (action === 'restore') result = await store.restoreVersion(itemId(), Number(required('version')), Number(required('expected-version')));
    } else if (command === 'layout') {
      if (action === 'get') result = store.layout(project(), v.view || 'all');
      else if (action === 'set') result = store.saveLayout(project(), v.view || 'all', JSON.parse(await fs.readFile(required('file'), 'utf8')));
    } else if (command === 'backup') {
      const output = path.resolve(required('output'));
      assert(!output.startsWith(`${store.home}${path.sep}`) && output !== store.home, '备份目录须位于资料库之外');
      assert(!(await fs.stat(output).catch(() => null)), '备份目标已存在，请选择一个新目录');
      await fs.mkdir(output, { recursive: true, mode: 0o700 });
      await backup(store.db, path.join(output, 'labcanvas.sqlite'));
      for (const dir of ['objects', 'previews']) await fs.cp(path.join(store.home, dir), path.join(output, dir), { recursive: true });
      result = { backed_up: output, created_at: new Date().toISOString() };
    } else if (command === 'doctor') {
      const integrity = store.one('PRAGMA integrity_check'); const missing = [];
      for (const version of store.all('SELECT item_id,number,object_key FROM versions')) if (!(await fs.stat(path.join(store.home, 'objects', version.object_key)).catch(() => null))) missing.push(version);
      result = { ok: integrity.integrity_check === 'ok' && !missing.length, integrity: integrity.integrity_check, missing_files: missing, home: store.home };
      if (!result.ok) process.exitCode = 1;
    }
    assert(result !== undefined, '未知命令，请运行 labcanvas --help');
    console.log(JSON.stringify(result, null, 2)); store.close(); store = null;
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code || 'CLI_ERROR', message: error.message, ...(error.details ? { details: error.details } : {}) } }, null, 2));
  store?.close(); process.exitCode = 1;
}
