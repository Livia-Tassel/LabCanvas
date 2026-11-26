import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Layers } from 'lucide-react';
import { useLab } from '../state';
import { useOverlay } from './ui';
import { useEntryMenu } from './entryMenu';
import { KindIcon } from './FilePreview';
import { Mascot } from './Art';
import { ENTRY_DRAG } from './Sidebar';
import { formatBytes, formatDateTime, isTyping, modKey } from '../util';
import type { Entry } from '../types';

type BuiltIn = 'files' | 'date' | 'collections' | 'size' | 'updated' | 'created';
/** A built-in column, or `field:NAME` for a property. */
type ColumnKey = 'title' | BuiltIn | `field:${string}`;
const builtIns: { key: BuiltIn; label: string }[] = [
  { key: 'files', label: '文件' },
  { key: 'date', label: '实验日期' },
  { key: 'collections', label: '分类' },
  { key: 'size', label: '大小' },
  { key: 'updated', label: '修改时间' },
  { key: 'created', label: '添加时间' }
];
const DEFAULT_COLUMNS: ColumnKey[] = ['files', 'date', 'collections', 'size', 'updated'];

const totalSize = (entry: Entry) => entry.files.reduce((sum, file) => sum + file.size, 0);
const filesLabel = (entry: Entry) => (entry.files.length === 1 ? entry.files[0].name : `${entry.files.length} 个文件`);
const fieldOf = (entry: Entry, name: string) => entry.fields.find(field => field.name === name)?.value ?? '';

function stored<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

export function ListView() {
  const lab = useLab();
  const overlay = useOverlay();
  const entryMenu = useEntryMenu();
  const { entries, selection, setSelection, snapshot, projectId } = lab;
  const [sort, setSort] = useState(() => stored<{ key: ColumnKey; ascending: boolean }>('labcanvas.sort', { key: 'date', ascending: false }));
  const [columns, setColumns] = useState(() => stored<ColumnKey[]>(`labcanvas.columns.${projectId}`, DEFAULT_COLUMNS));
  const columnsFor = useRef(projectId);
  if (columnsFor.current !== projectId) {
    columnsFor.current = projectId;
    setColumns(stored<ColumnKey[]>(`labcanvas.columns.${projectId}`, DEFAULT_COLUMNS));
  }
  const anchor = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const names = useMemo(() => new Map((snapshot?.collections ?? []).map(c => [c.id, c.name])), [snapshot?.collections]);
  const collectionsLabel = (entry: Entry) => entry.collection_ids.map(id => names.get(id)).filter(Boolean).join('、');

  /** Property names in use, most common first, offered as columns. */
  const fieldNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of [...(snapshot?.entries ?? [])]) for (const field of entry.fields) counts.set(field.name, (counts.get(field.name) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).map(([name]) => name);
  }, [snapshot?.entries]);

  const shownColumns = columns.filter(key => !key.startsWith('field:') || fieldNames.includes(key.slice(6)));
  const labelOf = (key: ColumnKey) => (key === 'title' ? '标题' : key.startsWith('field:') ? key.slice(6) : builtIns.find(column => column.key === key)?.label ?? key);
  const sortKey = sort.key === 'title' || shownColumns.includes(sort.key) ? sort.key : 'title';

  const valueOf = (entry: Entry, key: ColumnKey): string | number => {
    if (key.startsWith('field:')) return fieldOf(entry, key.slice(6));
    switch (key) {
      case 'title': return entry.title;
      case 'files': return filesLabel(entry);
      case 'date': return entry.date;
      case 'collections': return collectionsLabel(entry);
      case 'size': return totalSize(entry);
      case 'updated': return entry.updated_at;
      case 'created': return entry.created_at;
      default: return '';
    }
  };

  const sorted = useMemo(() => {
    const list = [...entries].sort((a, b) => {
      const [x, y] = [valueOf(a, sortKey), valueOf(b, sortKey)];
      // Entries without a value for the sorted property go last in either direction.
      if (x === '' || y === '') return x === y ? 0 : (x === '' ? 1 : -1) * (sort.ascending ? 1 : -1);
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-CN', { numeric: true });
      return order || a.created_at.localeCompare(b.created_at);
    });
    return sort.ascending ? list : list.reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, sortKey, sort.ascending, names]);

  useEffect(() => {
    lab.order.current = sorted.map(entry => entry.id);
  }, [sorted, lab.order]);

  const changeSort = (key: ColumnKey) => {
    const next = { key, ascending: sortKey === key ? !sort.ascending : key !== 'date' && key !== 'updated' && key !== 'created' };
    setSort(next);
    localStorage.setItem('labcanvas.sort', JSON.stringify(next));
  };

  const toggleColumn = (key: ColumnKey) => {
    const next = columns.includes(key) ? columns.filter(other => other !== key) : [...columns, key];
    setColumns(next);
    localStorage.setItem(`labcanvas.columns.${projectId}`, JSON.stringify(next));
  };

  const columnMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    overlay.menu({ x: event.clientX, y: event.clientY }, [
      ...builtIns.map(column => ({ label: column.label, checked: columns.includes(column.key), onSelect: () => toggleColumn(column.key) })),
      ...(fieldNames.length ? ['separator' as const] : []),
      ...fieldNames.slice(0, 20).map(name => ({ label: name, checked: columns.includes(`field:${name}`), onSelect: () => toggleColumn(`field:${name}`) }))
    ]);
  };

  const select = (event: React.MouseEvent, id: string) => {
    if (event.shiftKey && anchor.current) {
      const ids = sorted.map(entry => entry.id);
      const [from, to] = [ids.indexOf(anchor.current), ids.indexOf(id)].sort((a, b) => a - b);
      if (from >= 0) return setSelection(ids.slice(from, to + 1));
    }
    anchor.current = id;
    if (modKey(event)) setSelection(selection.includes(id) ? selection.filter(other => other !== id) : [...selection, id]);
    else setSelection([id]);
  };

  // Arrow keys move through the rows; Shift extends the selection from where it started.
  const latest = useRef({ sorted, selection });
  latest.current = { sorted, selection };
  const cursor = useRef<string | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTyping(event.target) || modKey(event) || event.altKey) return;
      if (document.querySelector('.viewer, .overlay-backdrop') || (event.target as HTMLElement).closest?.('.sidebar, .inspector')) return;
      const key = event.key;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return;
      const ids = latest.current.sorted.map(entry => entry.id);
      if (!ids.length) return;
      event.preventDefault();
      const picked = latest.current.selection;
      const from = cursor.current && picked.includes(cursor.current) ? cursor.current : picked[picked.length - 1];
      const index = from ? ids.indexOf(from) : -1;
      const next = key === 'Home' ? 0 : key === 'End' ? ids.length - 1
        : index < 0 ? (key === 'ArrowDown' ? 0 : ids.length - 1)
        : Math.min(ids.length - 1, Math.max(0, index + (key === 'ArrowDown' ? 1 : -1)));
      const id = ids[next];
      cursor.current = id;
      if (event.shiftKey && anchor.current && ids.includes(anchor.current)) {
        const [a, b] = [ids.indexOf(anchor.current), next].sort((m, n) => m - n);
        setSelection(ids.slice(a, b + 1));
      } else {
        anchor.current = id;
        setSelection([id]);
      }
      root.current?.querySelector(`tr[data-entry-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSelection]);

  const header = (key: ColumnKey) => (
    <th
      key={key}
      className={key.startsWith('field:') ? 'col-field' : `col-${key}`}
      aria-sort={sortKey === key ? (sort.ascending ? 'ascending' : 'descending') : undefined}
      onClick={() => changeSort(key)}
    >
      <span>{labelOf(key)}</span>
      {sortKey === key && (sort.ascending ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
    </th>
  );

  const cell = (entry: Entry, key: ColumnKey) => {
    const value = valueOf(entry, key);
    const text = key === 'size' ? formatBytes(value as number) : key === 'updated' || key === 'created' ? formatDateTime(value as string) : String(value);
    return <td key={key} className={key.startsWith('field:') ? 'col-field' : `col-${key}`} title={key === 'collections' || key.startsWith('field:') ? text : undefined}>{text}</td>;
  };

  const filtered = !!lab.query || lab.kinds.length > 0;
  return (
    <div ref={root} className="list" onClick={event => { if (event.target === event.currentTarget) setSelection([]); }}>
      <table className="list-table" style={{ minWidth: 380 + shownColumns.length * 120 }}>
        <thead onContextMenu={columnMenu} title="右键选择显示的列">
          <tr>{(['title', ...shownColumns] as ColumnKey[]).map(header)}</tr>
        </thead>
        <tbody>
          {sorted.map(entry => {
            const snippet = lab.snippetOf(entry);
            const stale = entry.files.some(file => lab.staleFiles.has(file.id));
            return (
              <tr
                key={entry.id}
                className={selection.includes(entry.id) ? 'selected' : undefined}
                aria-selected={selection.includes(entry.id)}
                data-entry-id={entry.id}
                draggable={lab.view !== 'trash'}
                onClick={event => select(event, entry.id)}
                onDoubleClick={() => lab.view !== 'trash' && lab.open(entry.id)}
                onContextMenu={event => {
                  event.preventDefault();
                  const ids = selection.includes(entry.id) ? selection : [entry.id];
                  setSelection(ids);
                  entryMenu({ x: event.clientX, y: event.clientY }, ids);
                }}
                onDragStart={event => {
                  const ids = selection.includes(entry.id) ? selection : [entry.id];
                  setSelection(ids);
                  event.dataTransfer.setData(ENTRY_DRAG, JSON.stringify(ids));
                  event.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <td className="col-title">
                  {entry.files.length > 1 ? <Layers size={14} strokeWidth={1.9} className="kind-icon" /> : <KindIcon kind={entry.files[0]?.kind ?? 'file'} />}
                  <span>{entry.title}</span>
                  {stale && <span className="row-stale" title="其中的图表来源已有新版本">来源已更新</span>}
                  {snippet && <span className="row-snippet">{snippet}</span>}
                </td>
                {shownColumns.map(key => cell(entry, key))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div className="empty-state static">
          <Mascot mood={filtered ? 'search' : lab.view === 'trash' ? 'sleepy' : 'happy'} />
          <span>{filtered ? '没有匹配的条目' : lab.view === 'trash' ? '回收站为空' : '没有条目'}</span>
        </div>
      )}
    </div>
  );
}
