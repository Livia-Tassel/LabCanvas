import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { createWriteStream } from 'node:fs';
import sharp from 'sharp';
import { startServer } from '../server/index.mjs';
import { writeZip } from '../server/zip.mjs';

const exec = promisify(execFile);
const cli = path.resolve('cli/labcanvas.mjs');

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'labcanvas-test-'));
  const store = new Store(path.join(dir, 'home'));
  t.after(async () => {
    try { store.close(); } catch { /* already closed */ }
    await rm(dir, { recursive: true, force: true });
  });
  const file = async (name, content) => {
    const target = path.join(dir, name);
    await writeFile(target, content);
    return target;
  };
  return { dir, store, file };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('one entry can live in several collections without copying data', async t => {
  const { store, file } = await workspace(t);
  const project = store.createProject({ name: 'AgentFS' });
  assert.equal(project.slug, 'agentfs');
  const created = await store.createEntry('agentfs', {
    files: [{ path: await file('results.csv', 'a,b\n1,2\n') }, { path: await file('fig.png', PNG) }],
    collections: ['实验日期/2026-11-19', '实验目的/Baseline']
  });
  assert.equal(created.title, 'results');
  const entry = store.entry(created.id);
  assert.equal(entry.files.length, 2);
  assert.equal(entry.collection_ids.length, 2);
  assert.deepEqual(entry.files[0].preview.rows, [['a', 'b'], ['1', '2']]);
  // The figure is linked to the only table of the entry.
  assert.equal(entry.files[1].source_file_id, entry.files[0].id);
  assert.equal((await readdir(path.join(store.home, 'objects'))).length, 2);

  // Removing from one collection only drops that reference.
  store.setMembership(project.id, [entry.id], '实验目的/Baseline', false);
  assert.equal(store.entry(entry.id).collection_ids.length, 1);
  assert.equal(store.entries(project.id, { collection: '实验日期/2026-11-19' }).length, 1);

  // Deleting a collection keeps the entry.
  store.deleteCollection(store.resolveCollection(project.id, '实验日期').id);
  assert.equal(store.entry(entry.id).collection_ids.length, 0);
  assert.equal(store.snapshot(project.id).entries.length, 1);
});

test('trash, restore and permanent delete', async t => {
  const { store, file } = await workspace(t);
  const project = store.createProject({ name: '实验' });
  assert.equal(project.slug, 'project');
  const csv = await file('a.csv', 'x\n1\n');
  const { id } = await store.createEntry(project.id, { files: [{ path: csv }], collections: ['A', 'B'] });
  const shared = await store.createEntry(project.id, { files: [{ path: csv }] });
  store.trash(project.id, [id]);
  assert.deepEqual(store.snapshot(project.id).entries.map(entry => entry.id), [shared.id]);
  assert.equal(store.collections(project.id)[0].entry_count, 0);
  store.trash(project.id, [id], false);
  assert.equal(store.entry(id).collection_ids.length, 2);

  const objects = path.join(store.home, 'objects');
  await store.purge(project.id, [id]);
  assert.throws(() => store.entry(id), { code: 'ENTRY_NOT_FOUND' });
  assert.equal(store.all('SELECT * FROM memberships').length, 0);
  assert.equal((await readdir(objects)).length, 1);
  await store.purge(project.id, [shared.id]);
  assert.equal((await readdir(objects)).length, 0);
});

test('invalid batches leave no entries, collection references or published objects', async t => {
  const { store, file } = await workspace(t);
  const project = store.createProject({ name: 'AgentFS' });
  const other = store.createProject({ name: 'Other' });
  const foreign = store.createCollection(other.id, { name: '跨项目' });
  const csv = await file('r.csv', 'x\n1\n');
  const png = await file('p.png', PNG);
  const entries = [
    { key: 'first', files: [{ path: csv }], collections: ['实验'] },
    { key: 'second', files: [{ path: png, source: 'missing.csv' }] }
  ];
  for (const dryRun of [true, false]) {
    await assert.rejects(store.createEntries(project.id, entries, { dryRun }), { code: 'SOURCE_NOT_FOUND' });
    assert.equal(store.entries(project.id).length, 0);
    assert.equal(store.collections(project.id).length, 0);
    for (const directory of ['objects', 'previews', 'tmp']) {
      assert.deepEqual(await readdir(path.join(store.home, directory)), []);
    }
  }
  await assert.rejects(store.createEntry(project.id, { ...entries[0], collections: [foreign.id] }), { code: 'COLLECTION_NOT_FOUND' });
  const results = await store.createEntries(project.id, [{ files: [{ path: csv }, { path: png }] }]);
  const [table, figure] = results[0].files;
  assert.throws(() => store.updateFile(table.id, { source_file_id: figure.id }), { code: 'SOURCE_CYCLE' });
});

test('key makes repeated imports update in place', async t => {
  const { store, file } = await workspace(t);
  store.createProject({ name: 'p' });
  const csv = await file('r.csv', 'a\n1\n');
  const first = await store.createEntry('p', { key: 'run-1', files: [{ path: csv }], collections: ['A'] });
  assert.equal(first.status, 'created');
  const same = await store.createEntry('p', { key: 'run-1', files: [{ path: csv }] });
  assert.deepEqual([same.status, same.files[0].status], ['updated', 'unchanged']);
  await writeFile(csv, 'a\n2\n');
  const changed = await store.createEntry('p', { key: 'run-1', files: [{ path: csv }, { path: await file('f.png', PNG) }], collections: ['B'] });
  assert.equal(changed.id, first.id);
  assert.deepEqual(changed.files.map(f => f.status), ['updated', 'added']);
  const entry = store.entry(first.id);
  assert.equal(entry.files[0].version, 2);
  assert.equal(entry.collection_ids.length, 2);
  assert.equal(store.versions(entry.files[0].id).length, 2);
  store.restoreVersion(entry.files[0].id, 1);
  assert.equal((await store.table(entry.files[0].id)).rows[1][0], '1');
});

test('merge, split and file removal', async t => {
  const { store, file } = await workspace(t);
  const project = store.createProject({ name: 'p' });
  const a = await store.createEntry('p', { files: [{ path: await file('t.csv', 'a\n1\n') }], collections: ['A'] });
  const b = await store.createEntry('p', { files: [{ path: await file('f.png', PNG) }], collections: ['B'] });
  const merged = store.merge(project.id, [a.id, b.id]);
  assert.equal(merged.files.length, 2);
  assert.equal(merged.collection_ids.length, 2);
  assert.equal(merged.files[1].source_file_id, merged.files[0].id);
  assert.equal(store.snapshot(project.id).entries.length, 1);
  const split = store.splitFile(merged.files[1].id);
  assert.equal(split.title, 'f');
  assert.equal(split.collection_ids.length, 2);
  await assert.rejects(store.deleteFile(split.files[0].id), { code: 'LAST_FILE' });
});

test('table and text editing create versions', async t => {
  const { store, file } = await workspace(t);
  store.createProject({ name: 'p' });
  const { id } = await store.createEntry('p', { files: [{ path: await file('t.csv', 'h1,h2\n1,2\n3,4\n') }, { path: await file('n.md', '# note') }] });
  const [table, note] = store.entry(id).files;
  await store.editTable(table.id, [
    { type: 'set', row: 1, column: 1, value: '9' },
    { type: 'insertRows', at: 1, count: 1 },
    { type: 'insertColumns', at: 2, count: 1 },
    { type: 'set', row: 0, column: 2, value: 'h3' },
    { type: 'deleteRows', at: 3, count: 1 }
  ], 1);
  const data = await store.table(table.id);
  assert.deepEqual(data.rows, [['h1', 'h2', 'h3'], ['', '', ''], ['1', '9', '']]);
  await assert.rejects(store.editTable(table.id, [{ type: 'set', row: 0, column: 0, value: 'x' }], 1), { code: 'VERSION_CONFLICT' });
  await store.saveText(note.id, '# changed', 1);
  assert.equal((await store.text(note.id)).content, '# changed');

  const created = await store.createTable('p', { title: '新表', rows: 3, columns: 2 });
  const xlsx = store.entry(created.id).files[0];
  assert.equal((await store.table(xlsx.id)).totalColumns, 2);
});

test('layouts are stored per view', async t => {
  const { store, file } = await workspace(t);
  const project = store.createProject({ name: 'p' });
  const { id } = await store.createEntry('p', { files: [{ path: await file('t.csv', 'a\n') }], collections: ['A'] });
  const view = `collection:${store.resolveCollection(project.id, 'A').id}`;
  store.saveLayout('p', 'all', { positions: [{ entry_id: id, x: 10, y: 20, w: 360 }], viewport: { x: 0, y: 0, zoom: 1 } });
  store.saveLayout('p', view, { positions: [{ entry_id: id, x: 500, y: 0, w: 400 }] });
  assert.equal(store.layout('p', 'all').positions[0].x, 10);
  assert.equal(store.layout('p', view).positions[0].x, 500);
  store.setMembership(project.id, [id], 'A', false);
  assert.equal(store.layout('p', view).positions.length, 0);
});

test('command line import for agents', async t => {
  const { dir, store, file } = await workspace(t);
  store.close();
  const env = { ...process.env, LABCANVAS_HOME: path.join(dir, 'home') };
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args], { env })).stdout);
  await run('project', 'create', 'AgentFS');
  const csv = await file('results.csv', 'k,v\n1,2\n');
  const png = await file('plot.png', PNG);
  const added = await run('add', csv, png, '-p', 'agentfs', '-c', '实验目的/Baseline', '-c', '日期/2026-11-19', '-t', '缓存消融', '-d', '2026-11-19', '-k', 'cache');
  assert.equal(added.entries[0].status, 'created');
  assert.equal(added.entries[0].files.length, 2);
  const again = await run('add', csv, png, '-p', 'agentfs', '-k', 'cache');
  assert.equal(again.entries[0].id, added.entries[0].id);
  const listed = await run('list', '-p', 'agentfs', '-c', '实验目的/Baseline');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].date, '2026-11-19');

  const separate = await run('add', csv, png, '-p', 'agentfs', '--separate');
  assert.equal(separate.entries.length, 2);

  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ project: 'agentfs', entries: [{ key: 'm1', title: '清单导入', collections: ['A'], files: ['results.csv', { path: 'plot.png', source: 'results.csv' }] }] }));
  const imported = await run('import', path.join(dir, 'manifest.json'));
  assert.equal(imported.entries[0].files.length, 2);
  const backup = path.join(dir, 'backup');
  await run('backup', backup);
  assert.equal((await run('doctor', '--home', backup)).ok, true);

  const exported = path.join(dir, 'out.csv');
  await run('export', added.entries[0].files[0].id, '-o', exported);
  assert.equal(await readFile(exported, 'utf8'), 'k,v\n1,2\n');

  const failure = await exec(process.execPath, [cli, 'add', path.join(dir, 'missing.csv'), '-p', 'agentfs'], { env }).catch(error => error);
  assert.equal(failure.code, 1);
  assert.equal(JSON.parse(failure.stderr).error.code, 'FILE_NOT_FOUND');
  await run('delete', added.entries[0].id, '--yes');
  assert.equal((await run('doctor')).ok, true);
});

test('http api and change events', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'labcanvas-http-'));
  const running = await startServer({ home: dir, port: 0 });
  t.after(async () => { await running.stop(); await rm(dir, { recursive: true, force: true }); });
  const call = async (url, init) => {
    const response = await fetch(`${running.url}/api${url}`, init);
    return { status: response.status, body: await response.json() };
  };
  const post = (url, body) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const project = (await post('/projects', { name: 'Web' })).body;
  const form = new FormData();
  form.append('files', new Blob(['a,b\n1,2\n']), '结果.csv');
  form.append('files', new Blob([PNG]), 'fig.png');
  form.append('meta', JSON.stringify({ mode: 'separate', collections: ['A'] }));
  const upload = await call(`/projects/${project.id}/entries`, { method: 'POST', body: form });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.entries.length, 2);
  assert.equal(upload.body.entries[0].title, '结果');
  const snapshot = (await call(`/projects/${project.id}/snapshot`)).body;
  assert.equal(snapshot.entries.length, 2);
  const image = snapshot.entries[1].files[0];
  assert.equal((await fetch(`${running.url}/api/files/${image.id}/thumbnail`)).status, 200);
  assert.equal((await fetch(`${running.url}/api/files/${image.id}/raw`)).headers.get('content-type'), 'image/png');
  assert.equal((await call('/entries/nope')).body.error.code, 'ENTRY_NOT_FOUND');
  assert.equal((await fetch(`${running.url}/api/projects`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await readdir(path.join(dir, 'tmp'))).length, 0);

  // Search, properties, annotations and export through the same interface the window uses.
  const table = snapshot.entries[0];
  const patch = (url, body) => call(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual((await patch(`/entries/${table.id}`, { fields: { lr: '0.01' } })).body.fields, [{ name: 'lr', value: '0.01' }]);
  const hits = (await call(`/projects/${project.id}/search?q=${encodeURIComponent('0.01')}`)).body;
  assert.deepEqual(hits.map(hit => hit.entry_id), [table.id]);
  const note = await post(`/projects/${project.id}/annotations?view=all`, { kind: 'frame', x: 0, y: 0, w: 400, h: 300, text: '第一轮' });
  assert.equal(note.status, 201);
  assert.equal((await call(`/projects/${project.id}/layout?view=all`)).body.annotations[0].text, '第一轮');
  const archive = await fetch(`${running.url}/api/projects/${project.id}/export?entries=${table.id},${snapshot.entries[1].id}`);
  assert.equal(archive.headers.get('content-type'), 'application/zip');
  assert.equal(Buffer.from(await archive.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  assert.equal((await post('/backup', { target: path.join(dir, 'inside') })).status, 400);
});

test('search covers titles, notes, properties and file contents', async t => {
  const { store, file } = await workspace(t);
  const project = store.createProject({ name: 'p' });
  const a = await store.createEntry('p', {
    title: '缓存消融', note: '关闭预取后重跑', fields: { lr: 0.001, model: 'resnet50' },
    files: [{ path: await file('latency.csv', 'batch,latency_ms\nBaseline,12.5\nAgentFS,8.25\n') }]
  });
  const b = await store.createEntry('p', { files: [{ path: await file('train.log', 'epoch 1\nloss diverged at step 4200\n') }] });
  const ids = query => store.search(project.id, query).map(hit => hit.entry_id);
  assert.deepEqual(ids('消融'), [a.id]);
  assert.deepEqual(ids('预取'), [a.id]);
  assert.deepEqual(ids('AgentFS'), [a.id]);
  assert.deepEqual(ids('resnet50'), [a.id]);
  assert.deepEqual(ids('DIVERGED 4200'), [b.id]);
  assert.deepEqual(ids('lr'), [a.id]);
  assert.deepEqual(ids('100%'), []);
  assert.match(store.search(project.id, 'diverged')[0].snippet, /loss diverged/);
  assert.deepEqual(store.entries(project.id, { query: 'latency_ms' }).map(entry => entry.id), [a.id]);

  // The index follows edits, new file versions and deletion.
  store.updateEntry(a.id, { title: '改名后', fields: { model: null, seed: 7 } });
  assert.deepEqual(ids('消融'), []);
  assert.deepEqual(ids('resnet50'), []);
  assert.deepEqual(store.entry(a.id).fields.map(field => ({ ...field })), [{ name: 'lr', value: '0.001' }, { name: 'seed', value: '7' }]);
  const table = store.entry(a.id).files[0];
  await store.editTable(table.id, [{ type: 'set', row: 1, column: 0, value: 'Control' }], 1);
  assert.deepEqual(ids('Baseline'), []);
  assert.deepEqual(ids('Control'), [a.id]);
  await store.purge(project.id, [b.id]);
  assert.deepEqual(ids('diverged'), []);
  assert.equal(store.all('SELECT * FROM search_docs').length, 1);

  // Text of files stored before the index existed is filled in on demand.
  store.run('DELETE FROM file_text');
  store.run('INSERT OR IGNORE INTO search_dirty SELECT id FROM entries');
  assert.deepEqual(ids('Control'), []);
  assert.equal((await store.reindex()).indexed, 1);
  assert.deepEqual(ids('Control'), [a.id]);
});

test('a figure is flagged once its source table moves on', async t => {
  const { store, file } = await workspace(t);
  store.createProject({ name: 'p' });
  const csv = await file('r.csv', 'a\n1\n');
  const png = await file('f.png', PNG);
  const created = await store.createEntry('p', { key: 'k', files: [{ path: png }, { path: csv }] });
  const figure = () => store.entry(created.id).files.find(item => item.kind === 'image');
  const table = () => store.entry(created.id).files.find(item => item.kind === 'table');
  assert.equal(figure().source_file_id, table().id);
  assert.equal(figure().source_version, 1);
  await store.editTable(table().id, [{ type: 'set', row: 1, column: 0, value: '2' }], 1);
  assert.equal(table().version, 2);
  assert.equal(figure().source_version, 1);
  store.updateFile(figure().id, { source_checked: true });
  assert.equal(figure().source_version, 2);
  // Re-importing both under the same key keeps them in step, whichever comes first.
  await writeFile(csv, 'a\n3\n');
  await writeFile(png, await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer());
  await store.createEntry('p', { key: 'k', files: [{ path: png }, { path: csv }] });
  assert.deepEqual([table().version, figure().version, figure().source_version], [3, 2, 3]);
});

test('duplicates are reported, collections keep a manual order, canvases hold annotations', async t => {
  const { store, file } = await workspace(t);
  const project = store.createProject({ name: 'p' });
  const csv = await file('r.csv', 'a\n1\n');
  const first = await store.createEntry('p', { title: '原件', files: [{ path: csv }] });
  const second = await store.createEntry('p', { files: [{ path: csv }] });
  assert.equal(first.files[0].duplicate_of, undefined);
  assert.deepEqual(second.files[0].duplicate_of, { entry_id: first.id, title: '原件' });

  const [b, a, c] = ['B', 'A', 'C'].map(name => store.createCollection(project.id, { name }));
  const order = () => store.collections(project.id).map(item => item.name).join('');
  assert.equal(order(), 'BAC');
  store.updateCollection(c.id, { before_id: b.id });
  assert.equal(order(), 'CBA');
  store.updateCollection(c.id, { before_id: null });
  assert.equal(order(), 'BAC');
  store.updateCollection(a.id, { parent_id: b.id });
  assert.equal(store.collections(project.id).find(item => item.id === a.id).path, 'B/A');
  store.updateCollection(a.id, { parent_id: null, before_id: b.id });
  assert.equal(order(), 'ABC');
  store.updateCollection(a.id, { before_id: null });
  assert.equal(order(), 'BCA');
  store.sortCollections(project.id);
  assert.equal(order(), 'ABC');

  const view = `collection:${c.id}`;
  const note = store.createAnnotation('p', view, { kind: 'note', x: 0, y: 0, w: 200, h: 80, text: '结论' });
  store.updateAnnotation(note.id, { text: '结论：有效', x: 40 });
  assert.deepEqual({ ...store.layout('p', view).annotations[0] }, { id: note.id, kind: 'note', x: 40, y: 0, w: 200, h: 80, text: '结论：有效' });
  assert.equal(store.layout('p', 'all').annotations.length, 0);
  assert.throws(() => store.createAnnotation('p', view, { kind: 'arrow', x: 0, y: 0, w: 200, h: 80 }));
  store.deleteCollection(c.id);
  assert.equal(store.all('SELECT * FROM annotations').length, 0);

  const updated = store.updateEntries(project.id, [first.id, second.id], { date: '2026-01-02', fields: { seed: 1 } });
  assert.deepEqual(updated.map(entry => entry.date), ['2026-01-02', '2026-01-02']);
});

test('export archive and in-process backup', async t => {
  const { dir, store, file } = await workspace(t);
  const project = store.createProject({ name: 'p' });
  const one = await store.createEntry('p', { title: '结果/一', files: [{ path: await file('数据.csv', 'a\n1\n') }, { path: await file('f.png', PNG) }] });
  const two = await store.createEntry('p', { title: '结果/一', files: [{ path: await file('n.md', '# note') }] });
  const list = store.exportList(project.id, [one.id, two.id]);
  assert.deepEqual(list.map(item => item.name), ['结果-一/数据.csv', '结果-一/f.png', '结果-一 (2)/n.md']);
  const archive = path.join(dir, 'out.zip');
  const output = createWriteStream(archive);
  await writeZip(output, list);
  await new Promise(resolve => output.end(resolve));
  await exec('unzip', ['-q', archive, '-d', path.join(dir, 'unzipped')]);
  assert.equal(await readFile(path.join(dir, 'unzipped', '结果-一', '数据.csv'), 'utf8'), 'a\n1\n');
  assert.deepEqual(await readFile(path.join(dir, 'unzipped', '结果-一', 'f.png')), PNG);
  assert.equal(await readFile(path.join(dir, 'unzipped', '结果-一 (2)', 'n.md'), 'utf8'), '# note');

  const target = path.join(dir, 'backup');
  await store.backup(target);
  const copy = new Store(target);
  assert.equal(copy.snapshot('p').entries.length, 2);
  assert.equal((await copy.doctor()).ok, true);
  copy.close();
  await assert.rejects(store.backup(target), { code: 'CONFLICT' });
});

test('large logs can be read from the end and old versions stay readable', async t => {
  const { store, file } = await workspace(t);
  store.createProject({ name: 'p' });
  const lines = Array.from({ length: 300000 }, (_, index) => `line ${index}`).join('\n');
  const { id } = await store.createEntry('p', { files: [{ path: await file('big.log', lines) }, { path: await file('n.md', 'v1') }] });
  const [log, note] = store.entry(id).files;
  const head = await store.text(log.id);
  assert.equal(head.truncated, true);
  assert.ok(head.content.startsWith('line 0\n'));
  const tail = await store.text(log.id, { tail: true });
  assert.ok(tail.content.endsWith('line 299999'));
  assert.match(tail.content, /^line \d+\n/);
  await store.saveText(note.id, 'v2', 1);
  assert.equal((await store.text(note.id, { version: 1 })).content, 'v1');
  assert.equal((await store.text(note.id)).content, 'v2');
});
