import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, Scan, Loader2 } from 'lucide-react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import type { Item } from '../types';
export default function PdfViewer({item}:{item:Item}) {
  const[document,setDocument]=useState<PDFDocumentProxy|null>(null),[page,setPage]=useState(1),[zoom,setZoom]=useState(1),[size,setSize]=useState({width:0,height:0}),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const stage=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    let active=true,task:PDFDocumentLoadingTask|undefined;setLoading(true);setError('');
    void Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'),import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]).then(async([pdfjs,worker])=>{
      if(!active)return;pdfjs.GlobalWorkerOptions.workerSrc=worker.default;
      task=pdfjs.getDocument({url:`/api/items/${item.id}/file?v=${item.current_version}`,cMapUrl:'/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdfjs/standard_fonts/',wasmUrl:'/pdfjs/wasm/'});
      const doc=await task.promise;if(active)setDocument(doc);
    }).catch(e=>{if(active){setError(`PDF 无法打开：${e.message}`);setLoading(false);}});
    return()=>{active=false;void task?.destroy();};
  },[item.id,item.current_version]);
  useEffect(()=>{const el=stage.current;if(!el)return;const observer=new ResizeObserver(()=>setSize({width:el.clientWidth,height:el.clientHeight}));observer.observe(el);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    if(!document||!canvas.current||!size.width||!size.height)return;
    let active=true,render:RenderTask|undefined;const target=canvas.current;setLoading(true);setError('');
    void document.getPage(page).then(async p=>{
      if(!active)return;
      const raw=p.getViewport({scale:1}),fit=Math.min((size.width-64)/raw.width,(size.height-64)/raw.height),viewport=p.getViewport({scale:Math.max(.1,fit*zoom)}),dpr=window.devicePixelRatio||1;
      target.width=Math.floor(viewport.width*dpr);target.height=Math.floor(viewport.height*dpr);target.style.width=`${Math.floor(viewport.width)}px`;target.style.height=`${Math.floor(viewport.height)}px`;
      render=p.render({canvas:target,viewport,transform:dpr===1?undefined:[dpr,0,0,dpr,0,0]});await render.promise;if(active)setLoading(false);
    }).catch(e=>{if(active&&e.name!=='RenderingCancelledException'){setError(e.message);setLoading(false);}});
    return()=>{active=false;render?.cancel();};
  },[document,page,zoom,size]);
  return <div className="pdf-document"><div className="document-toolbar"><button className="icon-button" aria-label="上一页 PDF" disabled={!document||page===1} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={16}/></button><span className="pdf-page-counter">第 {page} / {document?.numPages||'–'} 页</span><button className="icon-button" aria-label="下一页 PDF" disabled={!document||page===document.numPages} onClick={()=>setPage(p=>p+1)}><ChevronRight size={16}/></button><span className="toolbar-spacer"/><button className="icon-button" aria-label="缩小 PDF" onClick={()=>setZoom(z=>Math.max(.25,z/1.2))}><Minus size={15}/></button><span className="pdf-page-counter">{zoom===1?'适应窗口':`${Math.round(zoom*100)}%`}</span><button className="icon-button" aria-label="放大 PDF" onClick={()=>setZoom(z=>Math.min(5,z*1.2))}><Plus size={15}/></button><button className="icon-button" aria-label="适应 PDF" onClick={()=>setZoom(1)}><Scan size={16}/></button></div><div className="pdf-stage" ref={stage}>{error?<div className="viewer-error"><span>{error}</span><a className="button" href={`/api/items/${item.id}/file?download=1`}>下载原文件</a></div>:<canvas className="pdf-canvas" ref={canvas} key={`${page}:${zoom}:${size.width}:${size.height}`} aria-label={`PDF 第 ${page} 页`}/>}</div>{loading&&!error&&<div className="pdf-loading"><Loader2 className="spin" size={20}/>载入 PDF</div>}</div>;
}
