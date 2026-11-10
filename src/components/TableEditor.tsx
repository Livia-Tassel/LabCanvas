import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Save, Undo2, Plus, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import type { Item, TableData } from '../types';
import { useLab } from '../context';
import { api, send, columnName } from '../api';
export type EditorProps={item:Item;onSaved:(item:Item)=>void;onDirty:(dirty:boolean)=>void;saveRef:MutableRefObject<(()=>Promise<boolean>)|null>};
export function TableEditor({item,onSaved,onDirty,saveRef}:EditorProps){
  const lab=useLab(),[data,setData]=useState<TableData|null>(null),[sheet,setSheet]=useState(0),[offset,setOffset]=useState(0),[colOffset,setColOffset]=useState(0),[changes,setChanges]=useState<Record<string,string>>({}),[selected,setSelected]=useState({row:0,column:0}),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0),[extras,setExtras]=useState<Record<number,{rows:number;cols:number}>>({});
  const baseVersion=useRef(item.current_version),changesRef=useRef(changes),grid=useRef<HTMLDivElement>(null);changesRef.current=changes;
  useEffect(()=>{
    let active=true;setError('');setData(null);
    api<TableData>(`/items/${item.id}/table?sheet=${sheet}&offset=${offset}&col_offset=${colOffset}`).then(r=>{if(active){setData(r);if(!Object.keys(changesRef.current).length)baseVersion.current=r.version;}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};
  },[item.id,sheet,offset,colOffset,reload]);
  const count=Object.keys(changes).length;
  useEffect(()=>onDirty(count>0),[count,onDirty]);
  const save=useCallback(async()=>{
    if(!Object.keys(changesRef.current).length)return true;setBusy(true);
    try{
      const edits=Object.entries(changesRef.current).map(([key,value])=>{const[s,row,column]=key.split(':').map(Number);return{sheet:s,row,column,value};});
      const updated=await send<Item>(`/items/${item.id}/table`,'PATCH',{expected_version:baseVersion.current,changes:edits});
      baseVersion.current=updated.current_version;setChanges({});changesRef.current={};setExtras({});onSaved(updated);setReload(r=>r+1);lab.notify('表格已保存');return true;
    }catch(e){lab.notify((e as Error).message,true);return false;}finally{setBusy(false);}
  },[item.id,onSaved,lab.notify]);
  useEffect(()=>{saveRef.current=save;return()=>{saveRef.current=null;};},[save,saveRef]);
  const keyFor=(row:number,column:number)=>`${sheet}:${row}:${column}`;
  const valueAt=(row:number,column:number)=>changes[keyFor(row,column)]??data?.data[row-offset]?.[column-colOffset]??'';
  const rawAt=(row:number,column:number)=>changes[keyFor(row,column)]??data?.formulas[`${row}:${column}`]??valueAt(row,column);
  const setValue=(row:number,column:number,value:string)=>setChanges(old=>({...old,[keyFor(row,column)]:value}));
  const totalRows=Math.max(data?.totalRows||1,extras[sheet]?.rows||0),totalCols=Math.max(data?.totalColumns||1,extras[sheet]?.cols||0);
  const navigate=(row:number,column:number)=>{
    row=Math.max(0,Math.min(totalRows-1,row));column=Math.max(0,Math.min(totalCols-1,column));setSelected({row,column});setEditing(false);
    if(row<offset||row>=offset+100)setOffset(Math.floor(row/100)*100);
    if(column<colOffset||column>=colOffset+60)setColOffset(Math.floor(column/60)*60);
    requestAnimationFrame(()=>grid.current?.querySelector<HTMLElement>(`[data-cell="${row}:${column}"]`)?.focus());
  };
  const keyboard=(e:ReactKeyboardEvent)=>{
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();void save();return;}
    if((e.target as HTMLElement).tagName==='INPUT'){
      if(e.key==='Enter'){e.preventDefault();navigate(selected.row+(e.shiftKey?-1:1),selected.column);}else if(e.key==='Tab'){e.preventDefault();navigate(selected.row,selected.column+(e.shiftKey?-1:1));}else if(e.key==='Escape'){e.preventDefault();setEditing(false);grid.current?.focus();}
      return;
    }
    const direction:Record<string,[number,number]>={ArrowDown:[1,0],ArrowUp:[-1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]};
    if(direction[e.key]){e.preventDefault();const[r,c]=direction[e.key];navigate(selected.row+r,selected.column+c);}
    else if(e.key==='Enter'||e.key==='F2'){e.preventDefault();setEditing(true);}
    else if(e.key==='Backspace'||e.key==='Delete'){e.preventDefault();setValue(selected.row,selected.column,'');}
    else if(e.key.length===1&&!e.metaKey&&!e.ctrlKey&&!e.altKey){e.preventDefault();setValue(selected.row,selected.column,e.key);setEditing(true);}
  };
  if(error)return <div className="viewer-error"><span>{error}</span><a className="button" href={`/api/items/${item.id}/file?download=1`}>下载原文件</a></div>;
  return <div className="table-editor" onKeyDown={keyboard}>
    <div className="document-toolbar"><span className="muted small">单元格编辑</span><span className="toolbar-spacer"/>{count>0&&<span className="unsaved-label">{count} 处未保存</span>}<button className="button small-button" disabled={!count||busy} onClick={()=>{setChanges({});changesRef.current={};setExtras({});}}><Undo2 size={14}/>撤销修改</button><button className="button button-primary small-button" disabled={!count||busy} onClick={()=>void save()}>{busy?<Loader2 className="spin" size={14}/>:<Save size={14}/>}保存</button></div>
    <div className="formula-bar"><span className="cell-address">{columnName(selected.column)}{selected.row+1}</span><span className="fx">ƒx</span><input aria-label="单元格内容" value={rawAt(selected.row,selected.column)} onChange={e=>setValue(selected.row,selected.column,e.target.value)} disabled={!data||busy}/></div>
    <div className="sheet-scroll" ref={grid} tabIndex={0} onPaste={e=>{
      const text=e.clipboardData.getData('text/plain');if(!text)return;
      if((e.target as HTMLElement).tagName==='INPUT'&&!text.includes('\t')&&!text.includes('\n'))return;
      e.preventDefault();const rows=text.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n').map(r=>r.split('\t'));
      if(rows.reduce((n,r)=>n+r.length,0)>10000){lab.notify('一次最多粘贴 10000 个单元格',true);return;}
      const next={...changes};rows.forEach((r,ri)=>r.forEach((v,ci)=>{next[keyFor(selected.row+ri,selected.column+ci)]=v;}));setChanges(next);setExtras(old=>({...old,[sheet]:{rows:Math.max(totalRows,selected.row+rows.length),cols:Math.max(totalCols,selected.column+Math.max(...rows.map(r=>r.length)))}}));
    }}>
    {!data?<div className="loading-inline"><Loader2 size={20} className="spin"/>载入表格</div>:<table className="sheet-grid" role="grid" aria-label={item.title}><thead><tr><th className="sheet-corner"/>{Array.from({length:Math.min(60,totalCols-colOffset)},(_,c)=><th key={c}>{columnName(colOffset+c)}</th>)}<th className="add-column"><button aria-label="添加一列" onClick={()=>{setExtras(old=>({...old,[sheet]:{rows:totalRows,cols:totalCols+1}}));setValue(0,totalCols,'');if(totalCols>=colOffset+60)setColOffset(Math.floor(totalCols/60)*60);}}><Plus size={13}/></button></th></tr></thead><tbody>{Array.from({length:Math.min(100,totalRows-offset)},(_,ri)=>{const r=ri+offset;return <tr key={r}><th>{r+1}</th>{Array.from({length:Math.min(60,totalCols-colOffset)},(_,ci)=>{const c=ci+colOffset,isSelected=selected.row===r&&selected.column===c,k=keyFor(r,c);return <td key={c} data-cell={`${r}:${c}`} aria-label={`${columnName(c)}${r+1}`} tabIndex={isSelected?0:-1} className={`${isSelected?'cell-selected':''} ${k in changes?'cell-changed':''} ${r===0?'sheet-header-row':''}`} onClick={()=>{setSelected({row:r,column:c});setEditing(false);}} onDoubleClick={()=>{setSelected({row:r,column:c});setEditing(true);}}>{isSelected&&editing?<input autoFocus aria-label={`编辑 ${columnName(c)}${r+1}`} value={rawAt(r,c)} onClick={e=>e.stopPropagation()} onChange={e=>setValue(r,c,e.target.value)} onBlur={()=>setEditing(false)}/>:<span>{valueAt(r,c)}</span>}</td>;})}<td className="sheet-end"/></tr>;})}<tr><th><button aria-label="添加一行" onClick={()=>{setExtras(old=>({...old,[sheet]:{rows:totalRows+1,cols:totalCols}}));setValue(totalRows,0,'');if(totalRows>=offset+100)setOffset(Math.floor(totalRows/100)*100);}}><Plus size={13}/></button></th><td colSpan={Math.min(60,totalCols-colOffset)+1} className="sheet-bottom"/></tr></tbody></table>}
    </div>
    <div className="sheet-tabs">{data?.sheets.map((s,i)=><button key={s.name} className={i===sheet?'active':''} onClick={()=>{setSheet(i);setOffset(0);setColOffset(0);setSelected({row:0,column:0});setEditing(false);}}>{s.name}</button>)}<span className="toolbar-spacer"/><span className="sheet-dimensions">{totalRows} 行 × {totalCols} 列</span><button className="icon-button" aria-label="上一页行" disabled={offset===0} onClick={()=>{setOffset(Math.max(0,offset-100));setSelected({row:Math.max(0,offset-100),column:colOffset});}}><ChevronLeft size={15}/></button><span className="small muted">{offset+1}–{Math.min(offset+100,totalRows)}</span><button className="icon-button" aria-label="下一页行" disabled={offset+100>=totalRows} onClick={()=>{setOffset(offset+100);setSelected({row:offset+100,column:colOffset});}}><ChevronRight size={15}/></button>{totalCols>60&&<><span className="control-divider"/><button className="icon-button" aria-label="上一页列" disabled={colOffset===0} onClick={()=>setColOffset(Math.max(0,colOffset-60))}><ChevronLeft size={15}/></button><span className="small muted">{columnName(colOffset)}–{columnName(Math.min(colOffset+59,totalCols-1))}</span><button className="icon-button" aria-label="下一页列" disabled={colOffset+60>=totalCols} onClick={()=>setColOffset(colOffset+60)}><ChevronRight size={15}/></button></>}</div>
    {!!Object.keys(data?.formulas||{}).length&&<div className="formula-notice">公式已保留；应用内编辑数值后，请在 Excel 中重新计算。</div>}
  </div>;
}
