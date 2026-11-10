import { useEffect, useState } from 'react';
import { X, Layers2, Plus, ArrowUpRight, Link2, Download, Copy, Terminal, FileClock, Unlink } from 'lucide-react';
import { useLab } from '../context';
import type { Entry } from '../types';
import { bytes, date, kindName, send } from '../api';
import { KindIcon, Preview } from './Preview';
export function Inspector({onClose}:{onClose:()=>void}) {
  const lab=useLab(),s=lab.snapshot;
  const group=s.groups.find(g=>g.id===lab.selected[0]);
  const item=group?s.items.find(i=>i.id===group.primary_item_id)||s.items.find(i=>group.memberIds.includes(i.id)):s.items.find(i=>i.id===lab.selected[0])||s.trash.find(i=>i.id===lab.selected[0]);
  const [title,setTitle]=useState(''),[description,setDescription]=useState('');
  const selectedId=lab.selected[0];
  useEffect(()=>{setTitle(group?.title||item?.title||'');setDescription(item?.description||'');},[selectedId,group?.title,item?.title,item?.description]);
  const saveTitle=()=>{if(!title.trim()){setTitle(group?.title||item?.title||'');return;}if(title===(group?.title||item?.title))return;void lab.run(()=>group?send(`/projects/${s.project.id}/groups/${group.id}`,'PATCH',{title}):send(`/items/${item!.id}`,'PATCH',{title}),'名称已更新');};
  const collectionIds=group?.collectionIds||item?.collectionIds||[];
  return <aside className="inspector"><div className="inspector-heading"><span>详细信息</span><button className="icon-button" aria-label="关闭详细信息" onClick={onClose}><X size={16}/></button></div>
    {!lab.selected.length?<div className="inspector-empty"><span>选择资料查看详情</span></div>:lab.selected.length>1?<div className="inspector-body"><h3>已选择 {lab.selected.length} 个条目</h3><button className="button full-width" onClick={()=>lab.showModal({type:'memberships'})}>管理分类</button><p className="muted small">按住 ⌘ / Ctrl 可逐项选择。</p></div>:item?<div className="inspector-body">
      <button className="inspector-preview" onClick={()=>lab.open(item.id,group?.id)} aria-label="打开所选资料"><Preview item={item}/><span><ArrowUpRight size={15}/></span></button>
      <div className="inspector-kind">{group?<Layers2 size={14}/>:<KindIcon kind={item.kind} size={14}/>}<span>{group?`结果组合 · ${group.memberIds.length} 份资料`:kindName(item.kind)}</span></div>
      <input className="inspector-title" aria-label="资料名称" value={title} onChange={e=>setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}} disabled={!!item.deleted_at}/>
      {group&&<><div className="inspector-section-title"><span>组合成员</span></div><div className="member-list">{group.memberIds.map(id=>{const m=s.items.find(i=>i.id===id);return m&&<div key={id}><button onClick={()=>lab.open(id,group.id)}><KindIcon kind={m.kind}/><span>{m.title}</span></button><button className="icon-button" title="从组合移出，保留资料" aria-label={`从组合移出 ${m.title}`} onClick={()=>void lab.run(()=>send(`/projects/${s.project.id}/groups/${group.id}/members/${id}`,'DELETE'),'已移出组合')}><Unlink size={13}/></button></div>;})}</div><label className="form-field compact"><span>主预览</span><select value={group.memberIds.includes(group.primary_item_id)?group.primary_item_id:group.memberIds[0]} onChange={e=>void lab.run(()=>send(`/projects/${s.project.id}/groups/${group.id}`,'PATCH',{primary:e.target.value}))}>{group.memberIds.map(id=><option key={id} value={id}>{s.items.find(i=>i.id===id)?.title}</option>)}</select></label></>}
      <div className="inspector-section-title"><span>分类</span><button className="icon-button" aria-label="管理所选资料分类" onClick={()=>lab.showModal({type:'memberships'})}><Plus size={14}/></button></div><div className="inspector-collections">{collectionIds.map(id=>{const c=s.collections.find(c=>c.id===id);return c&&<button key={id} title={c.path} onClick={()=>{lab.setView(`collection:${id}`);lab.setSelected([]);}}>{c.name}</button>;})}{!collectionIds.length&&<span className="muted small">尚未分类</span>}</div>
      {!group&&<><div className="inspector-section-title"><span>备注</span></div><textarea className="inspector-note" aria-label="资料备注" placeholder="添加备注" value={description} disabled={!!item.deleted_at} rows={4} onChange={e=>setDescription(e.target.value)} onBlur={()=>{if(description!==item.description)void lab.run(()=>send(`/items/${item.id}`,'PATCH',{description}),'备注已保存');}}/>
      <div className="inspector-section-title"><span>来源</span><button className="icon-button" aria-label="管理资料来源" disabled={!!item.deleted_at} onClick={()=>lab.showModal({type:'sources',item})}><Plus size={14}/></button></div><div className="source-list">{item.sources.map(source=><button key={source.source_item_id} onClick={()=>lab.open(source.source_item_id)} disabled={!!source.deleted_at}><Link2 size={13}/><span>{source.title}<small>使用 v{source.source_version}{source.stale?' · 来源已有新版本':''}{source.deleted_at?' · 已移到回收站':''}</small></span></button>)}{!item.sources.length&&<span className="muted small">未记录来源</span>}</div></>}
      <div className="inspector-section-title"><span>文件信息</span></div><dl className="metadata"><dt>文件</dt><dd title={item.original_name}>{item.original_name}</dd><dt>大小</dt><dd>{bytes(item.size)}</dd><dt>实验时间</dt><dd>{date(item.occurred_at,true)}</dd><dt>导入时间</dt><dd>{date(item.created_at,true)}</dd><dt>版本</dt><dd>v{item.current_version}</dd></dl>
      {item.run_id&&<button className="inspector-link" onClick={()=>{lab.setView('runs');lab.setSelected([item.id]);}}><Terminal size={14}/>关联运行记录<ArrowUpRight size={13}/></button>}
      <button className="inspector-link" onClick={()=>lab.open(item.id,group?.id)}><FileClock size={14}/>打开资料与版本记录<ArrowUpRight size={13}/></button><a className="inspector-link" href={`/api/items/${item.id}/file?download=1`}><Download size={14}/>下载{group?'主预览文件':'文件'}</a>
      <button className="inspector-link" onClick={()=>void navigator.clipboard.writeText(group?.id||item.id).then(()=>lab.notify('条目标识已复制'))}><Copy size={13}/>复制条目标识</button>
    </div>:<div className="inspector-empty">资料已移除</div>}
  </aside>;
}
export function entryFromItem(id:string,entries:Entry[]){return entries.find(e=>e.id===id);}
