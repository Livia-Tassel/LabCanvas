import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, LayoutGrid, List, Upload, Plus, PanelRight, ChevronDown, ChevronRight, FolderPlus, FileSpreadsheet, RefreshCw, X, Check, AlertCircle, Layers2, Trash2, FolderMinus, RotateCcw, Loader2, PanelLeftClose, PanelLeftOpen, Terminal } from 'lucide-react';
import type { Entry, Project, Snapshot, ModalState, Item, Group } from './types';
import { api, send } from './api';
import { Context } from './context';
import { Sidebar } from './components/Sidebar';
import { Canvas } from './components/Canvas';
import { ListView } from './components/ListView';
import { Inspector } from './components/Inspector';
import { Forms } from './components/Forms';
import { Viewer } from './components/Viewer';
import { Runs } from './components/Runs';

type Toast={id:number;message:string;error?:boolean};
export default function App(){
  const[projects,setProjects]=useState<Project[]>([]),[projectId,setProjectId]=useState(localStorage.getItem('labcanvas.project')||''),[snapshot,setSnapshot]=useState<Snapshot|null>(null),[view,setViewState]=useState('all'),[mode,setMode]=useState<'canvas'|'list'>((localStorage.getItem('labcanvas.mode') as 'canvas'|'list')||'canvas'),[query,setQuery]=useState(''),[kind,setKind]=useState('all'),[selected,setSelected]=useState<string[]>([]),[inspector,setInspector]=useState(true),[sidebar,setSidebar]=useState(true),[modal,setModal]=useState<ModalState|null>(null),[viewer,setViewer]=useState<{id:string;groupId?:string}|null>(null),[newMenu,setNewMenu]=useState(false),[toasts,setToasts]=useState<Toast[]>([]),[error,setError]=useState(''),[drop,setDrop]=useState(false);
  const search=useRef<HTMLInputElement>(null),sequence=useRef(0),projectRef=useRef(projectId),selectedRef=useRef(selected);projectRef.current=projectId;selectedRef.current=selected;
  const notify=useCallback((message:string,isError=false)=>{const id=Date.now()+Math.random();setToasts(old=>[...old.slice(-3),{id,message,error:isError}]);setTimeout(()=>setToasts(old=>old.filter(t=>t.id!==id)),isError?8000:3500);},[]);
  const setView=useCallback((key:string)=>{setViewState(key);setQuery('');setSelected([]);setKind('all');localStorage.setItem(`labcanvas.view.${projectRef.current}`,key);},[]);
  const chooseProject=useCallback((id:string)=>{setProjectId(id);projectRef.current=id;setSnapshot(null);setSelected([]);setQuery('');setKind('all');setViewState(localStorage.getItem(`labcanvas.view.${id}`)||'all');localStorage.setItem('labcanvas.project',id);},[]);
  const refresh=useCallback(async()=>{
    const seq=++sequence.current,pid=projectRef.current;
    const list=await api<Project[]>('/projects');if(seq!==sequence.current)return;setProjects(list);
    if(!pid||!list.some(p=>p.id===pid)){if(list.length)chooseProject(list[0].id);else setSnapshot(null);return;}
    const data=await api<Snapshot>(`/projects/${pid}/snapshot`);if(seq!==sequence.current||projectRef.current!==pid)return;
    setSnapshot(data);setError('');setViewState(old=>old.startsWith('collection:')&&!data.collections.some(c=>c.id===old.slice(11))?'all':old);
  },[chooseProject]);
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[projectId,refresh]);
  useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh().catch(()=>{});},4000);return()=>clearInterval(timer);},[refresh]);
  useEffect(()=>{document.title=snapshot?`${snapshot.project.name} — LabCanvas`:'LabCanvas';},[snapshot?.project.name]);
  const run=useCallback(async(fn:()=>Promise<unknown>,success?:string)=>{try{await fn();await refresh();if(success)notify(success);return true;}catch(e){notify((e as Error).message,true);return false;}},[refresh,notify]);
  const open=useCallback((id:string,groupId?:string)=>setViewer({id,groupId}),[]);
  const showModal=useCallback((state:ModalState)=>{setNewMenu(false);setModal(state);},[]);
  const closeModal=useCallback(()=>setModal(null),[]),closeViewer=useCallback(()=>setViewer(null),[]);
  useEffect(()=>{const handler=(event:Event)=>{const type=(event as CustomEvent).detail;if(['import','table','project','help'].includes(type))showModal({type});};window.addEventListener('labcanvas:action',handler);return()=>window.removeEventListener('labcanvas:action',handler);},[showModal]);
  const entries=useMemo<Entry[]>(()=>{
    if(!snapshot)return[];const s=snapshot,isTrash=view==='trash',collectionId=view.startsWith('collection:')?view.slice(11):null;
    const matches=(i:Item)=>`${i.title} ${i.original_name} ${i.description}`.toLowerCase().includes(query.toLowerCase())&&(kind==='all'||i.kind===kind);
    if(isTrash)return s.trash.filter(matches).map(i=>({id:i.id,title:i.title,item:i,members:[i],collectionIds:i.collectionIds}));
    const scoped=s.items.filter(i=>i.role==='result'&&(!collectionId||i.collectionIds.includes(collectionId))),groups=s.groups.filter(g=>g.memberIds.length>0&&(!collectionId||g.collectionIds.includes(collectionId)));
    const combined:Entry[]=[],hidden=new Set<string>();
    for(const g of groups){const members=g.memberIds.map(id=>s.items.find(i=>i.id===id)).filter(Boolean) as Item[];
      if(!members.length)continue;members.forEach(m=>hidden.add(m.id));
      if((g.title.toLowerCase().includes(query.toLowerCase())&&members.some(m=>kind==='all'||m.kind===kind))||members.some(matches)){
        const primary=members.find(m=>m.id===g.primary_item_id&&(kind==='all'||m.kind===kind))||members.find(matches)||members[0];combined.push({id:g.id,title:g.title,item:primary,group:g,members,collectionIds:g.collectionIds});
      }
    }
    const singles=scoped.filter(i=>!hidden.has(i.id)&&matches(i)).map(i=>({id:i.id,title:i.title,item:i,members:[i],collectionIds:i.collectionIds}));
    const all=[...combined,...singles];return view==='recent'?all.sort((a,b)=>b.item.created_at.localeCompare(a.item.created_at)).slice(0,50):all;
  },[snapshot,view,query,kind]);
  const selectedGroups=snapshot?.groups.filter(g=>selected.includes(g.id))||[],canGroup=selected.length>=2&&selected.every(id=>snapshot?.items.some(i=>i.id===id&&i.role==='result'));
  const selectionActive=selected.length>0;
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(modal||viewer)return;
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();search.current?.focus();return;}
      if(/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName))return;
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='a'){e.preventDefault();setSelected(entries.map(e=>e.id));}
      if(e.key==='Escape'){setSelected([]);setNewMenu(false);}
      if(e.key==='Enter'&&selected.length===1){const entry=entries.find(en=>en.id===selected[0]);if(entry)open(entry.item.id,entry.group?.id);}
      if((e.key==='Delete'||e.key==='Backspace')&&selected.length&&view!=='trash'){e.preventDefault();showModal({type:view.startsWith('collection:')&&!e.shiftKey?'remove':'trash'});}
    };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[modal,viewer,entries,selected,view,open,showModal]);
  const selectMode=(next:'canvas'|'list')=>{setMode(next);localStorage.setItem('labcanvas.mode',next);};
  const title=view==='all'?'全部资料':view==='recent'?'最近导入':view==='runs'?'运行记录':view==='trash'?'回收站':snapshot?.collections.find(c=>c.id===view.slice(11))?.name||'资料';
  const activeCollection=snapshot?.collections.find(c=>`collection:${c.id}`===view);
  const context= snapshot?{snapshot,selected,setSelected,view,setView,notify,run,refresh,open,showModal}:null;
  if(!snapshot||!context)return <div className="app-loading"><img src="/icon.svg" alt="LabCanvas"/><span>LabCanvas</span>{error?<><p>{error}</p><button className="button" onClick={()=>void refresh().catch(e=>setError(e.message))}>重试连接</button></>:!projects.length?<><span className="muted">正在连接本机资料库</span><button className="button" onClick={()=>void run(async()=>{const p=await send<Project>('/projects','POST',{name:'我的项目'});chooseProject(p.id);})}>新建项目</button></>:<Loader2 className="spin" size={20}/>}</div>;
  return <Context.Provider value={context}><div className="app-shell" onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDrop(true);}}} onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();setDrop(false);showModal({type:'import',files:Array.from(e.dataTransfer.files)});}}}>
    {sidebar&&<Sidebar projects={projects} projectId={projectId} onProject={chooseProject}/>}
    <main className="workspace"><header className="workspace-header"><button className="icon-button sidebar-toggle" aria-label={sidebar?'隐藏侧边栏':'显示侧边栏'} onClick={()=>setSidebar(!sidebar)}>{sidebar?<PanelLeftClose size={17}/>:<PanelLeftOpen size={17}/>}</button><div className="breadcrumbs"><span>{snapshot.project.name}</span><ChevronRight size={13}/><strong>{activeCollection?.path||title}</strong></div>{!!snapshot.project.is_demo&&<span className="demo-badge">模拟数据</span>}<div className="toolbar-spacer"/><button className="icon-button refresh-button" aria-label="刷新资料" onClick={()=>void refresh().then(()=>notify('已刷新')).catch(e=>notify(e.message,true))}><RefreshCw size={16}/></button><button className={`icon-button ${inspector?'active':''}`} aria-label="切换详细信息" onClick={()=>setInspector(!inspector)}><PanelRight size={18}/></button></header>
    <div className="workspace-toolbar"><h1>{title}</h1><span className="entry-count">{view==='runs'?`${snapshot.runs.length} 次运行`:`${entries.length} 个条目`}</span><div className="toolbar-spacer"/><div className="search-field"><Search size={15}/><input ref={search} aria-label="搜索资料" placeholder="搜索资料" value={query} onChange={e=>setQuery(e.target.value)}/>{query?<button className="icon-button" aria-label="清除搜索" onClick={()=>setQuery('')}><X size={12}/></button>:<kbd>⌘ K</kbd>}</div>{view!=='runs'&&<select className="kind-filter" aria-label="资料类型" value={kind} onChange={e=>setKind(e.target.value)}><option value="all">全部类型</option><option value="table">表格</option><option value="image">图片</option><option value="text">文本</option><option value="pdf">PDF</option><option value="file">其他文件</option></select>}{!['runs','trash'].includes(view)&&<div className="view-switch" aria-label="切换视图"><button className={mode==='canvas'?'active':''} aria-label="画布视图" onClick={()=>selectMode('canvas')}><LayoutGrid size={16}/></button><button className={mode==='list'?'active':''} aria-label="列表视图" onClick={()=>selectMode('list')}><List size={17}/></button></div>}{view!=='trash'&&<div className="import-actions"><button className="button" onClick={()=>showModal({type:'import'})}><Upload size={14}/>导入</button><button className="button new-menu-toggle" aria-label="新建菜单" onClick={()=>setNewMenu(!newMenu)}><ChevronDown size={13}/></button>{newMenu&&<><div className="menu-dismiss" onClick={()=>setNewMenu(false)}/><div className="context-menu new-menu"><button onClick={()=>showModal({type:'table'})}><FileSpreadsheet size={15}/>新建表格</button><button onClick={()=>showModal({type:'collection'})}><FolderPlus size={15}/>新建分类</button><button onClick={()=>showModal({type:'project'})}><Plus size={15}/>新建项目</button></div></>}</div>}</div>
    <div className="workspace-body"><div className="content-area">{selectionActive&&<div className="selection-toolbar"><span>已选择 {selected.length} 项</span><button onClick={()=>setSelected([])} aria-label="取消选择"><X size={13}/></button><span className="control-divider"/>{view==='trash'?<button onClick={()=>void run(()=>send(`/projects/${projectId}/restore`,'POST',{ids:selected}),'资料已恢复')}><RotateCcw size={14}/>恢复资料</button>:<><button onClick={()=>showModal({type:'memberships'})}><FolderPlus size={14}/>管理分类</button>{canGroup&&<button onClick={()=>showModal({type:'group'})}><Layers2 size={14}/>组合</button>}{selectedGroups.length===1&&selected.length===1&&<button onClick={()=>showModal({type:'dissolve',group:selectedGroups[0] as Group})}><Layers2 size={14}/>解散组合</button>}{view.startsWith('collection:')&&<button onClick={()=>showModal({type:'remove'})}><FolderMinus size={14}/>从分类移除</button>}<button className="danger" onClick={()=>showModal({type:'trash'})}><Trash2 size={14}/>回收站</button></>}</div>}
    {view==='runs'?<Runs query={query}/>:view==='trash'?<><div className="trash-note">移到回收站的资料保留分类关系、历史版本和画布位置。</div><ListView entries={entries}/></>:mode==='canvas'?<Canvas entries={entries}/>:<ListView entries={entries}/>}
    {drop&&<div className="app-drop-overlay" onDragLeave={e=>{if(e.target===e.currentTarget)setDrop(false);}}><Upload size={34}/><span>导入到 {snapshot.project.name}</span></div>}
    </div>{inspector&&<Inspector onClose={()=>setInspector(false)}/>}</div>
    <footer className="workspace-status"><span className="status-dot"/><span>本机存储</span><span className="status-separator"/><span>{snapshot.items.filter(i=>i.role==='result').length} 份结果资料</span><span className="toolbar-spacer"/><button onClick={()=>showModal({type:'help'})}><Terminal size={12}/>终端接口</button></footer></main>
  </div>{modal&&<Forms key={`${modal.type}:${modal.collection?.id||''}:${modal.item?.id||''}`} modal={modal} onClose={closeModal} onProjectCreated={chooseProject}/>} {viewer&&<Viewer key={viewer.id} itemId={viewer.id} groupId={viewer.groupId} onClose={closeViewer}/>}
  <div className="toast-container" aria-live="polite">{toasts.map(t=><div key={t.id} className={`toast ${t.error?'toast-error':''}`}>{t.error?<AlertCircle size={16}/>:<Check size={16}/>}<span>{t.message}</span><button className="icon-button" aria-label="关闭提示" onClick={()=>setToasts(old=>old.filter(x=>x.id!==t.id))}><X size={13}/></button></div>)}</div></Context.Provider>;
}
