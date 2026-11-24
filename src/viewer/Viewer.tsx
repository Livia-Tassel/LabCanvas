import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronLeft, Download, History, TriangleAlert } from 'lucide-react';
import { api, rawUrl, send } from '../api';
import { useLab } from '../state';
import type { ViewerState } from '../state';
import { useOverlay } from '../components/ui';
import type { MenuItem } from '../components/ui';
import { KindIcon } from '../components/FilePreview';
import { TableView } from './TableView';
import { ImageView } from './ImageView';
import { TextView } from './TextView';
import { PdfView } from './PdfView';
import { createScrollGroup } from './shared';
import type { ImageFrame, ViewProps } from './shared';
import { formatBytes, formatDateTime, isMac, isTyping, modKey } from '../util';
import type { FileVersion, LabFile } from '../types';

function FileBody(props: ViewProps) {
  const { file, version } = props;
  if (file.kind === 'table') return <TableView {...props} />;
  if (file.kind === 'image') return <ImageView {...props} />;
  if (file.kind === 'text') return <TextView {...props} />;
  if (file.kind === 'pdf') return <PdfView {...props} />;
  return (
    <div className="viewer-message">
      <KindIcon kind="file" size={32} />
      <span>{file.name} · {formatBytes(file.size)}</span>
      <span className="muted">此类型的文件无法在应用内预览</span>
      <a className="button" href={rawUrl({ id: file.id, version: version ?? file.version }, true)}>下载</a>
    </div>
  );
}

/** Images and PDFs are opened afresh for each version; tables and text reload in place and keep their state. */
const bodyKey = (file: LabFile, version?: number) =>
  `${file.id}:${version ?? (file.kind === 'image' || file.kind === 'pdf' ? file.version : 'current')}`;

type Pane = {
  file: LabFile;
  version?: number;
  title: string;
  detail: string;
  /** Opens a menu for showing something else in this pane. */
  pick?: (anchor: HTMLElement) => void;
};

/**
 * Full-window view of one entry: its files as tabs, each shown with a viewer for its type.
 * It also shows earlier versions of a file, and two files or two versions side by side.
 */
export function Viewer() {
  const lab = useLab();
  const overlay = useOverlay();
  const { viewer, setViewer, actions } = lab;
  const entry = viewer ? lab.entryById.get(viewer.entryId) : undefined;
  const file = entry?.files.find(item => item.id === viewer?.fileId) ?? entry?.files[0];
  const other = viewer?.compare ? lab.fileById.get(viewer.compare.fileId) : undefined;
  const otherEntry = other ? lab.entryById.get(other.entry_id) : undefined;
  const [pin, setPin] = useState<{ fileId: string; version: number } | null>(null);
  const [history, setHistory] = useState<{ fileId: string; list: FileVersion[] } | null>(null);
  const [shared, setShared] = useState<{ key: string; view: ImageFrame } | null>(null);
  /** What to show again when a comparison opened from another file is closed. */
  const [returnTo, setReturnTo] = useState<ViewerState | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const backButton = useRef<HTMLButtonElement>(null);
  const open = !!file;
  useLayoutEffect(() => {
    if (open) backButton.current?.focus({ preventScroll: true });
  }, [open]);

  /** The earlier version being looked at, if any. Another file starts at its current version again. */
  const pinned = pin && pin.fileId === file?.id ? pin.version : null;
  const versions = history && history.fileId === file?.id ? history.list : [];
  const currentVersion = Math.max(file?.version ?? 0, versions.find(version => version.current)?.number ?? 0);
  const compareVersion = viewer?.compare?.version;
  const sameFile = !!other && other.id === file?.id;
  const comparing = !!file && !!other && (!sameFile || (compareVersion !== undefined && compareVersion < currentVersion));
  const pairKey = comparing ? `${file.id}:${other.id}:${compareVersion ?? ''}` : '';
  const group = useMemo(() => createScrollGroup(), [pairKey]);

  useEffect(() => {
    if (!file || !comparing) return;
    let active = true;
    api<FileVersion[]>(`/files/${file.id}/versions`)
      .then(list => { if (active) setHistory({ fileId: file.id, list }); })
      .catch(() => {});
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, file?.version, comparing]);

  const confirmLeave = useCallback(async () => {
    if (!dirtyRef.current) return true;
    return overlay.confirm({ title: '放弃未保存的修改？', message: '离开后，尚未保存的修改将丢失。', confirmLabel: '放弃修改', danger: true });
  }, [overlay]);

  /** Does something that replaces what is shown, after asking about unsaved edits. */
  const leave = useCallback(async (next: () => void) => {
    if (!(await confirmLeave())) return;
    setDirty(false);
    next();
  }, [confirmLeave]);

  const close = useCallback(() => leave(() => {
    setPin(null);
    setReturnTo(null);
    setViewer(null);
  }), [leave, setViewer]);

  /** Moves to the entry before or after this one in the order the view behind presents them. */
  const step = useCallback((delta: 1 | -1) => {
    const ids = lab.order.current.filter(id => lab.entryById.has(id));
    const next = viewer ? ids[ids.indexOf(viewer.entryId) + delta] : undefined;
    if (!viewer || !ids.includes(viewer.entryId) || !next) return;
    void leave(() => {
      setPin(null);
      setReturnTo(null);
      setViewer({ entryId: next });
      lab.setSelection([next]);
    });
  }, [lab, viewer, leave, setViewer]);

  // The entry disappeared (deleted elsewhere): leave the viewer. A comparison ends when its other side is gone.
  useEffect(() => {
    if (!viewer) return;
    if (!file) {
      setPin(null);
      setDirty(false);
      setReturnTo(null);
      setViewer(null);
    }
    else if (viewer.compare && !comparing) setViewer({ entryId: viewer.entryId, fileId: viewer.fileId });
  }, [viewer, file, comparing, setViewer]);

  useEffect(() => {
    if (!viewer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('.overlay-backdrop')) return;
      const target = event.target as HTMLElement;
      if (event.key === 'Escape') {
        if (!/^(INPUT|TEXTAREA)$/.test(target.tagName)) void close();
        return;
      }
      const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (!delta || modKey(event) || event.shiftKey || isTyping(target)) return;
      // A table uses the plain arrow keys itself; there, Alt with an arrow steps through the entries.
      if (!event.altKey && target.closest('.grid-scroller')) return;
      event.preventDefault();
      step(delta);
    };
    const onUnload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) event.preventDefault(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [viewer, close, step]);

  if (!viewer || !entry || !file) return null;

  const switchTo = (fileId: string) => {
    if (fileId !== file.id) void leave(() => {
      setPin(null);
      setViewer({ entryId: entry.id, fileId });
    });
  };
  const compareWith = (target: { fileId: string; version?: number }, main = { entryId: entry.id, fileId: file.id }) =>
    void leave(() => {
      setPin(null);
      setViewer({ ...main, compare: target });
    });
  const endCompare = () => {
    setViewer(returnTo && lab.entryById.has(returnTo.entryId) ? returnTo : { entryId: entry.id, fileId: file.id });
    setReturnTo(null);
  };
  const whenOf = (number: number) => {
    const found = versions.find(version => version.number === number);
    return found ? formatDateTime(found.created_at) : '';
  };

  const showVersions = async (anchor: HTMLElement) => {
    try {
      // A save can finish before the workspace receives its change notification.
      const list = await api<FileVersion[]>(`/files/${file.id}/versions`);
      if (!anchor.isConnected || document.querySelector('.overlay-backdrop')) return;
      setHistory({ fileId: file.id, list });
      const items: MenuItem[] = list.map(version => {
        const selectedVersion = version.current ? null : version.number;
        return {
          label: `第 ${version.number} 版 · ${formatDateTime(version.created_at)} · ${formatBytes(version.size)}${version.current ? ' · 当前' : ''}`,
          checked: selectedVersion === pinned,
          onSelect: () => {
            if (selectedVersion !== pinned) void leave(() => setPin(selectedVersion === null ? null : { fileId: file.id, version: selectedVersion }));
          }
        };
      });
      const previous = list.find(version => !version.current);
      if (previous) items.push('separator', { label: '与上一版并排对比', onSelect: () => compareWith({ fileId: file.id, version: previous.number }) });
      overlay.menu(anchor, items);
    } catch (error) {
      if (anchor.isConnected) overlay.toast((error as Error).message, { error: true });
    }
  };

  const restore = async (number: number) => {
    const ok = await overlay.confirm({ title: `恢复到第 ${number} 版？`, message: '会以该版本的内容创建一个新版本，现有版本仍然保留。', confirmLabel: '恢复' });
    if (!ok) return;
    const restored = await lab.act(() => send('POST', `/files/${file.id}/versions/${number}/restore`));
    if (restored) setPin(null);
  };

  const source = file.source_file_id ? lab.fileById.get(file.source_file_id) : undefined;
  const stale = !!source && lab.staleFiles.has(file.id);

  const ids = lab.order.current.filter(id => lab.entryById.has(id));
  const position = ids.indexOf(entry.id);
  const alt = isMac ? '⌥' : 'Alt+';

  let panes: Pane[] = [];
  if (comparing && other && sameFile) {
    const earlier = versions.filter(version => version.number < currentVersion);
    panes = [
      {
        file,
        version: compareVersion,
        title: `第 ${compareVersion} 版`,
        detail: whenOf(compareVersion!),
        pick: earlier.length > 1 ? anchor => overlay.menu(anchor, earlier.map(version => ({
          label: `第 ${version.number} 版 · ${formatDateTime(version.created_at)}`,
          checked: version.number === compareVersion,
          onSelect: () => setViewer({ ...viewer, compare: { fileId: file.id, version: version.number } })
        }))) : undefined
      },
      { file, title: `第 ${currentVersion} 版`, detail: '当前' }
    ];
  } else if (comparing && other) {
    const filesOf = (owner: LabFile[], current: LabFile, choose: (id: string) => void) =>
      owner.length > 1
        ? (anchor: HTMLElement) => overlay.menu(anchor, owner.map(item => ({ label: item.name, checked: item.id === current.id, onSelect: () => choose(item.id) })))
        : undefined;
    const apart = otherEntry && otherEntry.id !== entry.id;
    panes = [
      {
        file,
        title: apart ? entry.title : file.name,
        detail: apart ? file.name : '',
        pick: filesOf(entry.files, file, id => setViewer({ ...viewer, fileId: id }))
      },
      {
        file: other,
        title: apart ? otherEntry.title : other.name,
        detail: apart ? other.name : '',
        pick: filesOf(otherEntry?.files ?? [], other, id => setViewer({ ...viewer, compare: { fileId: id } }))
      }
    ];
  }
  const link = { view: shared?.key === pairKey ? shared.view : null, setView: (view: ImageFrame) => setShared({ key: pairKey, view }) };

  return (
    <div className="viewer">
      <header className="viewer-bar">
        <button ref={backButton} className="button ghost" onClick={() => void close()}><ChevronLeft size={15} />返回</button>
        {position >= 0 && ids.length > 1 && (
          <span className="viewer-steps">
            <button className="icon-button" aria-label="上一个条目" title={`上一个条目（${alt}←）`} disabled={position === 0} onClick={() => step(-1)}><ArrowLeft size={15} /></button>
            <button className="icon-button" aria-label="下一个条目" title={`下一个条目（${alt}→）`} disabled={position === ids.length - 1} onClick={() => step(1)}><ArrowRight size={15} /></button>
          </span>
        )}
        <span className="viewer-title">{entry.title}</span>
        {position >= 0 && ids.length > 1 && <span className="viewer-position">{position + 1} / {ids.length}</span>}
        <span className="spacer" />
        {comparing
          ? <button className="button small" onClick={endCompare}>退出对比</button>
          : <button key={file.id} className="icon-button" aria-label="版本记录" title="版本记录" onClick={event => void showVersions(event.currentTarget)}><History size={15} /></button>}
        <a className="icon-button" aria-label="下载" title="下载" href={rawUrl({ id: file.id, version: pinned ?? currentVersion }, true)}><Download size={15} /></a>
      </header>
      {!comparing && entry.files.length > 1 && (
        <div className="viewer-tabs" role="tablist">
          {entry.files.map(item => (
            <button key={item.id} role="tab" aria-selected={item.id === file.id} className={item.id === file.id ? 'active' : undefined} onClick={() => switchTo(item.id)}>
              <KindIcon kind={item.kind} size={13} />
              <span>{item.name}</span>
            </button>
          ))}
        </div>
      )}
      {!comparing && pinned !== null && (
        <div className="viewer-notice" role="status">
          <span>正在查看第 {pinned} 版{whenOf(pinned) && `（${whenOf(pinned)}）`}，只读</span>
          <span className="spacer" />
          <button className="button small" onClick={() => compareWith({ fileId: file.id, version: pinned })}>与当前版本对比</button>
          <button className="button small" onClick={() => void restore(pinned)}>恢复此版本</button>
          <button className="button small" onClick={() => setPin(null)}>返回当前版本</button>
        </div>
      )}
      {!comparing && pinned === null && stale && source && (
        <div className="viewer-notice warn" role="status">
          <TriangleAlert size={13} />
          <span>来源「{source.name}」已更新到第 {source.version} 版，此文件对应第 {file.source_version} 版，可能已过期</span>
          <span className="spacer" />
          <button
            className="button small"
            onClick={() => {
              setReturnTo({ entryId: entry.id, fileId: file.id });
              compareWith({ fileId: source.id, version: file.source_version ?? undefined }, { entryId: source.entry_id, fileId: source.id });
            }}
          >
            查看来源的改动
          </button>
          <button className="button small" title="此文件与新的来源仍然一致，不再提示" onClick={() => void actions.confirmSource(file)}>已核对</button>
        </div>
      )}
      {comparing ? (
        <div className="viewer-body comparing">
          {panes.map((pane, index) => {
            const opposite = panes[1 - index];
            const label = (
              <>
                <KindIcon kind={pane.file.kind} size={13} />
                <span className="compare-name">{pane.title}</span>
                {pane.detail && <span className="compare-detail">{pane.detail}</span>}
              </>
            );
            return (
              <section key={index} className="compare-pane" aria-label={`${pane.title} ${pane.detail}`}>
                {pane.pick
                  ? <button className="compare-head" title="更换" onClick={event => pane.pick!(event.currentTarget)}>{label}<ChevronDown size={12} /></button>
                  : <div className="compare-head">{label}</div>}
                <div className="compare-body">
                  <FileBody
                    key={`${pane.file.id}:${pane.version ?? pane.file.version}`}
                    file={pane.file}
                    version={pane.version}
                    readOnly
                    against={opposite.file.kind === pane.file.kind ? { file: opposite.file, version: opposite.version } : undefined}
                    side={index === 0 ? 'old' : 'new'}
                    group={group}
                    link={link}
                    primary={index === 0}
                  />
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="viewer-body">
          <FileBody key={bodyKey(file, pinned ?? undefined)} file={file} version={pinned ?? undefined} onDirtyChange={setDirty} primary />
        </div>
      )}
    </div>
  );
}
