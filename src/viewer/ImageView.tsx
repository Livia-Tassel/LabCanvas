import { useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import { rawUrl, thumbnailUrl } from '../api';
import { clamp, isTyping, modKey, shortcut } from '../util';
import type { ImageFrame, ViewProps } from './shared';

export function ImageView({ file, version, link, primary = false }: ViewProps) {
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState(false);
  const [own, setOwn] = useState<ImageFrame>({ x: 0, y: 0, zoom: 1 });
  // Two images shown side by side pan and zoom together.
  const view = link?.view ?? own;
  const setView = link?.setView ?? setOwn;
  const viewRef = useRef(view);
  viewRef.current = view;
  const setViewRef = useRef(setView);
  setViewRef.current = setView;
  const target = { id: file.id, version: version ?? file.version };

  const fit = (size = natural) => {
    const element = stage.current;
    if (!element || !size) return;
    const zoom = Math.min((element.clientWidth - 48) / size.width, (element.clientHeight - 48) / size.height, 1);
    setViewRef.current({ x: (element.clientWidth - size.width * zoom) / 2, y: (element.clientHeight - size.height * zoom) / 2, zoom });
  };

  const zoomAt = (factor: number, px?: number, py?: number) => {
    const element = stage.current!;
    const current = viewRef.current;
    const zoom = clamp(current.zoom * factor, 0.02, 16);
    const cx = px ?? element.clientWidth / 2;
    const cy = py ?? element.clientHeight / 2;
    setViewRef.current({ x: cx - (cx - current.x) * (zoom / current.zoom), y: cy - (cy - current.y) * (zoom / current.zoom), zoom });
  };

  const actions = useRef({ fit, zoomAt });
  actions.current = { fit, zoomAt };

  useEffect(() => {
    const element = stage.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) actions.current.zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - box.left, event.clientY - box.top);
      else setViewRef.current({ ...viewRef.current, x: viewRef.current.x - event.deltaX, y: viewRef.current.y - event.deltaY });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // Zoom keys and menu commands act once, through the main pane, even when two images share a view.
  useEffect(() => {
    if (!primary) return;
    const run = (command: string | undefined) => {
      if (command === 'zoomIn') actions.current.zoomAt(1.25);
      else if (command === 'zoomOut') actions.current.zoomAt(0.8);
      else if (command === 'fit') actions.current.fit();
      else if (command === 'actualSize') actions.current.zoomAt(1 / viewRef.current.zoom);
      else return false;
      return true;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !modKey(event) || isTyping(event.target) || document.querySelector('.overlay-backdrop')) return;
      const command = ({ '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', 0: 'fit', 1: 'actualSize' } as Record<string, string>)[event.key];
      if (run(command)) event.preventDefault();
    };
    const onCommand = (event: Event) => void run((event as CustomEvent<string>).detail);
    window.addEventListener('keydown', onKey);
    window.addEventListener('labcanvas:viewer', onCommand);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('labcanvas:viewer', onCommand);
    };
  }, [primary]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const origin = viewRef.current;
    const onMove = (move: PointerEvent) => setViewRef.current({ ...origin, x: origin.x + move.clientX - event.clientX, y: origin.y + move.clientY - event.clientY });
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="image-view">
      <div ref={stage} className="image-stage" onPointerDown={onPointerDown} onDoubleClick={() => fit()}>
        <img
          src={fallback ? thumbnailUrl(target) : rawUrl(target)}
          alt={file.name}
          draggable={false}
          onError={() => {
            if (!fallback && file.preview.image) setFallback(true);
            else setError(true);
          }}
          onLoad={event => {
            // SVG files without intrinsic size report 0; fall back to the size measured at import.
            const size = {
              width: event.currentTarget.naturalWidth || file.preview.width || 800,
              height: event.currentTarget.naturalHeight || file.preview.height || 600
            };
            setNatural(size);
            // The second image of a pair keeps the view the first one set.
            if (!link?.view) fit(size);
          }}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
            width: natural?.width,
            height: natural?.height,
            visibility: natural ? 'visible' : 'hidden'
          }}
        />
      </div>
      {error && <div className="empty-state">无法打开图片，可下载原文件查看</div>}
      {natural && <div className="image-size">{natural.width} × {natural.height}</div>}
      <div className="canvas-controls">
        <button className="icon-button" aria-label="缩小" title={`缩小（${shortcut('-')}）`} disabled={!natural} onClick={() => zoomAt(0.8)}><Minus size={14} /></button>
        <button className="zoom-level" title={`实际大小（${shortcut('1')}）`} disabled={!natural} onClick={() => zoomAt(1 / view.zoom)}>{Math.round(view.zoom * 100)}%</button>
        <button className="icon-button" aria-label="放大" title={`放大（${shortcut('+')}）`} disabled={!natural} onClick={() => zoomAt(1.25)}><Plus size={14} /></button>
        <span className="controls-divider" />
        <button className="icon-button" aria-label="适应窗口" title={`适应窗口（${shortcut('0')}）`} disabled={!natural} onClick={() => fit()}><Maximize size={13} /></button>
      </div>
    </div>
  );
}
