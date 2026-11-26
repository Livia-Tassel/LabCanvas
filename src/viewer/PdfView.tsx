import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { rawUrl } from '../api';
import { openPdf, renderPage } from '../pdf';
import { clamp, isTyping, modKey, shortcut } from '../util';
import { Mascot } from '../components/Art';
import { useScrollSync } from './shared';
import type { ViewProps } from './shared';

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;

function Page({ document, number, width, ratio, root }: { document: PDFDocumentProxy; number: number; width: number; ratio: number; root: HTMLElement | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(number <= 2);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    // Pages are drawn shortly before they scroll into view.
    const observer = new IntersectionObserver(items => { if (items.some(item => item.isIntersecting)) setVisible(true); }, { root, rootMargin: '800px 0px' });
    observer.observe(holder.current!);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    if (!visible || !canvas.current) return;
    const task = renderPage(document, number, canvas.current, width);
    task.promise.then(() => setDrawn(true)).catch(() => {});
    return task.cancel;
  }, [visible, document, number, width]);
  return (
    // Until a page is drawn it takes the room of the first page, so the scroll bar is right from the start.
    <div ref={holder} className="pdf-page" data-page={number} style={{ width, minHeight: drawn ? undefined : Math.round(width * ratio) }}>
      <canvas ref={canvas} aria-label={`第 ${number} 页`} />
    </div>
  );
}

export function PdfView({ file, version, group, primary = false }: ViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.3);
  const [fitWidth, setFitWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  /** What is being typed into the page field. */
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState('');
  const shown = version ?? file.version;
  useScrollSync(scroller, group, document !== null);

  useEffect(() => {
    let active = true;
    let destroy = () => {};
    setDocument(null);
    setError('');
    openPdf(rawUrl({ id: file.id, version: shown })).then(async task => {
      if (!active) { await task.destroy(); return; }
      destroy = () => void task.destroy();
      const loaded = await task.promise;
      const size = (await loaded.getPage(1)).getViewport({ scale: 1 });
      if (!active) return;
      setRatio(size.height / size.width);
      setDocument(loaded);
    }).catch(failure => { if (active) setError(`PDF 无法打开：${failure.message}`); });
    return () => { active = false; destroy(); };
  }, [file.id, shown]);

  useEffect(() => {
    const element = scroller.current!;
    const update = () => setFitWidth(Math.min(1000, Math.max(320, element.clientWidth - 64)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const width = Math.round(fitWidth * zoom);
  const pages = () => Array.from(scroller.current?.querySelectorAll<HTMLElement>('.pdf-page') ?? []);

  const onScroll = () => {
    const element = scroller.current!;
    const line = element.scrollTop + element.clientHeight / 3;
    let current = 1;
    for (const item of pages()) {
      if (item.offsetTop > line) break;
      current = Number(item.dataset.page);
    }
    setPage(current);
  };

  /** The place to return to after the pages change size: a page and how far down it the window starts. */
  const anchor = useRef<{ page: number; fraction: number } | null>(null);
  const changeZoom = (next: number) => {
    const element = scroller.current;
    const item = pages()[page - 1];
    if (element && item) anchor.current = { page, fraction: (element.scrollTop - item.offsetTop) / Math.max(1, item.offsetHeight) };
    setZoom(clamp(next, MIN_ZOOM, MAX_ZOOM));
  };
  useLayoutEffect(() => {
    const at = anchor.current;
    const element = scroller.current;
    if (!at || !element) return;
    anchor.current = null;
    const item = pages()[at.page - 1];
    if (item) element.scrollTop = item.offsetTop + at.fraction * item.offsetHeight;
  }, [width]);

  const goToPage = (number: number) => {
    const element = scroller.current;
    const item = pages()[clamp(Math.round(number) || 1, 1, document?.numPages ?? 1) - 1];
    if (!element || !item) return;
    if (group) group.driver = element;
    element.scrollTop = item.offsetTop - 16;
  };

  const run = (command: string) => {
    if (command === 'zoomIn') changeZoom(zoom * 1.25);
    else if (command === 'zoomOut') changeZoom(zoom * 0.8);
    else if (command === 'fit' || command === 'actualSize') changeZoom(1);
  };
  const live = useRef(run);
  live.current = run;
  // Zoom keys act once, through the main pane, when two documents are side by side.
  useEffect(() => {
    if (!primary) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !modKey(event) || isTyping(event.target) || window.document.querySelector('.overlay-backdrop')) return;
      const command = ({ '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', 0: 'fit' } as Record<string, string>)[event.key];
      if (!command) return;
      event.preventDefault();
      live.current(command);
    };
    const onCommand = (event: Event) => live.current((event as CustomEvent<string>).detail);
    window.addEventListener('keydown', onKey);
    window.addEventListener('labcanvas:viewer', onCommand);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('labcanvas:viewer', onCommand);
    };
  }, [primary]);

  return (
    <div className="pdf-view">
      <div ref={scroller} className="pdf-scroll" tabIndex={0} onScroll={onScroll}>
        {error && <div className="viewer-message"><Mascot mood="oops" /><span>{error}</span></div>}
        {!error && !document && <div className="viewer-message"><Mascot mood="bubbling" size={76} /><span>正在载入…</span></div>}
        {document && width > 0 && Array.from({ length: document.numPages }, (_, index) => (
          <Page key={`${index}:${width}`} document={document} number={index + 1} width={width} ratio={ratio} root={scroller.current} />
        ))}
      </div>
      {document && (
        <div className="canvas-controls">
          <input
            className="page-input"
            aria-label="页码"
            title="输入页码后按回车跳转"
            inputMode="numeric"
            value={typed ?? String(page)}
            onChange={event => setTyped(event.target.value.replace(/\D/g, ''))}
            onFocus={event => event.target.select()}
            onBlur={() => setTyped(null)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                if (typed) goToPage(Number(typed));
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                event.stopPropagation();
                event.currentTarget.blur();
              }
            }}
          />
          <span className="page-total">/ {document.numPages}</span>
          <span className="controls-divider" />
          <button className="icon-button" aria-label="缩小" title={`缩小（${shortcut('-')}）`} disabled={zoom <= MIN_ZOOM} onClick={() => run('zoomOut')}><Minus size={14} /></button>
          <button className="zoom-level" title="适合宽度" onClick={() => run('fit')}>{Math.round(zoom * 100)}%</button>
          <button className="icon-button" aria-label="放大" title={`放大（${shortcut('+')}）`} disabled={zoom >= MAX_ZOOM} onClick={() => run('zoomIn')}><Plus size={14} /></button>
          <span className="controls-divider" />
          <button className="icon-button" aria-label="适合宽度" title={`适合宽度（${shortcut('0')}）`} onClick={() => run('fit')}><Maximize size={13} /></button>
        </div>
      )}
    </div>
  );
}
