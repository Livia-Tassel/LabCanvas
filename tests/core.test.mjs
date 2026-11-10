import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Store } from '../server/store.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'labcanvas-test-')),home=path.join(dir,'data'),store=new Store(home);
  t.after(async()=>{try{store.close();}catch{}await fs.rm(dir,{recursive:true,force:true});});
  const p=store.createProject({name:'AgentFS',slug:'agentfs'});
  await fs.writeFile(path.join(dir,'result.csv'),'Method,Latency\nBaseline,28.9\nAgentFS,8.6\n');
  await fs.writeFile(path.join(dir,'figure.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="green"/></svg>');
  await fs.writeFile(path.join(dir,'run.log'),'SIMULATED\nINFO completed\n');
  const manifest={import_key:'run-001',items:[{key:'table',path:'result.csv',collections:['日期/2026-11-10','Baseline']},{key:'figure',path:'figure.svg',derived_from:['table']},{key:'log',path:'run.log',role:'supporting'}],groups:[{key:'g',title:'结果',members:['table','figure'],primary:'figure',collections:['模块/缓存']}],run:{title:'模拟运行',occurred_at:'2026-11-10T09:00:00+08:00'}};
  return{dir,home,store,p,manifest,import:()=>store.importManifest(p.id,manifest,{baseDir:dir})};
}
test('one physical record, multiple classifications, removal and collection deletion preserve data',async t=>{
  const f=await fixture(t),r=await f.import(),id=r.items[0].id;
  assert.equal(f.store.item(id).collectionIds.length,3);assert.equal(f.store.versions(id).length,1);
  f.store.removeMembership(f.p.id,id,'Baseline');
  assert.equal(f.store.items(f.p.id,{collection:'Baseline'}).length,0);assert.equal(f.store.item(id).collectionIds.length,2);
  f.store.deleteCollection(f.p.id,'日期');assert.equal(f.store.items(f.p.id).length,3);assert.equal(f.store.item(id).collectionIds.length,1);
});
test('trash removes an item from every classification and restores relationships and canvas coordinates',async t=>{
  const f=await fixture(t),r=await f.import(),id=r.items[0].id;
  f.store.saveLayout(f.p.id,'all',{positions:[{target_id:id,x:123,y:-90,width:420}],viewport:{x:12,y:33,zoom:.6}});
  f.store.trashItems(f.p.id,[id]);assert.equal(f.store.items(f.p.id).some(i=>i.id===id),false);assert.equal(f.store.items(f.p.id,{trash:true}).length,1);
  assert.equal(f.store.groups(f.p.id)[0].memberIds.length,1);
  f.store.trashItems(f.p.id,[id],true);assert.equal(f.store.item(id).collectionIds.length,3);assert.equal(f.store.layout(f.p.id,'all').positions[0].x,123);
  f.store.trashItems(f.p.id,[r.items[1].id]);const renamed=f.store.updateGroup(f.p.id,r.groups[0].id,{title:'仅保留表格的组合'});assert.equal(renamed.primary_item_id,id);
});
test('preflight is read-only, import is idempotent, changed request key conflicts, missing files are atomic',async t=>{
  const f=await fixture(t),preview=await f.store.importManifest(f.p.id,f.manifest,{baseDir:f.dir,dryRun:true});assert.equal(preview.valid,true);assert.equal(f.store.items(f.p.id).length,0);assert.equal((await fs.readdir(path.join(f.home,'objects'))).length,0);
  const a=await f.import(),b=await f.import();assert.equal(b.replayed,true);assert.equal(a.items[0].id,b.items[0].id);assert.equal(f.store.items(f.p.id).length,3);
  await fs.appendFile(path.join(f.dir,'result.csv'),'Other,1\n');await assert.rejects(f.import(),e=>e.code==='IDEMPOTENCY_CONFLICT');
  const before=f.store.items(f.p.id).length;await assert.rejects(f.store.importManifest(f.p.id,{import_key:'missing',items:[{key:'a',path:'result.csv'},{key:'b',path:'absent.csv'}]},{baseDir:f.dir}),e=>e.code==='PREFLIGHT_FAILED'&&e.details.some(d=>d.key==='b'));assert.equal(f.store.items(f.p.id).length,before);
});
test('same-name and same-byte results from different experiments remain independent',async t=>{
  const f=await fixture(t),a=await f.import(),b=await f.store.addFile(f.p.id,path.join(f.dir,'result.csv'));
  assert.notEqual(a.items[0].id,b.items[0].id);assert.equal(f.store.current(a.items[0].id).object_key,f.store.current(b.items[0].id).object_key);
});
test('project isolation applies to memberships, groups, source relations, layouts and runs',async t=>{
  const f=await fixture(t),a=await f.import(),p2=f.store.createProject({name:'Other',slug:'other'}),r2=await f.store.addFile(p2.id,path.join(f.dir,'result.csv')),foreign=r2.items[0].id;
  assert.throws(()=>f.store.addMembership(f.p.id,foreign,'Bad'),e=>e.code==='CROSS_PROJECT');
  assert.throws(()=>f.store.createGroup(f.p.id,{title:'bad',members:[a.items[0].id,foreign]}));
  assert.throws(()=>f.store.setSources(a.items[0].id,[foreign]),e=>e.code==='CROSS_PROJECT');
  assert.throws(()=>f.store.saveLayout(f.p.id,'all',{positions:[{target_id:foreign,x:0,y:0,width:300}]}));
  await assert.rejects(f.store.importManifest(p2.id,{import_key:'bad-run',run:{id:a.run_id},items:[{key:'t',path:'result.csv'}]},{baseDir:f.dir}));
  assert.equal(f.store.items(p2.id).length,1);
});
test('dissolving a group keeps its members, sources, and collection visibility',async t=>{
  const f=await fixture(t),r=await f.import();f.store.dissolveGroup(f.p.id,r.groups[0].id);
  assert.equal(f.store.groups(f.p.id).length,0);assert.equal(f.store.items(f.p.id).length,3);assert.equal(f.store.items(f.p.id,{collection:'模块/缓存'}).length,2);assert.equal(f.store.item(r.items[1].id).sources[0].source_item_id,r.items[0].id);
});
test('source cycles fail preflight and never create records',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.store.importManifest(f.p.id,{import_key:'cycle',items:[{key:'a',path:'result.csv',derived_from:['b']},{key:'b',path:'result.csv',derived_from:['a']}]},{baseDir:f.dir}),e=>e.code==='SOURCE_CYCLE');assert.equal(f.store.items(f.p.id).length,0);
  const r=await f.import();assert.throws(()=>f.store.setSources(r.items[0].id,[r.items[1].id]),e=>e.code==='SOURCE_CYCLE');assert.equal(f.store.item(r.items[0].id).sources.length,0);
});
test('CSV edits create immutable versions, preserve originals, detect concurrent saves and flag stale charts',async t=>{
  const f=await fixture(t),r=await f.import(),table=r.items[0].id,old=f.store.current(table);
  const updated=await f.store.editTable(table,[{sheet:0,row:1,column:1,value:'30.5'},{row:3,column:0,value:'New'}],1);
  assert.equal(updated.current_version,2);assert.equal((await f.store.table(table)).data[1][1],'30.5');assert.equal((await fs.readFile(path.join(f.home,'objects',old.object_key),'utf8')).includes('28.9'),true);
  assert.equal(f.store.item(r.items[1].id).sources[0].stale,true);
  await assert.rejects(f.store.editTable(table,[{row:1,column:1,value:'999'}],1),e=>e.code==='VERSION_CONFLICT');
  await f.store.restoreVersion(table,1,2);assert.equal(f.store.item(table).current_version,3);assert.equal((await f.store.table(table)).data[1][1],'28.9');
});
test('XLSX edits preserve sheets, existing formula and column style; all rows can be paged',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'book.xlsx'),wb=new ExcelJS.Workbook(),a=wb.addWorksheet('Data');a.addRows([['Value','Formula'],[1,{formula:'A2*2',result:2}]]);a.getCell('A2').numFmt='0.00';
  const b=wb.addWorksheet('Second');for(let n=0;n<250;n++)b.addRow([n,`Row ${n}`]);await wb.xlsx.writeFile(file);
  const r=await f.store.addFile(f.p.id,file),id=r.items[0].id;await f.store.editTable(id,[{sheet:0,row:1,column:0,value:'12.5'}],1);
  const read=new ExcelJS.Workbook();await read.xlsx.readFile(path.join(f.home,'objects',f.store.current(id).object_key));assert.equal(read.worksheets.length,2);assert.equal(read.worksheets[0].getCell('B2').formula,'A2*2');assert.equal(read.worksheets[0].getCell('A2').numFmt,'0.00');assert.equal(read.worksheets[0].getCell('A2').value,12.5);
  const page=await f.store.table(id,{sheet:1,offset:200,limit:100});assert.equal(page.totalRows,250);assert.equal(page.data.length,50);assert.equal(page.data[0][1],'Row 200');
});
test('supporting logs are linked to time-based runs and Unicode text versions survive restart',async t=>{
  const f=await fixture(t),r=await f.import(),log=r.items[2].id;assert.equal(f.store.items(f.p.id,{role:'result'}).length,2);assert.equal(f.store.runs(f.p.id)[0].itemIds.length,3);
  await f.store.editText(log,'模拟数据\n运行完成 ✓\n',1);f.store.close();const reopened=new Store(f.home);assert.equal((await reopened.text(log)).content,'模拟数据\n运行完成 ✓\n');reopened.close();
});
test('CLI is machine readable, uses the same database offline, and backup is restorable',async t=>{
  const f=await fixture(t),r=await f.import();
  const out=await exec(process.execPath,['cli/labcanvas.mjs','items','get','--home',f.home,'--id',r.items[0].id],{cwd:process.cwd()});assert.equal(JSON.parse(out.stdout).id,r.items[0].id);
  const target=path.join(f.dir,'backup');await exec(process.execPath,['cli/labcanvas.mjs','backup','--home',f.home,'--output',target]);const restored=new Store(target);assert.equal(restored.items(f.p.id).length,3);assert.equal((await restored.table(r.items[0].id)).data[1][0],'Baseline');restored.close();
  await assert.rejects(exec(process.execPath,['cli/labcanvas.mjs','items','get','--home',f.home,'--id','missing']),e=>JSON.parse(e.stderr).error.code==='NOT_FOUND');
});
test('inherited classifications require changing the group; removing a member preserves independent records',async t=>{
  const f=await fixture(t),r=await f.import(),item=r.items[0].id,group=r.groups[0].id;
  f.store.addMembership(f.p.id,item,'模块/缓存');
  assert.throws(()=>f.store.removeMembership(f.p.id,item,'模块/缓存'),e=>e.code==='INHERITED_MEMBERSHIP');
  f.store.removeGroupMember(f.p.id,group,item);assert.equal(f.store.groups(f.p.id).length,0);assert.equal(f.store.items(f.p.id).length,3);
  f.store.removeMembership(f.p.id,item,'模块/缓存');assert.equal(f.store.items(f.p.id,{collection:'模块/缓存'}).length,1);
});
test('concurrent CLI imports are idempotent and concurrent edits use optimistic locking',async t=>{
  const f=await fixture(t),args=['cli/labcanvas.mjs','import',path.join(f.dir,'result.csv'),'--home',f.home,'--project',f.p.id,'--key','concurrent'];
  const results=await Promise.all([exec(process.execPath,args),exec(process.execPath,args)]);const a=JSON.parse(results[0].stdout),b=JSON.parse(results[1].stdout);assert.equal(a.items[0].id,b.items[0].id);assert.equal(f.store.items(f.p.id).length,1);
  const original = f.store.current(a.items[0].id); assert.equal(createHash('sha256').update(await fs.readFile(path.join(f.home,'objects',original.object_key))).digest('hex'),original.sha256);
  const other=new Store(f.home);try{const edits=await Promise.allSettled([f.store.editTable(a.items[0].id,[{row:1,column:1,value:'100'}],1),other.editTable(a.items[0].id,[{row:1,column:1,value:'200'}],1)]);assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);assert.equal(edits.find(r=>r.status==='rejected').reason.code,'VERSION_CONFLICT');}finally{other.close();}
});
test('preflight rejects blank names and unknown fields without creating files or collections',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.store.importManifest(f.p.id,{import_key:'bad-title',items:[{key:'a',path:'result.csv',title:'   ',collections:['New']}]},{baseDir:f.dir,dryRun:true}),e=>e.code==='INVALID_MANIFEST');
  await assert.rejects(f.store.importManifest(f.p.id,{import_key:'typo',items:[{key:'a',path:'result.csv',collectons:['New']}]},{baseDir:f.dir}),e=>e.code==='INVALID_MANIFEST');
  assert.equal(f.store.items(f.p.id).length,0);assert.equal(f.store.collections(f.p.id).length,0);assert.equal((await fs.readdir(path.join(f.home,'objects'))).length,0);
});
