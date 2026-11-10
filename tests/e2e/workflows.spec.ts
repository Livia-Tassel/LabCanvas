import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
let project:string,group:string,table:string,figure:string;
test.beforeEach(async({page,request},info)=>{
  const slug=`test-${info.testId.replace(/[^a-z0-9]/gi,'').toLowerCase().slice(0,40)}-${Date.now()}`;
  const p=await request.post('/api/projects',{data:{name:'交互测试',slug}});project=(await p.json()).id;
  const manifest=JSON.parse(await readFile('examples/manifest.json','utf8'));
  const imported=await request.post(`/api/projects/${project}/import`,{data:{manifest,base_dir:path.resolve('examples')}});expect(imported.ok()).toBeTruthy();
  const r=await imported.json();group=r.groups[0].id;table=r.items[0].id;figure=r.items[1].id;
  await request.post(`/api/projects/${project}/tables`,{data:{name:'独立表格',rows:6,columns:5}});
  await page.addInitScript(id=>localStorage.setItem('labcanvas.project',id),project);
  await page.goto('/');await expect(page.getByTestId('canvas')).toBeVisible();await expect(page.locator('.canvas-card')).toHaveCount(2);
});
test('actual previews, group expansion, CSV editing, version history and source updates',async({page,request})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await expect.poll(()=>page.locator('.canvas img').evaluateAll(imgs=>imgs.every(i=>(i as HTMLImageElement).complete&&(i as HTMLImageElement).naturalWidth>0))).toBeTruthy();
  await page.getByRole('button',{name:'列表视图',exact:true}).click();await page.getByRole('button',{name:'展开 缓存延迟对比',exact:true}).click();await expect(page.locator('.child-row')).toHaveCount(2);
  await page.getByTestId(`row-${table}`).dblclick();await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('[data-cell="1:1"]').click();await page.getByLabel('单元格内容',{exact:true}).fill('33.5');await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect.poll(async()=>((await (await request.get(`/api/items/${table}/table`)).json()).data[1][1])).toBe('33.5');
  expect((await(await request.get(`/api/items/${figure}`)).json()).sources[0].stale).toBe(true);
  await page.getByRole('button',{name:'版本记录',exact:true}).click();await expect(page.locator('.version-entry')).toHaveCount(2);
  await page.locator('.version-entry').filter({hasText:'v1'}).getByRole('button',{name:'恢复',exact:true}).click();await page.getByRole('button',{name:'确认恢复',exact:true}).click();
  await expect.poll(async()=>((await(await request.get(`/api/items/${table}/table`)).json()).data[1][1])).toBe('6.8');
  await expect(page.locator('.cell-selected')).toBeVisible();await page.getByRole('button',{name:'关闭对话框',exact:true}).click();expect(errors).toEqual([]);
});
test('canvas drag, zoom and per-view layouts survive a reload',async({page,request})=>{
  const header=page.getByTestId(`card-${group}`).locator('.card-header');const box=await header.boundingBox();expect(box).toBeTruthy();
  const before=(await(await request.get(`/api/projects/${project}/layout?view=all`)).json()).positions.find((p:{target_id:string})=>p.target_id===group);
  await page.mouse.move(box!.x+110,box!.y+20);await page.mouse.down();await page.mouse.move(box!.x+250,box!.y+100,{steps:12});await page.mouse.up();
  await expect.poll(async()=>((await(await request.get(`/api/projects/${project}/layout?view=all`)).json()).positions.find((p:{target_id:string})=>p.target_id===group).x)).not.toBe(before.x);
  await page.getByRole('button',{name:'放大画布',exact:true}).click();const zoom=await page.locator('.zoom-value').innerText();await page.reload();await expect(page.locator('.zoom-value')).toHaveText(zoom);
  await page.getByRole('button',{name:'缓存',exact:true}).click();await expect(page.locator('.canvas-card')).toHaveCount(1);await expect(page.locator('.zoom-value')).toHaveText('85%');
});
test('classification removal preserves other references; trash and restore preserve combination',async({page,request})=>{
  await request.put(`/api/projects/${project}/memberships`,{data:{target_id:group,collection_id:'另一个分类'}});
  await page.getByRole('button',{name:'缓存',exact:true}).click();await page.getByTestId(`card-${group}`).locator('.card-header').click();
  await page.getByRole('button',{name:'从分类移除',exact:true}).click();await page.getByRole('button',{name:'确认',exact:true}).click();await expect(page.locator('.canvas-card')).toHaveCount(0);
  const state=await(await request.get(`/api/projects/${project}/snapshot`)).json();expect(state.items).toHaveLength(4);expect(state.groups[0].collectionIds).toHaveLength(2);
  await page.getByRole('button',{name:/^全部资料/}).click();await page.getByTestId(`card-${group}`).locator('.card-header').click();await page.locator('.selection-toolbar').getByRole('button',{name:'回收站',exact:true}).click();await page.getByRole('button',{name:'确认',exact:true}).click();await expect(page.locator('.canvas-card')).toHaveCount(1);
  await page.getByRole('button',{name:/^回收站/}).click();await expect(page.locator('.list-view tbody tr')).toHaveCount(2);await page.getByLabel('选择全部资料',{exact:true}).check();await page.getByRole('button',{name:'恢复资料',exact:true}).click();
  await page.getByRole('button',{name:/^全部资料/}).click();await expect(page.getByTestId(`card-${group}`)).toBeVisible();
});
test('GUI creates a project and category, imports Unicode files, hides logs and builds a combination',async({page})=>{
  await page.getByRole('button',{name:'切换项目',exact:true}).click();await page.getByRole('button',{name:'新建项目',exact:true}).click();
  await page.getByLabel('名称',{exact:true}).fill('新科研项目');await page.getByRole('button',{name:'创建项目',exact:true}).click();await expect(page.locator('.breadcrumbs')).toContainText('新科研项目');
  await page.getByRole('button',{name:'新建分类',exact:true}).first().click();await page.getByLabel('名称',{exact:true}).fill('Baseline');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'Baseline',exact:true}).click();
  await page.getByRole('button',{name:'导入',exact:true}).click();await page.getByLabel('选择导入文件',{exact:true}).setInputFiles([{name:'中文数据.csv',mimeType:'text/csv',buffer:Buffer.from('Method,Score\nA,1\nB,2\n')},{name:'结果图.svg',mimeType:'image/svg+xml',buffer:await readFile('examples/result.svg')},{name:'运行.log',mimeType:'text/plain',buffer:Buffer.from('模拟运行完成')}]);
  await expect(page.getByLabel('运行.log 用途',{exact:true})).toHaveValue('supporting');await page.getByRole('button',{name:/导入 3 份资料/}).click();await expect(page.locator('.canvas-card')).toHaveCount(2);
  await page.getByRole('button',{name:'列表视图',exact:true}).click();await page.getByLabel('选择全部资料',{exact:true}).check();await page.getByRole('button',{name:'组合',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('对比结果');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.list-view tbody tr')).toHaveCount(1);
  await page.getByRole('button',{name:/^运行记录/}).click();await expect(page.locator('.run-file')).toHaveCount(1);await expect(page.locator('.run-file')).toContainText('运行.log');
});
test('unsaved changes are guarded when switching combination members',async({page,request})=>{
  await page.getByTestId(`card-${group}`).dblclick();await page.locator('.group-tabs').getByRole('button',{name:'缓存延迟',exact:true}).click();
  await page.locator('[data-cell="1:1"]').click();await page.getByLabel('单元格内容',{exact:true}).fill('77');await page.locator('.group-tabs').getByRole('button',{name:'缓存延迟对比图',exact:true}).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();await page.getByRole('button',{name:'返回编辑',exact:true}).click();await expect(page.getByLabel('单元格内容',{exact:true})).toHaveValue('77');
  await page.locator('.group-tabs').getByRole('button',{name:'缓存延迟对比图',exact:true}).click();await page.getByRole('button',{name:'保存并继续',exact:true}).click();await expect(page.locator('.image-viewer')).toBeVisible();
  expect((await(await request.get(`/api/items/${table}/table`)).json()).data[1][1]).toBe('77');
});
test('CLI imports appear in the open GUI and are isolated to their project',async({page,request})=>{
  const info=await(await request.get('/api/info')).json();
  await exec(process.execPath,['cli/labcanvas.mjs','import',path.resolve('examples/results.csv'),'--project',project,'--home',info.home,'--name','Agent 自动导入','--key','agent-live-import']);
  await expect(page.locator('.canvas-card')).toHaveCount(3,{timeout:12000});await page.getByLabel('搜索资料',{exact:true}).fill('Agent 自动导入');await expect(page.locator('.canvas-card')).toHaveCount(1);await expect(page.locator('.canvas-card')).toContainText('Agent 自动导入');
  await page.getByLabel('资料类型',{exact:true}).selectOption('image');await expect(page.locator('.canvas-card')).toHaveCount(0);
});
test('new table, multi-cell paste and text save are persisted',async({page,request})=>{
  await page.getByRole('button',{name:'新建菜单',exact:true}).click();await page.getByRole('button',{name:'新建表格',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('手动表格');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('grid')).toBeVisible();
  await page.locator('[data-cell="1:1"]').click();
  await page.evaluate(()=>{const target=document.querySelector('.sheet-scroll')!,data=new DataTransfer();data.setData('text/plain','12\t34\n56\t78');target.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
  await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.unsaved-label')).toHaveCount(0);
  const items=await(await request.get(`/api/projects/${project}/items?q=${encodeURIComponent('手动表格')}`)).json();const rows=(await(await request.get(`/api/items/${items[0].id}/table`)).json()).data;expect(rows[1].slice(1,3)).toEqual(['12','34']);expect(rows[2].slice(1,3)).toEqual(['56','78']);
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();await page.getByRole('button',{name:/^运行记录/}).click();await page.locator('.run-file').first().dblclick();await page.getByLabel('文本内容',{exact:true}).fill('模拟日志\n检查完成');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('.unsaved-label')).toHaveCount(0);
});
test('PDF content renders in the built-in viewer',async({page,request})=>{
  const form={files:{name:'sample.pdf',mimeType:'application/pdf',buffer:await readFile('tests/fixtures/sample.pdf')}};
  const response=await request.post(`/api/projects/${project}/uploads`,{multipart:form});expect(response.ok()).toBeTruthy();const id=(await response.json()).items[0].id;
  await page.getByRole('button',{name:'刷新资料',exact:true}).click();await page.getByTestId(`card-${id}`).dblclick();await expect(page.locator('.pdf-loading')).toHaveCount(0);
  await expect.poll(()=>page.locator('.pdf-canvas').evaluate((c:HTMLCanvasElement)=>{if(!c.width||!c.height)return 0;const d=c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]<180&&d[i+1]<180&&d[i+2]<180&&d[i+3]>200)n++;return n;})).toBeGreaterThan(500);
  await expect(page.locator('.pdf-page-counter').first()).toHaveText('第 1 / 1 页');
});
test('group titles work with type filters and date sorting uses experiment time',async({page,request})=>{
  await request.patch(`/api/projects/${project}/groups/${group}`,{data:{title:'Baseline 比较'}});
  const snapshot=await(await request.get(`/api/projects/${project}/snapshot`)).json();const independent=snapshot.items.find((i:{title:string})=>i.title==='独立表格');
  await request.patch(`/api/items/${independent.id}`,{data:{occurred_at:'2020-01-01T00:00:00Z'}});
  const older=await(await request.post(`/api/projects/${project}/tables`,{data:{name:'更早的实验',rows:3,columns:3}})).json();await request.patch(`/api/items/${older.items[0].id}`,{data:{occurred_at:'2019-01-01T00:00:00Z'}});
  await page.getByRole('button',{name:'刷新资料',exact:true}).click();await page.getByLabel('搜索资料',{exact:true}).fill('Baseline');await page.getByLabel('资料类型',{exact:true}).selectOption('image');await expect(page.locator('.canvas-card')).toHaveCount(1);await expect(page.locator('.canvas-card')).toContainText('Baseline 比较');
  await page.getByRole('button',{name:'清除搜索',exact:true}).click();await page.getByLabel('资料类型',{exact:true}).selectOption('all');await page.getByRole('button',{name:'列表视图',exact:true}).click();
  const rows=page.locator('.list-view tbody tr');await expect(rows).toHaveCount(3);await expect(rows.nth(0)).toContainText('Baseline 比较');await expect(rows.nth(1)).toContainText('独立表格');await expect(rows.nth(2)).toContainText('更早的实验');
});
test('classification pickers keep compact checkboxes and fit their dialogs',async({page,request})=>{
  const root=await(await request.post(`/api/projects/${project}/collections`,{data:{name:`Baseline_${'A'.repeat(70)}`}})).json();
  await request.post(`/api/projects/${project}/collections`,{data:{name:`缓存模块_${'B'.repeat(70)}`,parent_id:root.id}});
  for(let i=1;i<=16;i++)await request.post(`/api/projects/${project}/collections`,{data:{name:`分类 ${String(i).padStart(2,'0')}`}});
  for(const name of ['测试结果二','测试结果三'])await request.post(`/api/projects/${project}/tables`,{data:{name,rows:3,columns:3}});
  await page.getByRole('button',{name:'刷新资料',exact:true}).click();
  await page.getByRole('button',{name:'列表视图',exact:true}).click();
  for(const name of ['独立表格','测试结果二','测试结果三'])await page.getByLabel(`选择 ${name}`,{exact:true}).check();
  await page.getByRole('button',{name:'组合',exact:true}).click();
  const inspectPicker=async()=>{
    const dialog=page.getByRole('dialog'),picker=dialog.getByRole('group',{name:'加入分类',exact:true});
    await expect(picker.getByRole('checkbox')).toHaveCount(22);
    const sizes=await picker.locator('input[type="checkbox"]').evaluateAll(inputs=>inputs.map(input=>{const r=input.getBoundingClientRect();return{width:r.width,height:r.height};}));
    for(const size of sizes){expect(size.width).toBeLessThanOrEqual(24);expect(size.width).toBeGreaterThanOrEqual(12);expect(size.height).toBeLessThanOrEqual(24);}
    await expect.poll(()=>picker.locator('.collection-checks').evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
    const controls=await dialog.locator('.dialog-footer').boundingBox(),viewport=page.viewportSize()!;
    expect(controls!.x).toBeGreaterThanOrEqual(0);expect(controls!.y+controls!.height).toBeLessThanOrEqual(viewport.height);
    for(const name of ['名称','主预览']){
      const field=dialog.getByLabel(name,{exact:true});if(await field.count()){const rect=await field.boundingBox();expect(rect!.width).toBeGreaterThan(200);}
    }
  };
  for(const size of [{width:1500,height:980},{width:900,height:650}]){await page.setViewportSize(size);await inspectPicker();}
  const dialog=page.getByRole('dialog');await dialog.getByRole('checkbox',{name:'分类 16',exact:true}).check();await expect(dialog.getByRole('checkbox',{name:'分类 16',exact:true})).toBeChecked();
  await test.info().attach('group-classifications',{body:await dialog.screenshot(),contentType:'image/png'});
  await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(dialog).toHaveCount(0);
  const snapshot=await(await request.get(`/api/projects/${project}/snapshot`)).json(),created=snapshot.groups.find((g:{title:string})=>g.title==='结果组合'),chosen=snapshot.collections.find((c:{name:string})=>c.name==='分类 16');expect(created.collectionIds).toContain(chosen.id);
  await page.getByRole('button',{name:'导入',exact:true}).click();await inspectPicker();await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'新建菜单',exact:true}).click();await page.getByRole('button',{name:'新建表格',exact:true}).click();await inspectPicker();await page.getByRole('button',{name:'取消',exact:true}).click();
});
