import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Minus, Plus, Scan, Layers2, MoreHorizontal, Grip, MousePointer2 } from 'lucide-react';
import type { Entry, Layout, Position, Viewport } from '../types';
import { api, send, date } from '../api';
import { useLab } from '../context';
import { Preview, KindIcon } from './Preview';

type Gesture = { type: 'pan'|'drag'|'select'|'resize'; x: number; y: number; moved: boolean; viewport: Viewport; originals: Record<string,Position>; ids: string[] };
const clamp = (n: number, min: number, max: number) => Math.min(max,Math.max(min,n));
function placeMissing(entries: Entry[], positions: Record<string,Position>) {
  const result = { ...positions };
  for (const e of entries) if (!result[e.id]) {
    let index = 0, point: Position;
    do { point = { target_id: e.id, x: (index%2)*460, y: Math.floor(index/2)*370, width: 400 }; index++; }
    while (Object.values(result).some(p => Math.abs(p.x - point.x) < (p.width + point.width)/2 + 24 && Math.abs(p.y - point.y) < 335) && index < 10000);
    result[e.id] = point;
  }
  return result;
}
export function Canvas({ entries }: { entries: Entry[] }) {
  const lab = useLab(), project = lab.snapshot.project.id, viewKey = lab.view;
  const root = useRef<HTMLDivElement>(null), [positions, setPositions] = useState<Record<string,Position>>({}), [viewport, setViewport] = useState<Viewport>({ x:52,y:44,zoom:.85 }), [ready,setReady] = useState(false), [menu,setMenu] = useState<string|null>(null), [box,setBox] = useState<{x:number;y:number;w:number;h:number}|null>(null), [moving,setMoving] = useState(false);
  const positionsRef = useRef(positions), viewportRef = useRef(viewport), gesture = useRef<Gesture|null>(null), space = useRef(false), timer = useRef<ReturnType<typeof setTimeout>|null>(null), entriesRef = useRef(entries);
  entriesRef.current=entries; positionsRef.current=positions; viewportRef.current=viewport;
  const save = useCallback((p: Position[], v?: Viewport) => {
    void send(`/projects/${project}/layout?view=${encodeURIComponent(viewKey)}`, 'PUT', { positions:p, ...(v?{viewport:v}:{}) }).catch(e => lab.notify(e.message,true));
  }, [project,viewKey,lab.notify]);
  useEffect(() => {
    let active = true; setReady(false);
    api<Layout>(`/projects/${project}/layout?view=${encodeURIComponent(viewKey)}`).then(layout => {
      if (!active) return;
      const original = Object.fromEntries(layout.positions.map(p=>[p.target_id,p])), next=placeMissing(entriesRef.current,original);
      setPositions(next); positionsRef.current=next; setViewport(layout.viewport); viewportRef.current=layout.viewport; setReady(true);
      const added=Object.values(next).filter(p=>!original[p.target_id]); if(added.length) save(added);
    }).catch(e=>lab.notify(e.message,true));
    return () => { active=false; if(timer.current) {clearTimeout(timer.current); save([],viewportRef.current);} };
  }, [project,viewKey,save,lab.notify]);
  const entryKey=entries.map(e=>e.id).join(',');
  useEffect(()=>{
    if(!ready)return;
    const next=placeMissing(entriesRef.current,positionsRef.current), added=Object.values(next).filter(p=>!positionsRef.current[p.target_id]);
    if(added.length){setPositions(next); positionsRef.current=next; save(added);}
  },[entryKey,ready,save]);
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{if(e.code==='Space'&&!/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName)){space.current=true; if(root.current?.contains(document.activeElement))e.preventDefault();}};
    const up=()=>{space.current=false;};window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',up);
    return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',up);};
  },[]);
  useEffect(()=>{
    const el=root.current;if(!el)return;
    const wheel=(e:WheelEvent)=>{
      e.preventDefault(); const v=viewportRef.current;let next:Viewport;
      if(e.ctrlKey||e.metaKey){const rect=el.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,z=clamp(v.zoom*Math.exp(-e.deltaY*.008),.15,2.5);next={x:x-(x-v.x)*z/v.zoom,y:y-(y-v.y)*z/v.zoom,zoom:z};}
      else next={...v,x:v.x-e.deltaX,y:v.y-e.deltaY};
      viewportRef.current=next;setViewport(next);if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>{timer.current=null;save([],next);},250);
    };
    el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);
  },[save]);
  const begin=(e:ReactPointerEvent,entry?:Entry,resize=false)=>{
    if(e.button!==0&&e.button!==1)return;
    if((e.target as HTMLElement).closest('button')&&!resize)return;
    e.preventDefault();e.stopPropagation();root.current?.focus();
    const v=viewportRef.current;
    if(entry&&!space.current&&e.button!==1){
      if((e.shiftKey||e.metaKey||e.ctrlKey)&&!resize){lab.setSelected(lab.selected.includes(entry.id)?lab.selected.filter(i=>i!==entry.id):[...lab.selected,entry.id]);return;}
      const ids=resize?[entry.id]:lab.selected.includes(entry.id)?lab.selected:[entry.id];lab.setSelected(ids);
      gesture.current={type:resize?'resize':'drag',x:e.clientX,y:e.clientY,moved:false,viewport:v,originals:{...positionsRef.current},ids};
    }else gesture.current={type:e.shiftKey?'select':'pan',x:e.clientX,y:e.clientY,moved:false,viewport:v,originals:{...positionsRef.current},ids:[]};
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);setMenu(null);
  };
  const move=(e:ReactPointerEvent)=>{
    const g=gesture.current;if(!g)return;const dx=e.clientX-g.x,dy=e.clientY-g.y;if(Math.abs(dx)+Math.abs(dy)>3)g.moved=true;setMoving(g.moved);
    if(g.type==='pan'){const v={...g.viewport,x:g.viewport.x+dx,y:g.viewport.y+dy};viewportRef.current=v;setViewport(v);}
    if(g.type==='drag'||g.type==='resize'){
      const next={...g.originals};for(const target of g.ids){const p=g.originals[target];if(!p)continue;next[target]=g.type==='resize'?{...p,width:clamp(p.width+dx/g.viewport.zoom,260,1000)}:{...p,x:p.x+dx/g.viewport.zoom,y:p.y+dy/g.viewport.zoom};}positionsRef.current=next;setPositions(next);
    }
    if(g.type==='select'){const rect=root.current!.getBoundingClientRect();setBox({x:Math.min(g.x,e.clientX)-rect.left,y:Math.min(g.y,e.clientY)-rect.top,w:Math.abs(dx),h:Math.abs(dy)});}
  };
  const end=(e:ReactPointerEvent)=>{
    const g=gesture.current;if(!g)return;gesture.current=null;setMoving(false);
    if(g.type==='pan'){if(!g.moved)lab.setSelected([]);else save([],viewportRef.current);}
    if(g.type==='drag'&&g.moved){
      const collection=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-collection-id]')?.getAttribute('data-collection-id');
      if(collection){setPositions(g.originals);positionsRef.current=g.originals;void lab.run(async()=>{for(const target_id of g.ids)await send(`/projects/${project}/memberships`,'PUT',{target_id,collection_id:collection});},'已加入分类');}
      else save(g.ids.map(i=>positionsRef.current[i]).filter(Boolean));
    }
    if(g.type==='resize'&&g.moved)save(g.ids.map(i=>positionsRef.current[i]).filter(Boolean));
    if(g.type==='select'){
      const rect=root.current!.getBoundingClientRect(),v=viewportRef.current;
      const left=(Math.min(g.x,e.clientX)-rect.left-v.x)/v.zoom,right=(Math.max(g.x,e.clientX)-rect.left-v.x)/v.zoom,top=(Math.min(g.y,e.clientY)-rect.top-v.y)/v.zoom,bottom=(Math.max(g.y,e.clientY)-rect.top-v.y)/v.zoom;
      lab.setSelected(entries.filter(en=>{const p=positionsRef.current[en.id];return p&&p.x+p.width>left&&p.x<right&&p.y+310>top&&p.y<bottom;}).map(en=>en.id));setBox(null);
    }
  };
  const zoom=(factor:number)=>{const r=root.current!.getBoundingClientRect(),v=viewportRef.current,z=clamp(v.zoom*factor,.15,2.5),next={x:r.width/2-(r.width/2-v.x)*z/v.zoom,y:r.height/2-(r.height/2-v.y)*z/v.zoom,zoom:z};setViewport(next);viewportRef.current=next;save([],next);};
  const fit=()=>{
    const ps=entries.map(e=>positionsRef.current[e.id]).filter(Boolean);if(!ps.length)return;
    const r=root.current!.getBoundingClientRect(),minX=Math.min(...ps.map(p=>p.x)),minY=Math.min(...ps.map(p=>p.y)),w=Math.max(...ps.map(p=>p.x+p.width))-minX,h=Math.max(...ps.map(p=>p.y+310))-minY,z=clamp(Math.min((r.width-100)/w,(r.height-100)/h),.15,1.15);
    const next={x:(r.width-w*z)/2-minX*z,y:(r.height-h*z)/2-minY*z,zoom:z};setViewport(next);viewportRef.current=next;save([],next);
  };
  return <div className={`canvas ${moving?'moving':''}`} ref={root} tabIndex={0} data-testid="canvas" onPointerDown={e=>begin(e)} onPointerMove={move} onPointerUp={end} onPointerCancel={e=>{end(e);setBox(null);}} style={{backgroundSize:`${24*viewport.zoom}px ${24*viewport.zoom}px`,backgroundPosition:`${viewport.x}px ${viewport.y}px`}}>
    {ready&&<div className="canvas-world" style={{transform:`translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`}}>{entries.map(entry=>{
      const p=positions[entry.id];if(!p)return null;
      return <article key={entry.id} className={`canvas-card ${lab.selected.includes(entry.id)?'selected':''}`} style={{left:p.x,top:p.y,width:p.width,zIndex:lab.selected.includes(entry.id)?2:1}} data-testid={`card-${entry.id}`} onPointerDown={e=>begin(e,entry)} onDoubleClick={()=>{if(!moving)lab.open(entry.item.id,entry.group?.id);}}>
        <div className="card-header"><KindIcon kind={entry.item.kind}/><span title={entry.title}>{entry.title}</span>{entry.group&&<span className="subtle-badge"><Layers2 size={12}/>{entry.members.length}</span>}<button className="icon-button" aria-label={`${entry.title} 操作`} onClick={e=>{e.stopPropagation();lab.setSelected([entry.id]);setMenu(menu===entry.id?null:entry.id);}}><MoreHorizontal size={17}/></button></div>
        <div className="card-content"><Preview item={entry.item}/></div>
        <div className="card-footer"><span>{entry.group?'结果组合':entry.item.original_name.split('.').pop()?.toUpperCase()}</span>{entry.item.sources.some(s=>s.stale)&&<span className="stale-label">来源已更新</span>}<time>{date(entry.item.occurred_at)}</time><Grip size={12} className="resize-handle" aria-label="调整卡片大小" onPointerDown={e=>begin(e,entry,true)}/></div>
        {menu===entry.id&&<div className="context-menu card-menu" onPointerDown={e=>e.stopPropagation()}><button onClick={()=>{lab.open(entry.item.id,entry.group?.id);setMenu(null);}}>打开</button><button onClick={()=>{lab.showModal({type:'memberships'});setMenu(null);}}>管理分类</button>{entry.group?<button onClick={()=>{lab.showModal({type:'dissolve',group:entry.group});setMenu(null);}}>解散组合</button>:<button className="danger" onClick={()=>{lab.showModal({type:'trash'});setMenu(null);}}>移到回收站</button>}</div>}
      </article>;
    })}</div>}
    {box&&<div className="selection-box" style={{left:box.x,top:box.y,width:box.w,height:box.h}}/>}
    {!entries.length&&<div className="empty-state"><MousePointer2 size={27}/><span>当前视图没有资料</span><button className="button" onClick={()=>lab.showModal({type:'import'})}>导入资料</button></div>}
    <div className="canvas-hint">拖动空白平移<span>·</span>⌘ / Ctrl + 滚轮缩放<span>·</span>Shift 拖动框选</div>
    <div className="canvas-controls" onPointerDown={e=>e.stopPropagation()}><button className="icon-button" aria-label="缩小画布" onClick={()=>zoom(1/1.2)}><Minus size={16}/></button><button className="zoom-value" aria-label="重置画布缩放" onClick={()=>{const v={...viewport,zoom:1};setViewport(v);viewportRef.current=v;save([],v);}}>{Math.round(viewport.zoom*100)}%</button><button className="icon-button" aria-label="放大画布" onClick={()=>zoom(1.2)}><Plus size={16}/></button><span className="control-divider"/><button className="icon-button" aria-label="适应全部资料" onClick={fit}><Scan size={17}/></button></div>
  </div>;
}
