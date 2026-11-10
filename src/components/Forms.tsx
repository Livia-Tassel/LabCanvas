import { useCallback, useRef, useState } from 'react';
import { Upload, Plus, X, Loader2, FileJson, Copy, ExternalLink } from 'lucide-react';
import type { Group, Item, ModalState } from '../types';
import { useLab } from '../context';
import { api, send, bytes } from '../api';
import { Dialog } from './Dialog';
import { KindIcon } from './Preview';
const titles:Record<ModalState['type'],string>={project:'新建项目',editProject:'项目设置',collection:'新建分类',editCollection:'重命名分类',deleteCollection:'删除分类',import:'导入资料',table:'新建表格',group:'创建结果组合',memberships:'管理分类',trash:'移到回收站',remove:'从当前分类移除',dissolve:'解散组合',help:'终端与资料库',sources:'管理来源'};
export function Forms({modal,onClose,onProjectCreated}:{modal:ModalState;onClose:()=>void;onProjectCreated:(id:string)=>void}) {
  const lab=useLab(),s=lab.snapshot,p=s.project.id,[busy,setBusy]=useState(false),[name,setName]=useState(modal.type==='editProject'?s.project.name:modal.type==='editCollection'?modal.collection!.name:modal.type==='group'?'结果组合':modal.type==='table'?'未命名表格':''),[description,setDescription]=useState(modal.type==='editProject'?s.project.description:''),[slug,setSlug]=useState(''),[rows,setRows]=useState(10),[columns,setColumns]=useState(5),[primary,setPrimary]=useState(lab.selected[0]||''),[changes,setChanges]=useState<Record<string,boolean>>({}),[sources,setSources]=useState(modal.item?.sources.map(i=>i.source_item_id)||[]),[sourceQuery,setSourceQuery]=useState('');
  const [files,setFiles]=useState<File[]>(modal.files||[]),[roles,setRoles]=useState<Record<string,string>>({}),[chosenCollections,setChosenCollections]=useState<string[]>(lab.view.startsWith('collection:')?[lab.view.slice(11)]:[]),[runTitle,setRunTitle]=useState(''),[runTime,setRunTime]=useState(''),[command,setCommand]=useState(''),[home,setHome]=useState('');
  const fileInput=useRef<HTMLInputElement>(null);
  const close=useCallback(()=>{if(!busy)onClose();},[busy,onClose]);
  const targets=lab.selected.map(id=>s.groups.find(g=>g.id===id)||s.items.find(i=>i.id===id)||s.trash.find(i=>i.id===id)).filter(Boolean) as (Group|Item)[];
  const fileKey=(f:File)=>`${f.name}:${f.size}:${f.lastModified}`;
  const fileRole=(f:File)=>roles[fileKey(f)]||(/\.(log|out|conf|ini)$/i.test(f.name)?'supporting':'result');
  const addFiles=(incoming:File[])=>setFiles(old=>[...old,...incoming.filter(f=>!old.some(o=>fileKey(o)===fileKey(f)))]);
  const direct=(t:Group|Item)=>'directCollectionIds'in t?t.directCollectionIds:t.collectionIds;
  const trashIds=[...new Set(targets.flatMap(t=>'allMemberIds'in t?t.allMemberIds:[t.id]))];
  const submit=async()=>{
    setBusy(true);let success='已保存';
    const ok=await lab.run(async()=>{
      if(modal.type==='project'){const project=await send<{id:string}>('/projects','POST',{name,description,...(slug?{slug}:{})});onProjectCreated(project.id);success='项目已创建';}
      else if(modal.type==='editProject')await send(`/projects/${p}`,'PATCH',{name,description});
      else if(modal.type==='collection')await send(`/projects/${p}/collections`,'POST',{name,parent_id:modal.collection?.id});
      else if(modal.type==='editCollection')await send(`/projects/${p}/collections/${modal.collection!.id}`,'PATCH',{name});
      else if(modal.type==='deleteCollection'){await send(`/projects/${p}/collections/${modal.collection!.id}`,'DELETE');success='分类已删除，资料已保留';}
      else if(modal.type==='group'){await send(`/projects/${p}/groups`,'POST',{title:name,members:lab.selected,primary,collections:chosenCollections});success='组合已创建';}
      else if(modal.type==='table'){
        const result=await send<{items:{id:string}[]}>(`/projects/${p}/tables`,'POST',{name,rows,columns,collections:chosenCollections});lab.open(result.items[0].id);success='表格已创建';
      }else if(modal.type==='memberships'){
        for(const target of targets)for(const [collection_id,add]of Object.entries(changes)){
          if(add||direct(target).includes(collection_id))await send(`/projects/${p}/memberships`,add?'PUT':'DELETE',{target_id:target.id,collection_id});
        }
      }else if(modal.type==='trash'){await send(`/projects/${p}/trash`,'POST',{ids:trashIds});lab.setSelected([]);success='已移到回收站';}
      else if(modal.type==='remove'){
        for(const target of targets)await send(`/projects/${p}/memberships`,'DELETE',{target_id:target.id,collection_id:lab.view.slice(11)});
        lab.setSelected([]);success='已从当前分类移除';
      }else if(modal.type==='dissolve'){await send(`/projects/${p}/groups/${modal.group!.id}`,'DELETE');lab.setSelected([]);success='组合已解散，资料已保留';}
      else if(modal.type==='sources')await send(`/items/${modal.item!.id}/sources`,'PUT',{sources});
      else if(modal.type==='import'){
        const form=new FormData();files.forEach(f=>form.append('files',f));form.append('roles',JSON.stringify(files.map(fileRole)));form.append('collections',JSON.stringify(chosenCollections));
        if(runTitle||runTime||command)form.append('run',JSON.stringify({...(runTitle?{title:runTitle}:{}),...(runTime?{occurred_at:new Date(runTime).toISOString()}:{}),...(command?{command}:{})}));
        await api(`/projects/${p}/uploads`,{method:'POST',body:form});success=`已导入 ${files.length} 份资料`;
      }
    });
    setBusy(false);if(ok){lab.notify(success);onClose();}
  };
  const pickCollections=<fieldset className="form-field"><legend>加入分类</legend><div className="collection-checks">{s.collections.map(c=><label key={c.id}><input type="checkbox" checked={chosenCollections.includes(c.id)} onChange={e=>setChosenCollections(old=>e.target.checked?[...old,c.id]:old.filter(i=>i!==c.id))}/><span>{c.path}</span></label>)}{!s.collections.length&&<span className="muted">尚未创建分类</span>}</div></fieldset>;
  if(modal.type==='help')return <Dialog title={titles.help} onClose={close} wide><div className="dialog-body help-body"><p>GUI 与终端命令使用同一个本机资料库。支持直接导入文件或提交清单。</p><label className="form-field"><span>项目标识</span><div className="copy-line"><code>{s.project.slug}</code><button className="icon-button" aria-label="复制项目标识" onClick={()=>{void navigator.clipboard.writeText(s.project.slug).then(()=>lab.notify('已复制'));}}><Copy size={15}/></button></div></label><div className="code-block">labcanvas import results.csv --project {s.project.slug}{'\n'}labcanvas import --project {s.project.slug} \
  --manifest manifest.json --dry-run{'\n'}labcanvas import --project {s.project.slug} \
  --manifest manifest.json</div><p className="muted">在项目目录运行 npm link 后，可在任意目录使用 labcanvas 命令。</p><div className="help-links"><a href="/api/schema/import" target="_blank" rel="noreferrer"><FileJson size={15}/>导入清单 Schema<ExternalLink size={12}/></a><a href="/api/help" target="_blank" rel="noreferrer">接口说明<ExternalLink size={12}/></a></div><label className="form-field"><span>资料库位置</span><button className="text-button" onClick={()=>{void api<{home:string}>('/info').then(r=>setHome(r.home));}}>{home||'显示本机路径'}</button></label><div className="shortcut-grid"><span>打开资料</span><kbd>双击 / Enter</kbd><span>多选</span><kbd>⌘ / Ctrl + 单击</kbd><span>搜索</span><kbd>⌘ / Ctrl + K</kbd><span>保存表格</span><kbd>⌘ / Ctrl + S</kbd><span>从分类移除</span><kbd>Delete</kbd><span>关闭资料</span><kbd>Esc</kbd></div><p className="muted small">表格支持单元格值编辑与版本恢复；公式保留，计算在 Excel 中完成。原始文件可随时下载。</p></div><div className="dialog-footer"><button className="button" onClick={close}>关闭</button></div></Dialog>;
  const confirm=['deleteCollection','trash','remove','dissolve'].includes(modal.type);
  const disabled=busy||(!confirm&&['project','editProject','collection','editCollection','group','table'].includes(modal.type)&&!name.trim())||(modal.type==='import'&&!files.length);
  return <Dialog title={titles[modal.type]} onClose={close} wide={modal.type==='import'}><form onSubmit={e=>{e.preventDefault();void submit();}}><div className="dialog-body">
    {['project','editProject','collection','editCollection','group','table'].includes(modal.type)&&<label className="form-field"><span>名称</span><input autoFocus value={name} onChange={e=>setName(e.target.value)} maxLength={200} required/></label>}
    {modal.type==='project'&&<label className="form-field"><span>终端使用的项目标识 <small>可选，创建后保持稳定</small></span><input value={slug} onChange={e=>setSlug(e.target.value)} placeholder="例如 agentfs" pattern="[a-z0-9][a-z0-9-]*"/></label>}
    {['project','editProject'].includes(modal.type)&&<label className="form-field"><span>说明</span><textarea value={description} onChange={e=>setDescription(e.target.value)} rows={3}/></label>}
    {modal.type==='collection'&&modal.collection&&<p className="muted">上级分类：{modal.collection.path}</p>}
    {modal.type==='table'&&<><div className="form-two-columns"><label className="form-field"><span>行数（包含表头）</span><input type="number" min={1} max={1000} value={rows} onChange={e=>setRows(Number(e.target.value))}/></label><label className="form-field"><span>列数</span><input type="number" min={1} max={100} value={columns} onChange={e=>setColumns(Number(e.target.value))}/></label></div>{pickCollections}</>}
    {modal.type==='group'&&<><label className="form-field"><span>主预览</span><select value={primary} onChange={e=>setPrimary(e.target.value)}>{lab.selected.map(id=>{const item=s.items.find(i=>i.id===id);return item&&<option key={id} value={id}>{item.title}</option>;})}</select></label><p className="muted">将 {lab.selected.length} 份资料收在同一张卡片中，成员保留独立身份。</p>{pickCollections}</>}
    {modal.type==='memberships'&&<><p className="muted">管理 {targets.length} 个条目的直接分类。组合成员同时继承组合的分类。</p><div className="collection-checks tall">{s.collections.map(c=>{
      const all=targets.every(t=>direct(t).includes(c.id)),some=targets.some(t=>direct(t).includes(c.id)),checked=changes[c.id]??all;
      return <label key={c.id}><input type="checkbox" checked={checked} ref={el=>{if(el)el.indeterminate=changes[c.id]===undefined&&some&&!all;}} onChange={e=>setChanges(old=>({...old,[c.id]:e.target.checked}))}/><span>{c.path}</span></label>;
    })}{!s.collections.length&&<p className="muted">先在侧边栏创建分类。</p>}</div></>}
    {modal.type==='sources'&&<><input className="full-input" placeholder="查找来源资料" value={sourceQuery} onChange={e=>setSourceQuery(e.target.value)}/><div className="collection-checks tall">{s.items.filter(i=>i.id!==modal.item!.id&&`${i.title} ${i.original_name}`.toLowerCase().includes(sourceQuery.toLowerCase())).map(i=><label key={i.id}><input type="checkbox" checked={sources.includes(i.id)} onChange={e=>setSources(old=>e.target.checked?[...old,i.id]:old.filter(id=>id!==i.id))}/><KindIcon kind={i.kind}/><span>{i.title}</span><small>v{i.current_version}</small></label>)}</div><p className="muted">保存时记录来源的当前版本。</p></>}
    {modal.type==='import'&&<><input ref={fileInput} className="visually-hidden" type="file" multiple aria-label="选择导入文件" onChange={e=>{addFiles(Array.from(e.target.files||[]));e.target.value='';}}/><button className="drop-zone" type="button" onClick={()=>fileInput.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();addFiles(Array.from(e.dataTransfer.files));}}><Upload size={25}/><span>选择文件，或拖放到这里</span><small>表格、图片、文本、PDF 及其他文件 · 单个文件最大 100 MB</small></button>
      {!!files.length&&<div className="import-files">{files.map(f=><div className="import-file" key={fileKey(f)}><KindIcon kind={/\.(csv|tsv|xlsx)$/i.test(f.name)?'table':/\.(png|jpe?g|svg|webp)$/i.test(f.name)?'image':'file'}/><span title={f.name}>{f.name}<small>{bytes(f.size)}</small></span><select aria-label={`${f.name} 用途`} value={fileRole(f)} onChange={e=>setRoles(old=>({...old,[fileKey(f)]:e.target.value}))}><option value="result">结果资料</option><option value="supporting">辅助资料</option></select><button className="icon-button" type="button" aria-label={`移除 ${f.name}`} onClick={()=>setFiles(old=>old.filter(x=>fileKey(x)!==fileKey(f)))}><X size={14}/></button></div>)}</div>}
      {pickCollections}<details className="import-run"><summary>运行信息（可选）</summary><label className="form-field"><span>运行名称</span><input value={runTitle} onChange={e=>setRunTitle(e.target.value)} placeholder="例如 缓存模块对比"/></label><label className="form-field"><span>实验时间</span><input type="datetime-local" value={runTime} onChange={e=>setRunTime(e.target.value)}/></label><label className="form-field"><span>生成命令</span><input value={command} onChange={e=>setCommand(e.target.value)}/></label></details><p className="muted small">辅助资料收进运行记录，默认不出现在画布中。</p></>}
    {modal.type==='deleteCollection'&&<p>删除“{modal.collection!.name}”及其子分类。所有资料条目会保留。</p>}
    {modal.type==='trash'&&<p>将 {trashIds.length} 份资料移到回收站。它们会从所有分类和画布中隐藏，恢复后保留原来的分类与位置。</p>}
    {modal.type==='remove'&&<p>将所选条目从当前分类移除。其他分类中的引用和资料本身都会保留。</p>}
    {modal.type==='dissolve'&&<p>解散“{modal.group!.title}”。成员会独立展示，原组合的分类会保留到成员上。</p>}
  </div><div className="dialog-footer"><button type="button" className="button" onClick={close} disabled={busy}>取消</button><button type="submit" className={`button ${modal.type==='trash'||modal.type==='deleteCollection'?'button-danger':'button-primary'}`} disabled={disabled}>{busy?<><Loader2 size={15} className="spin"/>处理中</>:modal.type==='import'?<><Plus size={15}/>导入 {files.length||''} 份资料</>:confirm?'确认':modal.type==='project'?'创建项目':'保存'}</button></div></form></Dialog>;
}
