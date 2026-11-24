import { useEffect, useRef, useState } from 'react';
import { ListFilter, PanelRight, Plus, Search, Table, X } from 'lucide-react';
import { useLab } from './state';
import { ErrorBoundary, useOverlay } from './components/ui';
import { Sidebar } from './components/Sidebar';
import { Canvas } from './components/Canvas';
import { ListView } from './components/ListView';
import { Inspector } from './components/Inspector';
import { Dialogs } from './components/Dialogs';
import { Viewer } from './viewer/Viewer';
import { KINDS, droppedFiles, isTyping, kindLabel, modKey, shortcut } from './util';

/** Commands for the canvas, and those the viewer takes over while it is open. */
const CANVAS_COMMANDS = ['fit', 'zoomIn', 'zoomOut', 'actualSize', 'tidy', 'note', 'frame'];
const VIEWER_COMMANDS = ['find', 'fit', 'zoomIn', 'zoomOut', 'actualSize'];
const canvasCommand = (name: string) => window.dispatchEvent(new CustomEvent('labcanvas:canvas', { detail: name }));
const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');

const pad = (n: number) => String(n).padStart(2, '0');

/** A pasted screenshot arrives as "image.png"; give it a name that says when it was taken. */
function namePasted(file: File, index: number, count: number) {
  if (!/^image\.\w+$/i.test(file.name)) return file;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  const name = `粘贴的图片 ${stamp}${count > 1 ? ` ${index + 1}` : ''}.${file.name.split('.').pop()}`;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

export function App() {
  const lab = useLab();
  const overlay = useOverlay();
  const { snapshot, projects, view, mode, entries, selection, actions } = lab;
  const [inspector, setInspector] = useState(() => localStorage.getItem('labcanvas.inspector') !== '0');
  const search = useRef<HTMLInputElement>(null);
  const latest = useRef({ lab, overlay });
  latest.current = { lab, overlay };

  const toggleInspector = () => setInspector(shown => {
    localStorage.setItem('labcanvas.inspector', shown ? '0' : '1');
    return !shown;
  });

  useEffect(() => {
    document.title = snapshot ? `${snapshot.project.name} — LabCanvas` : 'LabCanvas';
  }, [snapshot?.project.name]);

  // Commands that arrive from the keyboard or from the desktop application menu.
  useEffect(() => {
    const run = (name: string) => {
      const current = latest.current.lab;
      if (document.querySelector('.overlay-backdrop')) return;
      if (name === 'help' || name === 'shortcuts') return current.setDialog({ type: name });
      if (name === 'backup') return void current.actions.backup();
      if (current.viewer) {
        if (VIEWER_COMMANDS.includes(name)) window.dispatchEvent(new CustomEvent('labcanvas:viewer', { detail: name }));
        return;
      }
      if (name === 'project') return void current.actions.createProject();
      if (!current.snapshot) return;
      const active = current.view !== 'trash';
      if (name === 'import' && active) void current.actions.chooseAndImport();
      else if (name === 'table' && active) current.setDialog({ type: 'newTable' });
      else if (name === 'find') { search.current?.focus(); search.current?.select(); }
      else if (name === 'canvas' || name === 'list') current.setMode(name);
      else if (name === 'inspector') toggleInspector();
      else if (name === 'selectAll') current.setSelection(current.entries.map(entry => entry.id));
      else if (name === 'export' && active) current.actions.exportEntries(current.selection.length ? current.selection : current.entries.map(entry => entry.id));
      else if (CANVAS_COMMANDS.includes(name) && active && current.mode === 'canvas') canvasCommand(name);
    };
    const onAction = (event: Event) => run((event as CustomEvent<string>).detail);
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current.lab;
      // Dialogs, menus and the viewer handle their own keys.
      if (event.defaultPrevented || current.viewer || document.querySelector('.overlay-backdrop')) return;
      const target = event.target as HTMLElement;
      const typing = isTyping(target);
      const key = event.key.toLowerCase();
      if (modKey(event)) {
        const command = event.altKey || event.shiftKey ? '' : ({
          f: 'find', a: typing ? '' : 'selectAll', i: typing ? '' : 'inspector',
          0: 'fit', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', 1: 'canvas', 2: 'list'
        } as Record<string, string>)[key];
        if (command) {
          event.preventDefault();
          run(command);
        }
        return;
      }
      if (typing || event.altKey) return;
      const ids = current.selection;
      if (key === 'escape') {
        if (ids.length) current.setSelection([]);
      } else if (key === 'enter') {
        if (current.view !== 'trash' && ids.length === 1 && !target.closest('button, a, [role="button"]')) {
          event.preventDefault();
          current.open(ids[0]);
        }
      } else if ((key === 'backspace' || key === 'delete') && ids.length) {
        event.preventDefault();
        // Inside a collection, Delete only removes the reference; Shift+Delete moves the entry to the trash.
        if (current.view === 'trash') void current.actions.purge(ids);
        else if (current.collectionId && !event.shiftKey) {
          // With nested collections shown, some of the selection may be filed further down.
          const direct = ids.filter(id => current.entryById.get(id)?.collection_ids.includes(current.collectionId!));
          if (direct.length) void current.actions.removeFromCollection(direct, current.collectionId);
          else latest.current.overlay.toast('所选条目归在子分类中，不能从当前分类移除');
        } else void current.actions.trash(ids);
      } else if (key === '?') {
        run('shortcuts');
      } else if ((key === 'n' || key === 'g') && !event.shiftKey && !target.closest('.sidebar, .inspector')) {
        run(key === 'n' ? 'note' : 'frame');
      }
    };
    // Images and files on the clipboard become entries, the same as dropping them on the window.
    const onPaste = (event: ClipboardEvent) => {
      const current = latest.current.lab;
      if (event.defaultPrevented || isTyping(event.target) || current.viewer || document.querySelector('.overlay-backdrop')) return;
      if (!current.snapshot || current.view === 'trash') return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      current.actions.receiveFiles(files.map((file, index) => namePasted(file, index, files.length)));
    };
    window.addEventListener('labcanvas:action', onAction);
    window.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('labcanvas:action', onAction);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  const collection = snapshot?.collections.find(item => item.id === lab.collectionId);
  const title = view === 'trash' ? '回收站' : view === 'unfiled' ? '未分类' : collection ? collection.path.split('/').join(' / ') : '全部条目';
  const canReceive = !!snapshot && !lab.viewer && !lab.dialog && view !== 'trash';
  const filtering = !!lab.query.trim() || lab.kinds.length > 0;
  const kindSummary = lab.kinds.map(kind => kindLabel[kind]).join('、');

  const filterMenu = (anchor: HTMLElement) => overlay.menu(anchor, [
    ...KINDS.map(kind => ({
      label: kindLabel[kind],
      checked: lab.kinds.includes(kind),
      onSelect: () => lab.setKinds(lab.kinds.includes(kind) ? lab.kinds.filter(other => other !== kind) : KINDS.filter(other => other === kind || lab.kinds.includes(other)))
    })),
    'separator',
    { label: '显示全部类型', disabled: !lab.kinds.length, onSelect: () => lab.setKinds([]) }
  ]);

  let content;
  if (projects && projects.length === 0) {
    content = (
      <div className="welcome">
        <p>尚无项目</p>
        <button className="button primary" onClick={() => void actions.createProject()}>新建项目</button>
      </div>
    );
  } else if (snapshot) {
    content = (
      <>
        <header className="toolbar">
          <h1 className="toolbar-title" title={title}>{title}</h1>
          <span className="toolbar-count">
            {selection.length > 1 ? `已选择 ${selection.length} / ${entries.length}` : `${entries.length} 个条目`}
          </span>
          <span className="spacer" />
          <button
            className={`filter-button${lab.kinds.length ? ' active' : ''}`}
            aria-label="按文件类型筛选"
            title={kindSummary ? `按文件类型筛选（${kindSummary}）` : '按文件类型筛选'}
            onClick={event => filterMenu(event.currentTarget)}
          >
            <ListFilter size={14} />
            {kindSummary && <span>{kindSummary}</span>}
          </button>
          <label className="search">
            <Search size={13} />
            <input
              ref={search}
              aria-label="搜索"
              placeholder="搜索"
              title={`搜索标题、备注、属性、文件名和文件内容（${shortcut('F')}）`}
              value={lab.query}
              onChange={event => lab.setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') { lab.setQuery(''); event.currentTarget.blur(); }
              }}
            />
            {lab.query && <button className="icon-button small" aria-label="清除搜索" onClick={() => lab.setQuery('')}><X size={12} /></button>}
          </label>
          {view === 'trash' ? (
            <button className="button" disabled={!snapshot.trash.length} onClick={() => void actions.emptyTrash()}>清空回收站</button>
          ) : (
            <>
              <div className="segmented" role="tablist" aria-label="视图">
                <button role="tab" aria-selected={mode === 'canvas'} className={mode === 'canvas' ? 'active' : undefined} title={shortcut('1')} onClick={() => lab.setMode('canvas')}>画布</button>
                <button role="tab" aria-selected={mode === 'list'} className={mode === 'list' ? 'active' : undefined} title={shortcut('2')} onClick={() => lab.setMode('list')}>列表</button>
              </div>
              <button className="icon-button" aria-label="新建表格" title="新建表格" onClick={() => lab.setDialog({ type: 'newTable' })}><Table size={15} /></button>
              <button className="button" title="也可以把文件或文件夹拖进窗口，或粘贴剪贴板中的图片" onClick={() => void actions.chooseAndImport()}><Plus size={14} />添加文件</button>
            </>
          )}
          <button
            className={`icon-button${inspector ? ' active' : ''}`}
            aria-label="详情面板"
            aria-pressed={inspector}
            title={`显示或隐藏详情面板（${shortcut('I')}）`}
            onClick={toggleInspector}
          >
            <PanelRight size={15} />
          </button>
        </header>
        {lab.connectionError && (
          <div className="banner" role="alert">
            <span>{lab.connectionError}</span>
            <button className="button small" onClick={() => void lab.refresh().catch(() => {})}>重试</button>
          </div>
        )}
        {filtering && lab.elsewhere > 0 && (
          <div className="scope-hint" role="status">
            <span>「{title}」之外还有 {lab.elsewhere} 个匹配的条目</span>
            <button className="link" onClick={() => lab.setView('all')}>在全部条目中查看</button>
          </div>
        )}
        <div className="workspace">
          {/* The trash has no arrangement of its own; it is always a list. */}
          {mode === 'canvas' && view !== 'trash' ? <Canvas /> : <ListView />}
          {inspector && <Inspector />}
        </div>
      </>
    );
  } else if (lab.connectionError) {
    content = (
      <div className="welcome">
        <p>{lab.connectionError}</p>
        <button className="button" onClick={() => void lab.refresh().catch(() => {})}>重试</button>
      </div>
    );
  }

  return (
    <div
      className="app"
      onDragOver={event => {
        // Files dropped anywhere outside the canvas are added too, instead of the window navigating to them.
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = canReceive ? 'copy' : 'none';
      }}
      onDrop={event => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        if (!canReceive) return;
        const destination = (event.target as HTMLElement).closest<HTMLElement>('[data-drop-collection]')?.dataset.dropCollection;
        void droppedFiles(event.dataTransfer).then(files => actions.receiveFiles(files, undefined, destination));
      }}
    >
      <Sidebar />
      <main className="main" inert={!!lab.viewer}>{content}</main>
      <ErrorBoundary onReset={() => lab.setViewer(null)}>
        <Viewer />
      </ErrorBoundary>
      <Dialogs />
      {lab.progress && (
        <div className={`progress${lab.progress.fraction < 0 ? ' indeterminate' : ''}`} role="status" aria-live="polite">
          <span>{lab.progress.label}</span>
          <div className="progress-track">
            <div className="progress-fill" style={lab.progress.fraction < 0 ? undefined : { width: `${Math.round(lab.progress.fraction * 100)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
