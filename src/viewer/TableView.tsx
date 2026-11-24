import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, Redo2, Search, Undo2 } from 'lucide-react';
import { api, send } from '../api';
import { useOverlay } from '../components/ui';
import { clamp, columnName, isTyping, modKey, shortcut } from '../util';
import { FindBar, findIsFor, useScrollSync } from './shared';
import type { ViewProps } from './shared';
import type { TableData, TableOp } from '../types';

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 26;
const GUTTER = 48;
const OVERSCAN = 12;
const LOAD_LIMIT = 20000;
const MATCH_LIMIT = 5000;

type Grid = { rows: string[][]; columns: number; formulas: Record<string, string> };
type Range = { row: number; column: number; row2: number; column2: number };
/** The state to return to when an edit is undone or redone: one sheet's grid and the pending changes. */
type Step = { sheet: number; grid: Grid; ops: TableOp[] };
type Prefs = { widths: Record<string, number>; frozen: boolean };

const ORIGIN: Range = { row: 0, column: 0, row2: 0, column2: 0 };
const EMPTY: Grid = { rows: [], columns: 0, formulas: {} };
const PREFS_KEY = 'labcanvas.tables';

function readPrefs(): Record<string, Partial<Prefs>> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/** Column widths and the frozen header row are remembered per file. */
function loadPrefs(fileId: string): Prefs {
  return { widths: {}, frozen: true, ...readPrefs()[fileId] };
}

function storePrefs(fileId: string, prefs: Prefs) {
  const all = readPrefs();
  delete all[fileId];
  all[fileId] = prefs;
  // Keep the most recently changed files only.
  const keys = Object.keys(all);
  for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete all[key];
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch { /* the choice still holds for this session */ }
}

/** Applies one edit to the in-memory grid without mutating the previous value (so undo can keep it). */
function applyOp(grid: Grid, op: TableOp): Grid {
  const rows = grid.rows.slice();
  let columns = grid.columns;
  let formulas = grid.formulas;
  if (op.type === 'set') {
    while (rows.length <= op.row) rows.push([]);
    const row = rows[op.row].slice();
    while (row.length <= op.column) row.push('');
    row[op.column] = op.value;
    rows[op.row] = row;
    columns = Math.max(columns, op.column + 1);
    const address = `${op.row}:${op.column}`;
    if (address in formulas) {
      formulas = { ...formulas };
      delete formulas[address];
    }
  } else if (op.type === 'insertRows') {
    rows.splice(op.at, 0, ...Array.from({ length: op.count }, () => []));
  } else if (op.type === 'deleteRows') {
    rows.splice(op.at, op.count);
  } else if (op.type === 'insertColumns') {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r].slice();
      while (row.length < op.at) row.push('');
      row.splice(op.at, 0, ...Array.from({ length: op.count }, () => ''));
      rows[r] = row;
    }
    columns += op.count;
  } else {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r].slice();
      row.splice(op.at, op.count);
      rows[r] = row;
    }
    columns = Math.max(0, columns - op.count);
  }
  if (op.type !== 'set' && Object.keys(formulas).length) {
    const shiftRow = op.type.endsWith('Rows');
    const insert = op.type.startsWith('insert');
    const shifted: typeof formulas = {};
    for (const [address, formula] of Object.entries(formulas)) {
      const [row, column] = address.split(':').map(Number);
      const index = shiftRow ? row : column;
      if (!insert && index >= op.at && index < op.at + op.count) continue;
      const moved = index >= op.at ? index + (insert ? op.count : -op.count) : index;
      shifted[shiftRow ? `${moved}:${column}` : `${row}:${moved}`] = formula;
    }
    formulas = shifted;
  }
  return { rows, columns, formulas };
}

const textWidth = (text: string) => {
  let width = 0;
  for (const char of text) width += char.charCodeAt(0) > 0x2e7f ? 13 : 7.2;
  return width;
};

/** A cell as spreadsheets put it on the clipboard: quoted when it holds a tab, a line break or a quote. */
const clipboardCell = (value: string) => (/[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** Splits clipboard text into rows of cells. Quoted cells may contain tabs and line breaks. */
function parseClipboard(text: string) {
  const source = text.replace(/\r\n?/g, '\n');
  const rows: string[][] = [[]];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === '\t') {
      rows[rows.length - 1].push(cell);
      cell = '';
    } else if (char === '\n') {
      rows[rows.length - 1].push(cell);
      cell = '';
      rows.push([]);
    } else {
      cell += char;
    }
  }
  rows[rows.length - 1].push(cell);
  const last = rows[rows.length - 1];
  if (rows.length > 1 && last.length === 1 && last[0] === '') rows.pop();
  return rows;
}

const formatNumber = (value: number) => Number(value.toPrecision(12)).toLocaleString('en-US', { maximumFractionDigits: 6 });

export function TableView({ file, version: pinned, readOnly: locked = false, onDirtyChange, against, group, primary = false }: ViewProps) {
  const overlay = useOverlay();
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [meta, setMeta] = useState<TableData | null>(null);
  const [sheet, setSheet] = useState(0);
  const [grid, setGrid] = useState<Grid>(EMPTY);
  const [ops, setOps] = useState<TableOp[]>([]);
  const [history, setHistory] = useState<Step[]>([]);
  const [future, setFuture] = useState<Step[]>([]);
  const [range, setRange] = useState<Range>(ORIGIN);
  const [editing, setEditing] = useState<{ row: number; column: number; value: string; via?: 'bar' } | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prefs, setPrefs] = useState(() => loadPrefs(file.id));
  const [find, setFind] = useState<{ term: string; index: number } | null>(null);
  /** Rows of the table shown beside this one, for marking the cells that differ. */
  const [other, setOther] = useState<string[][] | null>(null);
  const [diffAt, setDiffAt] = useState(-1);
  /** Edited grids of sheets the user has switched away from. */
  const cache = useRef(new Map<number, { grid: Grid; meta: TableData }>());
  const version = useRef(pinned ?? file.version);
  const requestId = useRef(0);
  /** An earlier version, or the far side of a comparison, is never edited. */
  const fixed = locked || pinned !== undefined;
  const readOnly = fixed || (!!meta && meta.totalRows > LOAD_LIMIT);
  const pendingEdit = editing && editing.value !== (grid.formulas[`${editing.row}:${editing.column}`] ?? grid.rows[editing.row]?.[editing.column] ?? '')
    ? { type: 'set' as const, sheet, row: editing.row, column: editing.column, value: editing.value }
    : null;
  const dirty = ops.length > 0 || pendingEdit !== null;

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useScrollSync(scroller, group, meta !== null);

  const load = useCallback(async (index: number, offset = 0, at: number | undefined = pinned): Promise<void> => {
    const request = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const data = await api<TableData>(`/files/${file.id}/table?sheet=${index}&offset=${offset}&limit=${LOAD_LIMIT}${at ? `&version=${at}` : ''}`);
      if (request !== requestId.current) return;
      version.current = data.version;
      setMeta(data);
      const formulas = Object.fromEntries(Object.entries(data.formulas).map(([address, value]) => {
        const [row, column] = address.split(':').map(Number);
        return [`${row - data.offset}:${column}`, value];
      }));
      setGrid({ rows: data.rows, columns: data.totalColumns, formulas });
    } catch (failure) {
      if (request !== requestId.current) return;
      // A newer version may have fewer sheets than the one that was open.
      if (index > 0) {
        setSheet(0);
        return load(0, 0, at);
      }
      setError((failure as Error).message);
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [file.id, pinned]);

  // Reload when the file gets a new version elsewhere, unless there are local edits to protect.
  useEffect(() => {
    if (dirty && version.current) return;
    // After saving here, the table already shows the version that the snapshot now reports.
    if (meta && pinned === undefined && version.current === file.version) return;
    cache.current.clear();
    setHistory([]);
    setFuture([]);
    void load(sheet, meta?.sheet === sheet ? meta.offset : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, file.version, pinned]);

  useEffect(() => {
    if (primary && meta) scroller.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta === null]);

  // The same sheet and page of the table this one is compared with.
  const offset = meta?.offset ?? 0;
  useEffect(() => {
    if (!against || against.file.kind !== 'table' || !meta) return setOther(null);
    let active = true;
    api<TableData>(`/files/${against.file.id}/table?sheet=${sheet}&offset=${offset}&limit=${LOAD_LIMIT}${against.version ? `&version=${against.version}` : ''}`)
      .then(data => { if (active) setOther(data.rows); })
      .catch(() => { if (active) setOther(null); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [against?.file.id, against?.file.version, against?.version, sheet, offset, meta === null]);

  /** Shows a grid, changing to its sheet first when it is not the one on screen. */
  const show = (index: number, next: Grid) => {
    if (index !== sheet && meta) {
      cache.current.set(sheet, { grid, meta });
      const cached = cache.current.get(index);
      if (cached) setMeta(cached.meta);
      setSheet(index);
      setRange(ORIGIN);
      scroller.current?.scrollTo(0, 0);
    }
    setGrid(next);
  };

  const switchSheet = (index: number) => {
    if (index === sheet || loading || saving || !meta) return;
    cache.current.set(sheet, { grid, meta });
    setSheet(index);
    setEditing(null);
    setRange(ORIGIN);
    const cached = cache.current.get(index);
    if (cached) {
      setGrid(cached.grid);
      setMeta(cached.meta);
    } else void load(index, 0, version.current);
    scroller.current?.scrollTo(0, 0);
  };

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => setScroll({ top: element.scrollTop, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [meta === null]);

  const rowCount = grid.rows.length;
  const frozen = prefs.frozen && !!meta && meta.offset === 0 && rowCount > 1;
  const widths = useMemo(() => {
    const result: number[] = [];
    const sample = grid.rows.slice(0, 200);
    for (let c = 0; c < grid.columns; c++) {
      const chosen = prefs.widths[`${sheet}:${c}`];
      if (chosen) {
        result.push(chosen);
        continue;
      }
      let width = 0;
      for (const row of sample) width = Math.max(width, textWidth(row[c] ?? ''));
      result.push(clamp(Math.ceil(width) + 22, 72, 340));
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.columns, grid.rows.length === 0, meta, sheet, prefs.widths]);
  const offsets = useMemo(() => {
    const result = [0];
    for (const width of widths) result.push(result[result.length - 1] + width);
    return result;
  }, [widths]);

  const commit = useCallback((list: TableOp[]) => {
    if (!list.length) return;
    if (readOnly || loading || saving) return;
    setHistory(stack => [...stack.slice(-99), { sheet, grid, ops }]);
    setFuture([]);
    setGrid(list.reduce(applyOp, grid));
    setOps([...ops, ...list]);
  }, [grid, ops, sheet, readOnly, loading, saving]);

  /** Steps back or forward through the edits, which may lie on different sheets. */
  const travel = (from: Step[], setFrom: (stack: Step[]) => void, setTo: (update: (stack: Step[]) => Step[]) => void) => {
    const step = from[from.length - 1];
    if (!step || saving || loading) return;
    const present = step.sheet === sheet ? grid : cache.current.get(step.sheet)?.grid ?? step.grid;
    setTo(stack => [...stack, { sheet: step.sheet, grid: present, ops }]);
    setFrom(from.slice(0, -1));
    show(step.sheet, step.grid);
    setOps(step.ops);
    setEditing(null);
  };
  const undo = () => travel(history, setHistory, setFuture);
  const redo = () => travel(future, setFuture, setHistory);

  const save = async () => {
    if (!dirty || saving || loading) return;
    setSaving(true);
    const changes = pendingEdit ? [...ops, pendingEdit] : ops;
    try {
      const result = await send<{ version: number }>('PATCH', `/files/${file.id}/table`, { operations: changes, expected_version: version.current });
      version.current = result.version;
      setEditing(null);
      cache.current.clear();
      setOps([]);
      setHistory([]);
      setFuture([]);
      await load(sheet);
    } catch (failure) {
      overlay.toast((failure as Error).message, { error: true });
    } finally {
      setSaving(false);
    }
  };

  const revert = async () => {
    const ok = await overlay.confirm({ title: '放弃未保存的修改？', confirmLabel: '放弃修改', danger: true });
    if (!ok) return;
    cache.current.clear();
    setOps([]);
    setHistory([]);
    setFuture([]);
    setEditing(null);
    void load(sheet);
  };

  const bounds = {
    top: Math.min(range.row, range.row2), bottom: Math.max(range.row, range.row2),
    left: Math.min(range.column, range.column2), right: Math.max(range.column, range.column2)
  };
  const cellValue = (row: number, column: number) => grid.rows[row]?.[column] ?? '';
  const formula = grid.formulas[`${range.row}:${range.column}`];

  const reveal = (row: number, column: number) => {
    const element = scroller.current;
    if (!element) return;
    const kept = frozen ? ROW_HEIGHT : 0;
    const top = row * ROW_HEIGHT;
    if (!(frozen && row === 0)) {
      if (top < element.scrollTop + kept) element.scrollTop = top - kept;
      else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight - HEADER_HEIGHT) element.scrollTop = top + ROW_HEIGHT - element.clientHeight + HEADER_HEIGHT;
    }
    const left = offsets[column] ?? 0;
    const right = offsets[column + 1] ?? left;
    if (left < element.scrollLeft) element.scrollLeft = left;
    else if (right > element.scrollLeft + element.clientWidth - GUTTER) element.scrollLeft = right - element.clientWidth + GUTTER;
  };

  const select = (row: number, column: number, extend = false) => {
    row = clamp(row, 0, Math.max(0, rowCount - 1));
    column = clamp(column, 0, Math.max(0, grid.columns - 1));
    setRange(extend ? { ...range, row2: row, column2: column } : { row, column, row2: row, column2: column });
    reveal(row, column);
  };

  const finishEdit = (move?: 'down' | 'right') => {
    if (!editing || saving) return;
    setEditing(null);
    if (pendingEdit) commit([pendingEdit]);
    if (move === 'down') select(editing.row + 1, editing.column);
    if (move === 'right') select(editing.row, editing.column + 1);
    if (move) scroller.current?.focus();
  };

  const startEdit = (row: number, column: number, initial?: string) => {
    if (readOnly || loading || saving) return;
    setRange({ row, column, row2: row, column2: column });
    setEditing({ row, column, value: initial ?? grid.formulas[`${row}:${column}`] ?? cellValue(row, column) });
  };

  const clearRange = (target = bounds) => {
    const list: TableOp[] = [];
    for (let r = target.top; r <= target.bottom; r++) {
      for (let c = target.left; c <= target.right; c++) if ((grid.formulas[`${r}:${c}`] ?? cellValue(r, c)) !== '') list.push({ type: 'set', sheet, row: r, column: c, value: '' });
    }
    commit(list);
  };

  const copyText = (target = bounds) => {
    const lines = [];
    for (let r = target.top; r <= target.bottom; r++) {
      const cells = [];
      for (let c = target.left; c <= target.right; c++) cells.push(clipboardCell(cellValue(r, c)));
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  };

  const paste = (text: string) => {
    if (!text) return;
    const rows = parseClipboard(text);
    const single = rows.length === 1 && rows[0].length === 1;
    const list: TableOp[] = [];
    const put = (row: number, column: number, value: string) => {
      if ((grid.formulas[`${row}:${column}`] ?? cellValue(row, column)) !== value) list.push({ type: 'set', sheet, row, column, value });
    };
    if (single && (bounds.bottom > bounds.top || bounds.right > bounds.left)) {
      // One value pasted over a selection fills all of it.
      for (let r = bounds.top; r <= bounds.bottom; r++) for (let c = bounds.left; c <= bounds.right; c++) put(r, c, rows[0][0]);
    } else {
      rows.forEach((cells, r) => cells.forEach((value, c) => put(bounds.top + r, bounds.left + c, value)));
    }
    commit(list);
  };

  const structure = (type: Exclude<TableOp['type'], 'set'>, at: number, count: number) => {
    setEditing(null);
    commit([{ type, sheet, at, count }]);
  };

  // --------------------------------------------------------------- find

  const term = find?.term.trim().toLowerCase() ?? '';
  const matches = useMemo(() => {
    const list: [number, number][] = [];
    const cells = new Set<string>();
    if (!term) return { list, cells };
    for (let r = 0; r < grid.rows.length && list.length < MATCH_LIMIT; r++) {
      const row = grid.rows[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] && row[c].toLowerCase().includes(term)) {
          list.push([r, c]);
          cells.add(`${r}:${c}`);
        }
      }
    }
    return { list, cells };
  }, [term, grid.rows]);

  const goToMatch = (index: number) => {
    const match = matches.list[index];
    if (!match) return;
    setFind(current => (current ? { ...current, index } : current));
    select(match[0], match[1]);
  };
  const stepMatch = (delta: 1 | -1) => {
    const count = matches.list.length;
    if (count) goToMatch(((find?.index ?? 0) + delta + count) % count);
  };
  const changeTerm = (next: string) => setFind({ term: next, index: -1 });
  // Typing a new term moves to its first match.
  useEffect(() => {
    if (find && find.index < 0 && matches.list.length) goToMatch(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find, matches]);

  const openFind = () => {
    if (find) {
      findInput.current?.focus();
      findInput.current?.select();
    } else setFind({ term: '', index: -1 });
  };
  const closeFind = () => {
    setFind(null);
    scroller.current?.focus({ preventScroll: true });
  };

  // ------------------------------------------------------------- compare

  const diffs = useMemo(() => {
    if (!other) return null;
    const list: [number, number][] = [];
    const rows = Math.max(grid.rows.length, other.length);
    for (let r = 0; r < rows; r++) {
      const mine = grid.rows[r] ?? [];
      const theirs = other[r] ?? [];
      const columns = Math.max(mine.length, theirs.length);
      for (let c = 0; c < columns; c++) if ((mine[c] ?? '') !== (theirs[c] ?? '')) list.push([r, c]);
    }
    return list;
  }, [grid.rows, other]);

  const stepDiff = (delta: 1 | -1) => {
    if (!diffs?.length) return;
    const next = (diffAt + delta + diffs.length) % diffs.length;
    setDiffAt(next);
    select(diffs[next][0], diffs[next][1]);
    if (group) group.driver = scroller.current;
  };

  /** Sum and mean of the numbers in a selection of several cells. */
  const summary = useMemo(() => {
    const cells = (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
    if (cells < 2 || cells > 400_000) return null;
    let count = 0;
    let sum = 0;
    for (let r = bounds.top; r <= bounds.bottom; r++) {
      const row = grid.rows[r];
      if (!row) continue;
      for (let c = bounds.left; c <= bounds.right; c++) {
        const text = row[c];
        if (text === undefined || text.trim() === '') continue;
        const value = Number(text.replace(/,/g, ''));
        if (Number.isNaN(value)) continue;
        count++;
        sum += value;
      }
    }
    return count > 1 ? { count, sum, mean: sum / count } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.rows, bounds.top, bounds.bottom, bounds.left, bounds.right]);

  // ---------------------------------------------------- keyboard, clipboard

  const live = useRef({ copyText, clearRange, paste, openFind, editing: !!editing });
  live.current = { copyText, clearRange, paste, openFind, editing: !!editing };
  useEffect(() => {
    /** Clipboard events count when the grid has the focus, not one of its text fields. */
    const mine = (event: ClipboardEvent) => {
      const element = scroller.current;
      if (!element || live.current.editing) return false;
      if (document.activeElement === element) return true;
      return event.target instanceof Node && element.contains(event.target) && !isTyping(event.target);
    };
    const onCopy = (event: ClipboardEvent) => {
      if (!mine(event)) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', live.current.copyText());
    };
    const onCut = (event: ClipboardEvent) => {
      if (!mine(event)) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', live.current.copyText());
      live.current.clearRange();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!mine(event)) return;
      event.preventDefault();
      live.current.paste(event.clipboardData?.getData('text/plain') ?? '');
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !modKey(event) || event.key.toLowerCase() !== 'f') return;
      if (document.querySelector('.overlay-backdrop') || !findIsFor(root.current, primary)) return;
      event.preventDefault();
      live.current.openFind();
    };
    const onCommand = (event: Event) => {
      if ((event as CustomEvent<string>).detail === 'find' && findIsFor(root.current, primary)) live.current.openFind();
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    window.addEventListener('labcanvas:viewer', onCommand);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('labcanvas:viewer', onCommand);
    };
  }, [primary]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Alt with an arrow moves between entries; that belongs to the viewer.
    if (editing || loading || event.altKey) return;
    const mod = modKey(event);
    const key = event.key;
    const lower = key.toLowerCase();
    const page = Math.max(1, Math.floor(scroll.height / ROW_HEIGHT) - 2);
    const [row, column] = event.shiftKey ? [range.row2, range.column2] : [range.row, range.column];
    if (mod && lower === 's') { event.preventDefault(); void save(); }
    else if (mod && lower === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (mod && lower === 'y') { event.preventDefault(); redo(); }
    else if (mod && lower === 'a') { event.preventDefault(); setRange({ row: 0, column: 0, row2: Math.max(0, rowCount - 1), column2: Math.max(0, grid.columns - 1) }); }
    else if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      const down = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
      const right = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
      // With the modifier, an arrow goes to the edge of the table.
      if (mod) select(down ? (down > 0 ? rowCount - 1 : 0) : row, right ? (right > 0 ? grid.columns - 1 : 0) : column, event.shiftKey);
      else select(row + down, column + right, event.shiftKey);
    }
    else if (key === 'Home' || key === 'End') {
      event.preventDefault();
      const last = key === 'End';
      select(mod ? (last ? rowCount - 1 : 0) : row, last ? grid.columns - 1 : 0, event.shiftKey);
    }
    else if (key === 'PageDown' || key === 'PageUp') { event.preventDefault(); select(row + (key === 'PageDown' ? page : -page), column, event.shiftKey); }
    else if (mod) return;
    else if (key === 'Tab') { event.preventDefault(); select(range.row, range.column + (event.shiftKey ? -1 : 1)); }
    else if (key === 'Enter' || key === 'F2') { event.preventDefault(); startEdit(range.row, range.column); }
    else if (key === 'Delete' || key === 'Backspace') { event.preventDefault(); clearRange(); }
    else if (key.length === 1) { event.preventDefault(); startEdit(range.row, range.column, key); }
  };

  const cellAt = (event: React.MouseEvent | MouseEvent) => {
    const element = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
    return element ? { row: Number(element.dataset.row), column: Number(element.dataset.column) } : null;
  };

  const changePrefs = (next: Prefs) => {
    setPrefs(next);
    storePrefs(file.id, next);
  };

  const resetWidth = (column: number) => {
    const next = { ...prefs.widths };
    delete next[`${sheet}:${column}`];
    changePrefs({ ...prefs, widths: next });
  };

  const startColumnResize = (event: React.MouseEvent, column: number) => {
    const origin = widths[column];
    const key = `${sheet}:${column}`;
    let latest = prefs;
    const onMove = (move: MouseEvent) => {
      latest = { ...latest, widths: { ...latest.widths, [key]: clamp(Math.round(origin + move.clientX - event.clientX), 40, 900) } };
      setPrefs(latest);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing-column');
      if (latest !== prefs) storePrefs(file.id, latest);
    };
    document.body.classList.add('resizing-column');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0 || loading || saving) return;
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>('[data-resize-column]');
    if (handle) {
      event.preventDefault();
      return startColumnResize(event, Number(handle.dataset.resizeColumn));
    }
    const header = target.closest<HTMLElement>('[data-header-row], [data-header-column]');
    if (header) {
      if (editing) finishEdit();
      if (header.dataset.headerRow) {
        const row = Number(header.dataset.headerRow);
        setRange({ row, column: 0, row2: row, column2: Math.max(0, grid.columns - 1) });
      } else {
        const column = Number(header.dataset.headerColumn);
        setRange({ row: 0, column, row2: Math.max(0, rowCount - 1), column2: column });
      }
      return;
    }
    const cell = cellAt(event);
    if (!cell) return;
    if (editing) {
      if (editing.row === cell.row && editing.column === cell.column) return;
      finishEdit();
    }
    if (event.shiftKey) setRange({ ...range, row2: cell.row, column2: cell.column });
    else setRange({ row: cell.row, column: cell.column, row2: cell.row, column2: cell.column });
    const onMove = (move: MouseEvent) => {
      const over = cellAt(move);
      if (over) setRange(current => ({ ...current, row2: over.row, column2: over.column }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onContextMenu = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    const header = target.closest<HTMLElement>('[data-header-row], [data-header-column]');
    const cell = cellAt(event);
    if (!header && !cell) return;
    event.preventDefault();
    if (loading || saving) return;
    const headerRow = header?.dataset.headerRow;
    const headerColumn = header?.dataset.headerColumn;
    const inside = cell && cell.row >= bounds.top && cell.row <= bounds.bottom && cell.column >= bounds.left && cell.column <= bounds.right;
    let targetBounds = bounds;
    if (cell && !inside) {
      targetBounds = { top: cell.row, bottom: cell.row, left: cell.column, right: cell.column };
    } else if (headerRow !== undefined) {
      targetBounds = { top: Number(headerRow), bottom: Number(headerRow), left: 0, right: Math.max(0, grid.columns - 1) };
    } else if (headerColumn !== undefined) {
      targetBounds = { top: 0, bottom: Math.max(0, rowCount - 1), left: Number(headerColumn), right: Number(headerColumn) };
    }
    if (targetBounds !== bounds) setRange({ row: targetBounds.top, column: targetBounds.left, row2: targetBounds.bottom, column2: targetBounds.right });
    const rows = { at: targetBounds.top, count: targetBounds.bottom - targetBounds.top + 1 };
    const columns = { at: targetBounds.left, count: targetBounds.right - targetBounds.left + 1 };
    const copy = async (cut = false) => {
      try {
        await navigator.clipboard.writeText(copyText(targetBounds));
        if (cut) clearRange(targetBounds);
      } catch {
        overlay.toast('无法写入剪贴板', { error: true });
      }
    };
    const rowItems = readOnly ? [] : [
      { label: '在上方插入行', onSelect: () => structure('insertRows', rows.at, 1) },
      { label: '在下方插入行', onSelect: () => structure('insertRows', rows.at + rows.count, 1) },
      { label: rows.count > 1 ? `删除 ${rows.count} 行` : '删除行', danger: true, onSelect: () => structure('deleteRows', rows.at, rows.count) }
    ];
    const columnItems = readOnly ? [] : [
      { label: '在左侧插入列', onSelect: () => structure('insertColumns', columns.at, 1) },
      { label: '在右侧插入列', onSelect: () => structure('insertColumns', columns.at + columns.count, 1) },
      { label: columns.count > 1 ? `删除 ${columns.count} 列` : '删除列', danger: true, onSelect: () => structure('deleteColumns', columns.at, columns.count) }
    ];
    const viewItems = [
      ...(headerColumn !== undefined && prefs.widths[`${sheet}:${headerColumn}`]
        ? [{ label: '自动列宽', onSelect: () => resetWidth(Number(headerColumn)) }]
        : []),
      { label: '冻结首行', checked: prefs.frozen, onSelect: () => changePrefs({ ...prefs, frozen: !prefs.frozen }) }
    ];
    const cellItems = headerColumn !== undefined ? [] : [
      { label: '复制', shortcut: shortcut('C'), onSelect: () => void copy() },
      ...(readOnly ? [] : [
        { label: '剪切', shortcut: shortcut('X'), onSelect: () => void copy(true) },
        { label: '清除内容', onSelect: () => clearRange(targetBounds) }
      ])
    ];
    const groups = [cellItems, headerColumn !== undefined ? columnItems : header ? rowItems : [...rowItems, ...(rowItems.length ? ['separator' as const] : []), ...columnItems], viewItems];
    overlay.menu({ x: event.clientX, y: event.clientY }, groups.filter(items => items.length).flatMap((items, index) => (index ? ['separator' as const, ...items] : items)));
  };

  if (error) return <div className="viewer-message">{error}</div>;
  if (!meta) return <div className="viewer-message">正在载入…</div>;

  const lead = frozen ? 1 : 0;
  const first = Math.max(lead, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rowCount, Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN);
  const totalWidth = offsets[offsets.length - 1];
  const address = `${columnName(range.column)}${meta.offset + range.row + 1}`;
  const movePage = (to: number) => {
    setRange(ORIGIN);
    scroller.current?.scrollTo(0, 0);
    void load(sheet, to, version.current);
  };

  /** The cells of one row. The frozen first row is drawn in the header with the same cells. */
  const cells = (r: number) => {
    const row = grid.rows[r] ?? [];
    return widths.map((width, c) => {
      const inRange = r >= bounds.top && r <= bounds.bottom && c >= bounds.left && c <= bounds.right;
      const focused = r === range.row && c === range.column;
      if (editing && editing.via !== 'bar' && focused) {
        return (
          <input
            key={c}
            className="grid-editor"
            style={{ width }}
            autoFocus
            readOnly={saving}
            value={editing.value}
            onChange={event => setEditing({ ...editing, value: event.target.value })}
            onMouseDown={event => event.stopPropagation()}
            onDoubleClick={event => event.stopPropagation()}
            onBlur={() => finishEdit()}
            onKeyDown={event => {
              event.stopPropagation();
              if (event.key === 'Enter') { event.preventDefault(); finishEdit('down'); }
              else if (event.key === 'Tab') { event.preventDefault(); finishEdit('right'); }
              else if (event.key === 'Escape') { setEditing(null); requestAnimationFrame(() => scroller.current?.focus()); }
              else if (modKey(event) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
            }}
          />
        );
      }
      const text = row[c] ?? '';
      const theirs = other ? other[r]?.[c] ?? '' : text;
      const changed = theirs !== text;
      return (
        <div
          key={c}
          data-row={r}
          data-column={c}
          className={`grid-cell${inRange ? ' in-range' : ''}${focused ? ' focused' : ''}${text !== '' && !Number.isNaN(Number(text)) ? ' num' : ''}${changed ? ' changed' : ''}${term && matches.cells.has(`${r}:${c}`) ? ' match' : ''}`}
          style={{ width }}
          title={changed ? `另一侧：${theirs === '' ? '（空）' : theirs}` : undefined}
        >
          {text}
        </div>
      );
    });
  };

  return (
    <div ref={root} className="table-view" aria-busy={loading}>
      <div className="formula-bar">
        <span className="cell-address">{address}</span>
        <input
          className="formula-input"
          aria-label="单元格内容"
          value={loading ? '' : editing ? editing.value : formula ?? cellValue(range.row, range.column)}
          readOnly={readOnly || loading || saving}
          onChange={event => setEditing({ row: range.row, column: range.column, value: event.target.value, via: 'bar' })}
          onKeyDown={event => {
            if (modKey(event) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
            else if (event.key === 'Enter') { event.preventDefault(); finishEdit('down'); }
            else if (event.key === 'Escape') { setEditing(null); }
          }}
          onBlur={() => finishEdit()}
        />
        <button className={`icon-button${find ? ' active' : ''}`} aria-label="查找" title={`查找（${shortcut('F')}）`} disabled={loading} onClick={() => (find ? closeFind() : openFind())}><Search size={14} /></button>
        {!fixed && (
          <>
            <span className="bar-divider" />
            <button className="button small" title="在末尾添加一行" disabled={readOnly || loading || saving} onClick={() => structure('insertRows', rowCount, 1)}><Plus size={13} />行</button>
            <button className="button small" title="在末尾添加一列" disabled={readOnly || loading || saving} onClick={() => structure('insertColumns', grid.columns, 1)}><Plus size={13} />列</button>
            <span className="bar-divider" />
            <button className="icon-button" aria-label="撤销" title={`撤销（${shortcut('Z')}）`} disabled={!history.length || saving || loading} onClick={undo}><Undo2 size={15} /></button>
            <button className="icon-button" aria-label="重做" title={`重做（${shortcut('Z', true)}）`} disabled={!future.length || saving || loading} onClick={redo}><Redo2 size={15} /></button>
            {dirty && <button className="button small" disabled={saving || loading} onClick={() => void revert()}>还原</button>}
            <button className="button small primary" disabled={!dirty || saving || loading} onClick={() => void save()}>{saving ? '正在保存…' : '保存'}</button>
          </>
        )}
      </div>
      {find && (
        <FindBar
          term={find.term}
          count={matches.list.length}
          index={Math.max(0, find.index)}
          capped={matches.list.length >= MATCH_LIMIT}
          inputRef={findInput}
          onTerm={changeTerm}
          onStep={stepMatch}
          onClose={closeFind}
        />
      )}
      <div
        ref={scroller}
        className="grid-scroller"
        role="grid"
        tabIndex={0}
        onScroll={event => setScroll({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        onDoubleClick={event => {
          const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-resize-column]');
          if (handle) return resetWidth(Number(handle.dataset.resizeColumn));
          const cell = cellAt(event);
          if (cell) startEdit(cell.row, cell.column);
        }}
        onContextMenu={onContextMenu}
      >
        {loading ? <div className="empty-state">正在载入…</div> : <div className="grid-canvas" style={{ width: GUTTER + totalWidth, height: HEADER_HEIGHT + rowCount * ROW_HEIGHT }}>
          <div className="grid-header" style={{ width: GUTTER + totalWidth }}>
            <div className="grid-letters">
              <div className="grid-corner" style={{ width: GUTTER }} />
              {widths.map((width, c) => (
                <div key={c} data-header-column={c} className={`grid-column-name${c >= bounds.left && c <= bounds.right ? ' active' : ''}`} style={{ width }}>
                  {columnName(c)}
                  <span className="grid-column-resize" data-resize-column={c} title="拖动调整列宽，双击恢复自动宽度" />
                </div>
              ))}
            </div>
            {frozen && (
              <div className="grid-frozen">
                <div data-header-row={0} className={`grid-row-number${bounds.top === 0 ? ' active' : ''}`} style={{ width: GUTTER }}>1</div>
                {cells(0)}
              </div>
            )}
          </div>
          {Array.from({ length: Math.max(0, last - first) }, (_, index) => {
            const r = first + index;
            return (
              <div key={r} className="grid-row" style={{ top: HEADER_HEIGHT + r * ROW_HEIGHT, width: GUTTER + totalWidth }}>
                <div data-header-row={r} className={`grid-row-number${r >= bounds.top && r <= bounds.bottom ? ' active' : ''}`} style={{ width: GUTTER }}>{meta.offset + r + 1}</div>
                {cells(r)}
              </div>
            );
          })}
        </div>}
      </div>
      <div className="table-status">
        <div className="sheet-tabs">
          {meta.sheets.length > 1 && meta.sheets.map((item, index) => (
            <button key={index} disabled={loading || saving} className={index === sheet ? 'active' : undefined} onClick={() => switchSheet(index)}>{item.name}</button>
          ))}
        </div>
        <span>{meta.totalRows > LOAD_LIMIT ? `第 ${meta.offset + 1}–${meta.offset + rowCount} 行 / 共 ${meta.totalRows} 行 · 只读` : `${rowCount} 行 × ${grid.columns} 列${fixed ? ' · 只读' : ''}`}</span>
        {meta.totalRows > LOAD_LIMIT && (
          <div className="sheet-tabs">
            <button className="icon-button small" aria-label="上一页" disabled={!meta.offset || loading} onClick={() => movePage(meta.offset - LOAD_LIMIT)}><ChevronLeft size={13} /></button>
            <button className="icon-button small" aria-label="下一页" disabled={meta.offset + rowCount >= meta.totalRows || loading} onClick={() => movePage(meta.offset + LOAD_LIMIT)}><ChevronRight size={13} /></button>
          </div>
        )}
        {diffs && (
          <span className="status-group">
            <span className={diffs.length ? 'differs' : undefined}>{diffs.length ? `${diffs.length} 个单元格不同` : '内容相同'}</span>
            {diffs.length > 0 && (
              <>
                <button className="icon-button small" aria-label="上一处不同" title="上一处不同" onClick={() => stepDiff(-1)}><ChevronUp size={13} /></button>
                <button className="icon-button small" aria-label="下一处不同" title="下一处不同" onClick={() => stepDiff(1)}><ChevronDown size={13} /></button>
              </>
            )}
          </span>
        )}
        {dirty && <span className="unsaved">有未保存的修改</span>}
        <span className="spacer" />
        {summary && <span className="selectable">求和 {formatNumber(summary.sum)} · 平均 {formatNumber(summary.mean)} · 计数 {summary.count}</span>}
        <button
          className={`status-toggle${prefs.frozen ? ' active' : ''}`}
          aria-pressed={prefs.frozen}
          title="滚动时首行保持可见"
          onClick={() => changePrefs({ ...prefs, frozen: !prefs.frozen })}
        >
          冻结首行
        </button>
      </div>
    </div>
  );
}
