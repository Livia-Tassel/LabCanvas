import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createApp } from '../server/app.mjs';
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'labcanvas-api-')),{app,store}=createApp({home:path.join(dir,'.hidden-library')});
  const server=await new Promise(resolve=>{const srv=app.listen(0,'127.0.0.1',()=>resolve(srv));});const url=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();await fs.rm(dir,{recursive:true,force:true});});
  const req=async(route,method='GET',body)=>{const response=await fetch(url+'/api'+route,{method,headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};};
  return{req,url,store};
}
test('HTTP import, Unicode uploads, table editing, schema and downloads round-trip',async t=>{
  const{req,url,store}=await fixture(t);const p=(await req('/projects','POST',{name:'测试项目',slug:'test'})).data;
  const form=new FormData();form.append('files',new Blob(['方法,延迟\nBaseline,28.9\nAgentFS,8.6\n']), '实验结果.csv');form.append('collections',JSON.stringify(['日期/2026-11-10']));
  const upload=await fetch(`${url}/api/projects/${p.id}/uploads`,{method:'POST',body:form});assert.equal(upload.status,201);const result=await upload.json(),id=result.items[0].id;
  const item=(await req(`/items/${id}`)).data;assert.equal(item.original_name,'实验结果.csv');assert.equal(item.title,'实验结果.csv');
  const table=(await req(`/items/${id}/table`)).data;assert.equal(table.data[0][0],'方法');
  const edited=await req(`/items/${id}/table`,'PATCH',{expected_version:1,changes:[{row:1,column:1,value:'31.2'}]});assert.equal(edited.data.current_version,2);
  const download=await fetch(`${url}/api/items/${id}/file?download=1`);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/attachment/);assert.match(await download.text(),/31.2/);
  const schema=await req('/schema/import');assert.equal(schema.status,200);assert.equal(schema.data.type,'object');assert.ok(schema.data.required.includes('import_key'));
  assert.equal((await req(`/projects/${p.id}/snapshot`)).data.items.length,1);assert.equal(store.versions(id).length,2);
});
test('HTTP rejects foreign origin, invalid input, missing files and optimistic-lock conflicts',async t=>{
  const{req,url}=await fixture(t);const p=(await req('/projects','POST',{name:'A',slug:'a'})).data;
  const blocked=await fetch(`${url}/api/projects`,{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{"name":"Bad"}'});assert.equal(blocked.status,403);
  assert.equal((await req('/projects','POST',{name:''})).status,400);
  const created=(await req(`/projects/${p.id}/tables`,'POST',{name:'Data',rows:3,columns:3})).data,id=created.items[0].id;
  const bad=await req(`/items/${id}/table`,'PATCH',{expected_version:99,changes:[{row:1,column:1,value:'x'}]});assert.equal(bad.status,409);assert.equal(bad.data.error.code,'VERSION_CONFLICT');
  const missing=await req(`/projects/${p.id}/import`,'POST',{import_key:'bad',items:[{key:'x',path:'/no/such/file.csv'}]});assert.equal(missing.status,422);assert.equal(missing.data.error.code,'PREFLIGHT_FAILED');assert.equal(missing.data.error.details[0].key,'x');
  assert.equal((await req(`/items/${id}/table?offset=-1`)).status,400);assert.equal((await req('/not-a-route')).status,404);
});
