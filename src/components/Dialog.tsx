import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
export function Dialog({ title, children, onClose, wide=false, className="", actions }: { title:string; children:ReactNode; onClose:()=>void; wide?:boolean; className?:string; actions?:ReactNode }) {
  const ref=useRef<HTMLDivElement>(null), closeRef=useRef(onClose); closeRef.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const focus=()=>{const el=ref.current?.querySelector<HTMLElement>('[autofocus],input:not([type=checkbox]),textarea,select,button');el?.focus();};
    const t=setTimeout(focus,10);
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeRef.current();}
      if(e.key==='Tab'){
        const els=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')||[]).filter(el=>el.offsetParent!==null);
        if(!els.length)return;const first=els[0],last=els[els.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',key,true);return()=>{clearTimeout(t);document.removeEventListener('keydown',key,true);previous?.focus();};
  },[]);
  return <div className="dialog-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className={`dialog ${wide?'dialog-wide':''} ${className}`} ref={ref} role="dialog" aria-modal="true" aria-label={title}><div className="dialog-heading"><h2>{title}</h2>{actions}<button className="icon-button" onClick={onClose} aria-label="关闭对话框"><X size={18}/></button></div>{children}</div></div>;
}
