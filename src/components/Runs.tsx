import { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal, ArrowUpRight } from 'lucide-react';
import { useLab } from '../context';
import { date, bytes } from '../api';
import { KindIcon } from './Preview';
import type { Item } from '../types';
export function Runs({query}:{query:string}){
  const lab=useLab(),s=lab.snapshot,[collapsed,setCollapsed]=useState<string[]>([]),[results,setResults]=useState<string[]>([]),q=query.toLowerCase();
  const itemRow=(item:Item)=><button key={item.id} className={`run-file ${lab.selected.includes(item.id)?'selected':''}`} onClick={e=>lab.setSelected(e.metaKey||e.ctrlKey?[...new Set([...lab.selected,item.id])]:[item.id])} onDoubleClick={()=>lab.open(item.id)}><KindIcon kind={item.kind}/><span>{item.title}<small>{item.original_name}</small></span><span className="run-role">{item.role==='supporting'?'辅助资料':'结果资料'}</span><small>{bytes(item.size)}</small><ArrowUpRight size={13} className="muted"/></button>;
  const runs=s.runs.filter(r=>`${r.title} ${r.command}`.toLowerCase().includes(q)||r.itemIds.some(id=>s.items.find(i=>i.id===id)?.title.toLowerCase().includes(q)));
  const orphans=s.items.filter(i=>i.role==='supporting'&&!i.run_id&&`${i.title} ${i.original_name}`.toLowerCase().includes(q));
  return <div className="runs-view">{runs.map((r,index)=>{
    const day=date(r.occurred_at),prev=index>0?date(runs[index-1].occurred_at):'';const items=r.itemIds.map(id=>s.items.find(i=>i.id===id)).filter(Boolean) as Item[],supporting=items.filter(i=>i.role==='supporting'),resultItems=items.filter(i=>i.role==='result');
    return <div key={r.id}>{day!==prev&&<div className="run-day">{day}</div>}<section className="run-record"><div className="run-heading"><button onClick={()=>setCollapsed(old=>old.includes(r.id)?old.filter(x=>x!==r.id):[...old,r.id])}>{collapsed.includes(r.id)?<ChevronRight size={14}/>:<ChevronDown size={14}/>}<Terminal size={16}/><strong>{r.title}</strong></button><time>{new Date(r.occurred_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time></div>{!collapsed.includes(r.id)&&<div className="run-body">{r.command&&<pre className="run-command">{r.command}</pre>}<div>{supporting.map(itemRow)}</div>{!supporting.length&&<p className="muted small">此运行没有辅助资料</p>}{!!resultItems.length&&<><button className="run-results-toggle" onClick={()=>setResults(old=>old.includes(r.id)?old.filter(x=>x!==r.id):[...old,r.id])}>{results.includes(r.id)?<ChevronDown size={13}/>:<ChevronRight size={13}/>}关联结果 · {resultItems.length} 份资料</button>{results.includes(r.id)&&<div>{resultItems.map(itemRow)}</div>}</>}</div>}</section></div>;
  })}{!!orphans.length&&<><div className="run-day">未关联运行的辅助资料</div><section className="run-record run-body">{orphans.map(itemRow)}</section></>}{!runs.length&&!orphans.length&&<div className="empty-state"><Terminal size={28}/><span>没有运行记录</span><button className="button" onClick={()=>lab.showModal({type:'import'})}>导入辅助资料</button></div>}</div>;
}
