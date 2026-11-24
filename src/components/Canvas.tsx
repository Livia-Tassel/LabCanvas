import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Frame, Maximize, Minus, Plus, Redo2, StickyNote, Undo2 } from 'lucide-react';
import { api, send } from '../api';
import { useLab } from '../state';
import { useOverlay } from './ui';
import { useEntryMenu } from './entryMenu';
import { EntryCard, defaultCardWidth } from './EntryCard';
import { clamp, droppedFiles, isTyping, modKey, shortId, shortcut } from '../util';
import type { Annotation, Entry, Layout, Viewport } from '../types';

type Box = { x: number; y: number; w: number };
type Rect = { left: number; top: number; width: number; height: number };
/** Earlier state of the cards and annotations an action touched; applying it undoes the action. */
type Change = { boxes: (readonly [string, Box])[]; notes: (readonly [string, Annotation | null])[] };

const GAP = 28;
/** Automatic arrangement never shrinks cards below this zoom to make them all fit. */
const READABLE_ZOOM = 0.7;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const MIN_CARD = 240;
const MAX_CARD = 1800;
/** Height assumed for a card that has not been drawn yet. */
const ASSUMED_HEIGHT = 300;
/** Above this many cards, only those near the visible area are drawn. */
const CULL_FROM = 60;

/**
 * Lays cards out in rows of a given width. A card goes into the first row that still has room,
 * so a narrow card can fill the gap left beside a wide one.
 */
function pack(items: { id: string; w: number; h: number }[], originX: number, originY: number, rowWidth: number) {
  const rows: { used: number; height: number; cards: { id: string; x: number; w: number }[] }[] = [];
  for (const item of items) {
    let row = rows.find(candidate => candidate.used + GAP + item.w <= rowWidth);
    if (!row) rows.push(row = { used: -GAP, height: 0, cards: [] });
    row.cards.push({ id: item.id, x: row.used + GAP, w: item.w });
    row.used += GAP + item.w;
    row.height = Math.max(row.height, item.h);
  }
  const placed = new Map<string, Box>();
  let y = originY;
  for (const row of rows) {
    for (const card of row.cards) placed.set(card.id, { x: originX + card.x, y, w: card.w });
    y += row.height + GAP;
  }
  return placed;
}

export function Canvas() {
  const lab = useLab();
  const overlay = useOverlay();
  const entryMenu = useEntryMenu();
  const { entries, projectId, view, selection, setSelection, actions } = lab;
  const layoutKey = `${projectId}:${view}`;

  const root = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Map<string, Box>>(new Map());
  const [annotations, setAnnotationsState] = useState<Annotation[]>([]);
  const [picked, setPickedState] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [viewport, setViewportState] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [size, setSize] = useState({ width: 1600, height: 1000 });
  const [loadedKey, setLoadedKey] = useState('');
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [fileDropEntry, setFileDropEntry] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });

  // Event handlers read the latest values from refs so they never act on a stale render.
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const annotationsRef = useRef(annotations);
  const pickedRef = useRef(picked);
  const viewportRef = useRef(viewport);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const keyRef = useRef(layoutKey);
  keyRef.current = layoutKey;
  const needsFit = useRef(false);
  const spaceDown = useRef(false);
  const heights = useRef(new Map<string, number>());
  const undoStack = useRef<Change[]>([]);
  const redoStack = useRef<Change[]>([]);
  const pendingViewport = useRef<{ url: string; viewport: Viewport; timer: number } | null>(null);

  const query = `view=${encodeURIComponent(view)}`;
  const layoutUrl = `/projects/${projectId}/layout?${query}`;
  const urlRef = useRef(layoutUrl);
  urlRef.current = layoutUrl;
  const noteUrl = useRef('');
  noteUrl.current = `/projects/${projectId}/annotations?${query}`;

  const setAnnotations = useCallback((list: Annotation[]) => {
    annotationsRef.current = list;
    setAnnotationsState(list);
  }, []);
  const setPicked = useCallback((ids: string[]) => {
    pickedRef.current = ids;
    setPickedState(ids);
  }, []);
  const commitPositions = useCallback((next: Map<string, Box>) => {
    positionsRef.current = next;
    setPositions(next);
  }, []);

  const savePositions = useCallback((ids: Iterable<string>) => {
    const list = [...ids].flatMap(id => {
      const box = positionsRef.current.get(id);
      return box ? [{ entry_id: id, ...box }] : [];
    });
    if (list.length) void send('PUT', urlRef.current, { positions: list }).catch(() => {});
  }, []);

  /** Stores an annotation; the server creates it or updates the one with the same id. */
  const saveNote = useCallback((note: Annotation) => {
    void send('POST', noteUrl.current, note).catch(error => overlay.toast(error.message, { error: true }));
  }, [overlay]);

  const flushViewport = useCallback(() => {
    const pending = pendingViewport.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingViewport.current = null;
    void api(pending.url, { method: 'PUT', body: JSON.stringify({ viewport: pending.viewport }), keepalive: true }).catch(() => {});
  }, []);

  const setViewport = useCallback((next: Viewport) => {
    viewportRef.current = next;
    setViewportState(next);
    const url = urlRef.current;
    if (pendingViewport.current?.url !== url) flushViewport();
    clearTimeout(pendingViewport.current?.timer);
    pendingViewport.current = { url, viewport: next, timer: window.setTimeout(flushViewport, 400) };
  }, [flushViewport]);

  useEffect(() => {
    window.addEventListener('pagehide', flushViewport);
    return () => {
      window.removeEventListener('pagehide', flushViewport);
      flushViewport();
    };
  }, [layoutKey, flushViewport]);

  useLayoutEffect(() => {
    const element = root.current!;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Height of a card: measured when it is drawn, otherwise the last known or an assumed one. */
  const heightOf = useCallback((id: string) => {
    const element = root.current?.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
    if (element) {
      heights.current.set(id, element.offsetHeight);
      return element.offsetHeight;
    }
    return heights.current.get(id) ?? ASSUMED_HEIGHT;
  }, []);

  const boundsOf = useCallback((list: Entry[], withAnnotations = false) => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const include = (x: number, y: number, w: number, h: number) => {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + w);
      bottom = Math.max(bottom, y + h);
    };
    for (const entry of list) {
      const box = positionsRef.current.get(entry.id);
      if (box) include(box.x, box.y, box.w, heightOf(entry.id));
    }
    if (withAnnotations) for (const note of annotationsRef.current) include(note.x, note.y - (note.kind === 'frame' ? 26 : 0), note.w, note.h);
    return Number.isFinite(left) ? { left, top, right, bottom } : null;
  }, [heightOf]);

  /** Width of an automatically arranged row: what the window shows at a readable zoom. */
  const rowWidth = () => clamp(((root.current?.clientWidth ?? 1200) - 96) / READABLE_ZOOM, 1000, 2600);

  /** Shows everything. With `minZoom`, stays readable and starts at the top left when it cannot all fit. */
  const fit = useCallback((minZoom = MIN_ZOOM) => {
    const element = root.current;
    const bounds = boundsOf(entriesRef.current, true);
    if (!element || !bounds) return setViewport({ x: 48, y: 48, zoom: 1 });
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    const padding = clamp(Math.min(element.clientWidth, element.clientHeight) * 0.08, 20, 48);
    const zoom = clamp(Math.min((element.clientWidth - 2 * padding) / width, (element.clientHeight - 2 * padding) / height, 1), minZoom, MAX_ZOOM);
    setViewport({
      x: Math.max(padding, (element.clientWidth - width * zoom) / 2) - bounds.left * zoom,
      y: Math.max(padding, (element.clientHeight - height * zoom) / 2) - bounds.top * zoom,
      zoom
    });
  }, [boundsOf, setViewport]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const element = root.current!;
    const current = viewportRef.current;
    const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const px = cx ?? element.clientWidth / 2;
    const py = cy ?? element.clientHeight / 2;
    setViewport({ x: px - (px - current.x) * (zoom / current.zoom), y: py - (py - current.y) * (zoom / current.zoom), zoom });
  }, [setViewport]);

  /** Pans just enough to bring a card into view. */
  const reveal = useCallback((id: string) => {
    const element = root.current;
    const box = positionsRef.current.get(id);
    if (!element || !box) return;
    const current = viewportRef.current;
    const margin = 32;
    const left = box.x * current.zoom + current.x;
    const top = box.y * current.zoom + current.y;
    const right = left + box.w * current.zoom;
    const bottom = top + heightOf(id) * current.zoom;
    let { x, y } = current;
    if (left < margin) x += margin - left;
    else if (right > element.clientWidth - margin) x -= Math.min(right - element.clientWidth + margin, left - margin);
    if (top < margin) y += margin - top;
    else if (bottom > element.clientHeight - margin) y -= Math.min(bottom - element.clientHeight + margin, top - margin);
    if (x !== current.x || y !== current.y) setViewport({ ...current, x, y });
  }, [heightOf, setViewport]);

  // Each view keeps its own arrangement, annotations and viewport.
  useEffect(() => {
    let active = true;
    setLoadedKey('');
    setPicked([]);
    setEditing(null);
    undoStack.current = [];
    redoStack.current = [];
    setHistory({ undo: 0, redo: 0 });
    api<Layout>(layoutUrl).then(layout => {
      if (!active) return;
      commitPositions(new Map(layout.positions.map(position => [position.entry_id, { x: position.x, y: position.y, w: position.w }])));
      setAnnotations(layout.annotations ?? []);
      needsFit.current = !layout.viewport;
      if (layout.viewport) {
        viewportRef.current = layout.viewport;
        setViewportState(layout.viewport);
      }
      setLoadedKey(layoutKey);
    }).catch(error => overlay.toast(error.message, { error: true }));
    return () => { active = false; };
  }, [layoutKey, layoutUrl, overlay, commitPositions, setAnnotations, setPicked]);

  // Entries that have no position in this view yet (new imports, first visit) are flowed in below the existing cards.
  useLayoutEffect(() => {
    if (loadedKey !== layoutKey) return;
    const unplaced = entries.filter(entry => !positions.has(entry.id));
    if (!unplaced.length) {
      if (needsFit.current) {
        needsFit.current = false;
        fit(READABLE_ZOOM);
      }
      return;
    }
    const hinted = new Map<string, Box>();
    const flowing: { id: string; w: number; h: number }[] = [];
    for (const entry of unplaced) {
      const w = defaultCardWidth(entry);
      const hint = lab.placementHints.current.get(entry.id);
      if (hint) {
        hinted.set(entry.id, { x: hint.x - w / 2, y: hint.y - 24, w });
        lab.placementHints.current.delete(entry.id);
      } else {
        flowing.push({ id: entry.id, w, h: heightOf(entry.id) });
      }
    }
    const bounds = boundsOf(entries, true);
    const packed = pack(flowing, bounds?.left ?? 0, bounds ? bounds.bottom + GAP : 0, rowWidth());
    commitPositions(new Map([...positions, ...packed, ...hinted]));
    savePositions([...packed.keys(), ...hinted.keys()]);
  }, [entries, positions, loadedKey, layoutKey, fit, boundsOf, heightOf, commitPositions, savePositions, lab.placementHints]);

  // Remember how tall the drawn cards are, for cards that are later left out of the drawing.
  useLayoutEffect(() => {
    root.current?.querySelectorAll<HTMLElement>('.card').forEach(card => heights.current.set(card.dataset.entryId!, card.offsetHeight));
  });

  // The viewer steps through entries in reading order: rows from the top, left to right.
  useEffect(() => {
    lab.order.current = [...entries].sort((a, b) => {
      const [p, q] = [positions.get(a.id), positions.get(b.id)];
      if (!p || !q) return p ? -1 : q ? 1 : 0;
      return Math.abs(p.y - q.y) > 120 ? p.y - q.y : p.x - q.x;
    }).map(entry => entry.id);
  }, [entries, positions, lab.order]);

  // ------------------------------------------------------------------ undo

  /** Restores the given earlier state and returns what it replaced. */
  const applyChange = useCallback((change: Change): Change => {
    const inverse: Change = { boxes: [], notes: [] };
    const next = new Map(positionsRef.current);
    for (const [id, box] of change.boxes) {
      const current = next.get(id);
      if (!current) continue;
      inverse.boxes.push([id, current]);
      next.set(id, box);
    }
    commitPositions(next);
    savePositions(inverse.boxes.map(([id]) => id));
    let list = annotationsRef.current;
    for (const [id, note] of change.notes) {
      const current = list.find(item => item.id === id) ?? null;
      inverse.notes.push([id, current]);
      if (note) {
        list = current ? list.map(item => (item.id === id ? note : item)) : [...list, note];
        saveNote(note);
      } else {
        list = list.filter(item => item.id !== id);
        void send('DELETE', `/annotations/${id}`).catch(() => {});
      }
    }
    setAnnotations(list);
    setPicked(pickedRef.current.filter(id => list.some(item => item.id === id)));
    return inverse;
  }, [commitPositions, savePositions, saveNote, setAnnotations, setPicked]);

  const record = useCallback((before: Change) => {
    if (!before.boxes.length && !before.notes.length) return;
    undoStack.current = [...undoStack.current.slice(-49), before];
    redoStack.current = [];
    setHistory({ undo: undoStack.current.length, redo: 0 });
  }, []);

  const undo = useCallback(() => {
    const change = undoStack.current.pop();
    if (change) redoStack.current.push(applyChange(change));
    setHistory({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, [applyChange]);

  const redo = useCallback(() => {
    const change = redoStack.current.pop();
    if (change) undoStack.current.push(applyChange(change));
    setHistory({ undo: undoStack.current.length, redo: redoStack.current.length });
  }, [applyChange]);

  const tidy = useCallback(() => {
    const sorted = [...entriesRef.current].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'zh-CN'));
    if (!sorted.length) return;
    const packed = pack(sorted.map(entry => ({ id: entry.id, w: positionsRef.current.get(entry.id)?.w ?? defaultCardWidth(entry), h: heightOf(entry.id) })), 0, 0, rowWidth());
    record({ boxes: [...packed.keys()].flatMap(id => { const box = positionsRef.current.get(id); return box ? [[id, box] as [string, Box]] : []; }), notes: [] });
    commitPositions(new Map([...positionsRef.current, ...packed]));
    savePositions(packed.keys());
    requestAnimationFrame(() => fit(READABLE_ZOOM));
    overlay.toast('已按实验日期整理排列', { action: { label: '撤销', run: undo } });
  }, [fit, heightOf, record, commitPositions, savePositions, overlay, undo]);

  // ----------------------------------------------------------- annotations

  const changeNote = useCallback((id: string, patch: Partial<Annotation>, remember = true) => {
    const current = annotationsRef.current.find(item => item.id === id);
    if (!current) return;
    const next = { ...current, ...patch };
    if (remember) record({ boxes: [], notes: [[id, current]] });
    setAnnotations(annotationsRef.current.map(item => (item.id === id ? next : item)));
    saveNote(next);
  }, [record, saveNote, setAnnotations]);

  const addNote = useCallback((kind: Annotation['kind'], at?: { x: number; y: number }) => {
    const element = root.current!;
    const current = viewportRef.current;
    const center = at ?? { x: (element.clientWidth / 2 - current.x) / current.zoom, y: (element.clientHeight / 2 - current.y) / current.zoom };
    let note: Annotation;
    const around = kind === 'frame' ? boundsOf(entriesRef.current.filter(entry => selectionRef.current.includes(entry.id))) : null;
    if (around) {
      // A frame drawn with cards selected encloses them.
      note = { id: `ann_${shortId()}`, kind, x: around.left - 24, y: around.top - 24, w: around.right - around.left + 48, h: around.bottom - around.top + 48, text: '' };
    } else if (kind === 'frame') {
      note = { id: `ann_${shortId()}`, kind, x: Math.round(center.x - 320), y: Math.round(center.y - 200), w: 640, h: 400, text: '' };
    } else {
      note = { id: `ann_${shortId()}`, kind, x: Math.round(center.x - 110), y: Math.round(center.y - 30), w: 220, h: 64, text: '' };
    }
    record({ boxes: [], notes: [[note.id, null]] });
    setAnnotations([...annotationsRef.current, note]);
    saveNote(note);
    setSelection([]);
    setPicked([note.id]);
    setEditing(note.id);
  }, [boundsOf, record, saveNote, setAnnotations, setPicked, setSelection]);

  const removeNotes = useCallback((ids: string[]) => {
    const removed = annotationsRef.current.filter(item => ids.includes(item.id));
    if (!removed.length) return;
    record({ boxes: [], notes: removed.map(note => [note.id, note]) });
    setAnnotations(annotationsRef.current.filter(item => !ids.includes(item.id)));
    setPicked(pickedRef.current.filter(id => !ids.includes(id)));
    for (const note of removed) void send('DELETE', `/annotations/${note.id}`).catch(() => {});
  }, [record, setAnnotations, setPicked]);

  // Toolbar and application-menu commands.
  useEffect(() => {
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === 'fit') fit();
      else if (command === 'zoomIn') zoomAt(1.25);
      else if (command === 'zoomOut') zoomAt(0.8);
      else if (command === 'actualSize') zoomAt(1 / viewportRef.current.zoom);
      else if (command === 'tidy') tidy();
      else if (command === 'note') addNote('note');
      else if (command === 'frame') addNote('frame');
    };
    window.addEventListener('labcanvas:canvas', onCommand);
    return () => window.removeEventListener('labcanvas:canvas', onCommand);
  }, [fit, zoomAt, tidy, addNote]);

  // Two-finger scroll pans; pinch or Cmd/Ctrl + scroll zooms around the pointer.
  useEffect(() => {
    const element = root.current!;
    const onWheel = (event: WheelEvent) => {
      // A note being edited scrolls its own text.
      if ((event.target as HTMLElement).closest('textarea')) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * (event.ctrlKey && !Number.isInteger(event.deltaY) ? 0.012 : 0.004)), event.clientX - box.left, event.clientY - box.top);
      } else {
        const current = viewportRef.current;
        setViewport({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt, setViewport]);

  /** Moves the selection to the nearest card in the direction of an arrow key. */
  const stepSelection = useCallback((dx: number, dy: number) => {
    const list = entriesRef.current;
    if (!list.length) return;
    const from = selectionRef.current[selectionRef.current.length - 1];
    const origin = from ? positionsRef.current.get(from) : undefined;
    if (!origin) {
      const first = lab.order.current[0] ?? list[0].id;
      setSelection([first]);
      return reveal(first);
    }
    const cx = origin.x + origin.w / 2;
    const cy = origin.y + heightOf(from) / 2;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const entry of list) {
      const box = positionsRef.current.get(entry.id);
      if (!box || entry.id === from) continue;
      const ox = box.x + box.w / 2 - cx;
      const oy = box.y + heightOf(entry.id) / 2 - cy;
      const along = ox * dx + oy * dy;
      const across = Math.abs(ox * dy) + Math.abs(oy * dx);
      // Only cards that lie in the direction of travel, and not further aside than ahead by much.
      if (along <= 8 || across > along * 2.5) continue;
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = entry.id; }
    }
    if (best) {
      setSelection([best]);
      reveal(best);
    }
  }, [heightOf, reveal, setSelection, lab.order]);

  useEffect(() => {
    const resetSpace = () => {
      spaceDown.current = false;
      root.current?.classList.remove('pan-ready');
    };
    const onDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || document.querySelector('.viewer, .overlay-backdrop')) return;
      if (event.code === 'Space' && !target.closest('input, textarea, select, button, a, [role="button"], [contenteditable]')) {
        spaceDown.current = true;
        root.current?.classList.add('pan-ready');
        return event.preventDefault();
      }
      if (isTyping(target)) return;
      const key = event.key.toLowerCase();
      if (modKey(event) && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (modKey(event) && key === 'y') {
        event.preventDefault();
        redo();
      } else if (modKey(event) || event.altKey) {
        return;
      } else if ((key === 'backspace' || key === 'delete') && pickedRef.current.length) {
        // With cards selected as well, the application goes on to handle those.
        if (!selectionRef.current.length) event.preventDefault();
        removeNotes(pickedRef.current);
      } else if (key === 'escape' && pickedRef.current.length) {
        setPicked([]);
      } else if (key.startsWith('arrow') && !target.closest('.sidebar, .inspector')) {
        event.preventDefault();
        stepSelection(key === 'arrowright' ? 1 : key === 'arrowleft' ? -1 : 0, key === 'arrowdown' ? 1 : key === 'arrowup' ? -1 : 0);
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') resetSpace();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', resetSpace);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', resetSpace);
    };
  }, [undo, redo, removeNotes, setPicked, stepSelection]);

  const toWorld = (clientX: number, clientY: number) => {
    const box = root.current!.getBoundingClientRect();
    const current = viewportRef.current;
    return { x: (clientX - box.left - current.x) / current.zoom, y: (clientY - box.top - current.y) / current.zoom };
  };

  /** Follows the pointer until release. `move` receives the screen-space distance from the start. */
  const track = (start: React.PointerEvent, move: (dx: number, dy: number, event: PointerEvent) => void, end: (event: PointerEvent) => void) => {
    const onMove = (event: PointerEvent) => move(event.clientX - start.clientX, event.clientY - start.clientY, event);
    const onUp = (event: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      end(event);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const startPan = (event: React.PointerEvent) => {
    const origin = viewportRef.current;
    setGrabbing(true);
    track(event, (dx, dy) => setViewport({ ...origin, x: origin.x + dx, y: origin.y + dy }), () => setGrabbing(false));
  };

  const startMarquee = (event: React.PointerEvent) => {
    const box = root.current!.getBoundingClientRect();
    const additive = event.shiftKey || modKey(event);
    const base = additive ? selectionRef.current : [];
    const baseNotes = additive ? pickedRef.current : [];
    const from = toWorld(event.clientX, event.clientY);
    let moved = false;
    track(event, (dx, dy, current) => {
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      setMarquee({
        left: Math.min(event.clientX, current.clientX) - box.left,
        top: Math.min(event.clientY, current.clientY) - box.top,
        width: Math.abs(dx),
        height: Math.abs(dy)
      });
      const to = toWorld(current.clientX, current.clientY);
      const [x1, x2] = [Math.min(from.x, to.x), Math.max(from.x, to.x)];
      const [y1, y2] = [Math.min(from.y, to.y), Math.max(from.y, to.y)];
      const hit = entriesRef.current.filter(entry => {
        const card = positionsRef.current.get(entry.id);
        return card && card.x < x2 && card.x + card.w > x1 && card.y < y2 && card.y + heightOf(entry.id) > y1;
      }).map(entry => entry.id);
      // Notes are taken when touched; a frame only when it is enclosed, or it would always be caught.
      const notes = annotationsRef.current.filter(note => (note.kind === 'frame'
        ? note.x >= x1 && note.x + note.w <= x2 && note.y >= y1 && note.y + note.h <= y2
        : note.x < x2 && note.x + note.w > x1 && note.y < y2 && note.y + note.h > y1)).map(note => note.id);
      setSelection([...new Set([...base, ...hit])]);
      setPicked([...new Set([...baseNotes, ...notes])]);
    }, () => {
      setMarquee(null);
      if (!moved && !additive) {
        setSelection([]);
        setPicked([]);
      }
    });
  };

  const startResize = (event: React.PointerEvent, id: string) => {
    const origin = positionsRef.current.get(id);
    if (!origin) return;
    track(event, dx => {
      const next = new Map(positionsRef.current);
      next.set(id, { ...origin, w: clamp(Math.round(origin.w + dx / viewportRef.current.zoom), MIN_CARD, MAX_CARD) });
      commitPositions(next);
    }, () => {
      if (positionsRef.current.get(id)?.w !== origin.w) record({ boxes: [[id, origin]], notes: [] });
      savePositions([id]);
    });
  };

  const startNoteResize = (event: React.PointerEvent, id: string) => {
    const origin = annotationsRef.current.find(note => note.id === id);
    if (!origin) return;
    const least = origin.kind === 'frame' ? { w: 160, h: 100 } : { w: 120, h: 40 };
    track(event, (dx, dy) => {
      const zoom = viewportRef.current.zoom;
      const next = { ...origin, w: Math.max(least.w, Math.round(origin.w + dx / zoom)), h: Math.max(least.h, Math.round(origin.h + dy / zoom)) };
      setAnnotations(annotationsRef.current.map(note => (note.id === id ? next : note)));
    }, () => {
      const current = annotationsRef.current.find(note => note.id === id);
      if (!current || (current.w === origin.w && current.h === origin.h)) return;
      record({ boxes: [], notes: [[id, origin]] });
      saveNote(current);
    });
  };

  /** Drags the selection, which may hold cards and annotations. A frame carries what lies inside it. */
  const startDrag = (event: React.PointerEvent, hit: { card?: string; note?: string }) => {
    const additive = event.shiftKey || modKey(event);
    const before = { cards: selectionRef.current, notes: pickedRef.current };
    let cards = before.cards;
    let notes = before.notes;
    const wasPicked = hit.card ? cards.includes(hit.card) : notes.includes(hit.note!);
    if (additive) {
      if (hit.card) cards = wasPicked ? cards.filter(id => id !== hit.card) : [...cards, hit.card];
      else notes = wasPicked ? notes.filter(id => id !== hit.note) : [...notes, hit.note!];
      setSelection(cards);
      setPicked(notes);
      if (wasPicked) return;
    } else if (!wasPicked) {
      cards = hit.card ? [hit.card] : [];
      notes = hit.note ? [hit.note] : [];
      setSelection(cards);
      setPicked(notes);
    }
    const movingCards = new Set(cards);
    const movingNotes = new Set(notes);
    for (const id of notes) {
      const frame = annotationsRef.current.find(note => note.id === id && note.kind === 'frame');
      if (!frame) continue;
      const inside = (x: number, y: number) => x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h;
      for (const entry of entriesRef.current) {
        const box = positionsRef.current.get(entry.id);
        if (box && inside(box.x + box.w / 2, box.y + heightOf(entry.id) / 2)) movingCards.add(entry.id);
      }
      for (const note of annotationsRef.current) {
        if (note.kind === 'note' && inside(note.x + note.w / 2, note.y + note.h / 2)) movingNotes.add(note.id);
      }
    }
    const originBoxes = new Map([...movingCards].flatMap(id => {
      const box = positionsRef.current.get(id);
      return box ? [[id, box] as const] : [];
    }));
    const originNotes = new Map(annotationsRef.current.filter(note => movingNotes.has(note.id)).map(note => [note.id, note] as const));
    let moved = false;
    track(event, (dx, dy) => {
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) {
        moved = true;
        if (cards.length) {
          lab.setDragging(cards);
          document.body.classList.add('dragging-entries');
        }
      }
      const zoom = viewportRef.current.zoom;
      const next = new Map(positionsRef.current);
      for (const [id, box] of originBoxes) next.set(id, { ...box, x: Math.round(box.x + dx / zoom), y: Math.round(box.y + dy / zoom) });
      commitPositions(next);
      if (originNotes.size) {
        setAnnotations(annotationsRef.current.map(note => {
          const origin = originNotes.get(note.id);
          return origin ? { ...note, x: Math.round(origin.x + dx / zoom), y: Math.round(origin.y + dy / zoom) } : note;
        }));
      }
    }, release => {
      if (!moved) {
        if (!additive && before.cards.length + before.notes.length > 1) {
          setSelection(hit.card ? [hit.card] : []);
          setPicked(hit.note ? [hit.note] : []);
        }
        return;
      }
      lab.setDragging(null);
      document.body.classList.remove('dragging-entries');
      // Dropping on a sidebar collection files the entries there instead of moving the cards.
      const target = !cards.length || keyRef.current.endsWith(':trash')
        ? null
        : document.elementFromPoint(release.clientX, release.clientY)?.closest<HTMLElement>('[data-drop-collection], [data-drop-trash]');
      if (target) {
        commitPositions(new Map([...positionsRef.current, ...originBoxes]));
        setAnnotations(annotationsRef.current.map(note => originNotes.get(note.id) ?? note));
        const collection = lab.snapshot?.collections.find(c => c.id === target.dataset.dropCollection);
        if (collection) void actions.addToCollection(cards, collection);
        else void actions.trash(cards);
        return;
      }
      savePositions(originBoxes.keys());
      for (const note of annotationsRef.current) if (originNotes.has(note.id)) saveNote(note);
      record({ boxes: [...originBoxes], notes: [...originNotes] });
    });
  };

  const onPointerDown = (event: React.PointerEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('.canvas-controls, .canvas-tools')) return;
    if (event.button === 1 || (event.button === 0 && spaceDown.current)) {
      event.preventDefault();
      return startPan(event);
    }
    if (event.button !== 0) return;
    // A note being edited keeps the pointer for placing the cursor.
    if (target.closest('.note textarea, .frame-title input')) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const note = target.closest<HTMLElement>('[data-note-id]');
    if (note) {
      const id = note.dataset.noteId!;
      if (target.closest('[data-note-resize]')) startNoteResize(event, id);
      else startDrag(event, { note: id });
      return;
    }
    const card = target.closest<HTMLElement>('.card');
    if (!card) {
      if (event.shiftKey || modKey(event)) return startMarquee(event);
      setSelection([]);
      setPicked([]);
      return startPan(event);
    }
    const id = card.dataset.entryId!;
    if (target.closest('[data-resize]')) startResize(event, id);
    else startDrag(event, { card: id });
  };

  const onContextMenu = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('textarea, input')) return;
    event.preventDefault();
    const at = { x: event.clientX, y: event.clientY };
    const noteId = target.closest<HTMLElement>('[data-note-id]')?.dataset.noteId;
    if (noteId) {
      const ids = picked.includes(noteId) ? picked : [noteId];
      setPicked(ids);
      const frame = annotations.find(note => note.id === noteId)?.kind === 'frame';
      return overlay.menu(at, [
        { label: frame ? '重命名' : '编辑文字', disabled: ids.length > 1, onSelect: () => setEditing(noteId) },
        'separator',
        { label: ids.length > 1 ? `删除 ${ids.length} 个标注` : frame ? '删除分组框' : '删除便签', shortcut: '⌫', danger: true, onSelect: () => removeNotes(ids) }
      ]);
    }
    const id = target.closest<HTMLElement>('.card')?.dataset.entryId;
    if (id) {
      const ids = selection.includes(id) ? selection : [id];
      setSelection(ids);
      return entryMenu(at, ids, [{ label: '用分组框圈起', onSelect: () => addNote('frame') }]);
    }
    const world = toWorld(event.clientX, event.clientY);
    overlay.menu(at, [
      { label: '添加文件…', onSelect: async () => actions.receiveFiles(await lab.pickFiles(), world) },
      { label: '新建表格…', onSelect: () => lab.setDialog({ type: 'newTable' }) },
      'separator',
      { label: '添加便签', onSelect: () => addNote('note', world) },
      { label: '添加分组框', onSelect: () => addNote('frame', world) },
      'separator',
      { label: '全选', shortcut: shortcut('A'), onSelect: () => setSelection(entries.map(entry => entry.id)) },
      { label: '整理排列', onSelect: tidy },
      { label: '缩放以显示全部', shortcut: shortcut('0'), onSelect: () => fit() },
      'separator',
      { label: '撤销', shortcut: shortcut('Z'), disabled: !history.undo, onSelect: undo },
      { label: '重做', shortcut: shortcut('Z', true), disabled: !history.redo, onSelect: redo }
    ]);
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('textarea, input, [data-note-resize]')) return;
    const noteId = target.closest<HTMLElement>('[data-note-id]')?.dataset.noteId;
    if (noteId) return setEditing(noteId);
    const id = target.closest<HTMLElement>('.card')?.dataset.entryId;
    if (id && !target.closest('[data-resize]')) lab.open(id, target.closest<HTMLElement>('.tile')?.dataset.fileId);
  };

  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');

  const ready = loadedKey === layoutKey;
  const dots = viewport.zoom >= 0.35;

  // With many cards, draw only those near the visible area. Cards without a position are drawn to be measured.
  const margin = 500 / viewport.zoom;
  const visible = {
    x1: -viewport.x / viewport.zoom - margin,
    y1: -viewport.y / viewport.zoom - margin,
    x2: (size.width - viewport.x) / viewport.zoom + margin,
    y2: (size.height - viewport.y) / viewport.zoom + margin
  };
  const shown = entries.length <= CULL_FROM ? entries : entries.filter(entry => {
    const box = positions.get(entry.id);
    if (!box || selection.includes(entry.id)) return true;
    return box.x < visible.x2 && box.x + box.w > visible.x1 && box.y < visible.y2 && box.y + (heights.current.get(entry.id) ?? 900) > visible.y1;
  });

  const noteElement = (note: Annotation) => {
    const selected = picked.includes(note.id);
    const style = { transform: `translate(${note.x}px, ${note.y}px)`, width: note.w };
    const finish = (text: string) => {
      setEditing(null);
      if (text !== note.text) changeNote(note.id, { text });
    };
    const keys = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, multiline: boolean) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.currentTarget.value = note.text;
        event.currentTarget.blur();
      } else if (event.key === 'Enter' && (!multiline || modKey(event))) {
        event.currentTarget.blur();
      }
    };
    if (note.kind === 'frame') {
      return (
        <div key={note.id} className={`frame${selected ? ' selected' : ''}`} data-note-id={note.id} style={{ ...style, height: note.h }}>
          <div className="frame-title">
            {editing === note.id
              ? <input autoFocus aria-label="分组框名称" defaultValue={note.text} onFocus={event => event.target.select()} onBlur={event => finish(event.target.value.trim())} onKeyDown={event => keys(event, false)} />
              : <span>{note.text || '未命名分组'}</span>}
          </div>
          <div className="frame-resize" data-note-resize aria-hidden />
        </div>
      );
    }
    return (
      <div key={note.id} className={`note${selected ? ' selected' : ''}`} data-note-id={note.id} style={{ ...style, minHeight: note.h }}>
        {editing === note.id
          ? <textarea autoFocus aria-label="便签" defaultValue={note.text} style={{ height: Math.max(note.h - 2, 40) }} onBlur={event => finish(event.target.value)} onKeyDown={event => keys(event, true)} />
          : <div className={`note-text${note.text ? '' : ' empty'}`}>{note.text || '双击输入文字'}</div>}
        <div className="note-resize" data-note-resize aria-hidden />
      </div>
    );
  };

  return (
    <div
      ref={root}
      className={`canvas${grabbing ? ' grabbing' : ''}`}
      data-testid="canvas"
      style={dots ? { backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`, backgroundPosition: `${viewport.x}px ${viewport.y}px` } : { backgroundImage: 'none' }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onDragOver={event => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setFileDropEntry((event.target as HTMLElement).closest<HTMLElement>('.card')?.dataset.entryId ?? null);
      }}
      onDragLeave={() => setFileDropEntry(null)}
      onDrop={event => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setFileDropEntry(null);
        const id = (event.target as HTMLElement).closest<HTMLElement>('.card')?.dataset.entryId;
        const world = toWorld(event.clientX, event.clientY);
        void droppedFiles(event.dataTransfer).then(files => {
          if (id) void actions.addFilesToEntry(id, files);
          else actions.receiveFiles(files, world);
        });
      }}
    >
      <div className="canvas-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
        {ready && annotations.filter(note => note.kind === 'frame').map(noteElement)}
        {ready && shown.map(entry => {
          const box = positions.get(entry.id);
          return (
            <EntryCard
              key={entry.id}
              entry={entry}
              x={box?.x ?? 0}
              y={box?.y ?? 0}
              w={box?.w ?? defaultCardWidth(entry)}
              placed={!!box}
              selected={selection.includes(entry.id)}
              dropTarget={fileDropEntry === entry.id}
              stale={entry.files.filter(file => lab.staleFiles.has(file.id)).map(file => file.id).join(',')}
            />
          );
        })}
        {ready && annotations.filter(note => note.kind === 'note').map(noteElement)}
      </div>
      {marquee && <div className="marquee" style={marquee} />}
      {ready && entries.length === 0 && annotations.length === 0 && (
        <div className="empty-state">{lab.query || lab.kinds.length ? '没有匹配的条目' : '没有条目。将文件拖到此处即可添加。'}</div>
      )}
      <div className="canvas-tools" onDoubleClick={event => event.stopPropagation()}>
        <button className="icon-button" aria-label="添加便签" title="添加便签" onClick={() => addNote('note')}><StickyNote size={14} /></button>
        <button className="icon-button" aria-label="添加分组框" title={selection.length ? '用分组框圈起选中的卡片' : '添加分组框'} onClick={() => addNote('frame')}><Frame size={14} /></button>
        <span className="controls-divider" />
        <button className="icon-button" aria-label="撤销画布操作" title={`撤销（${shortcut('Z')}）`} disabled={!history.undo} onClick={undo}><Undo2 size={14} /></button>
        <button className="icon-button" aria-label="重做画布操作" title={`重做（${shortcut('Z', true)}）`} disabled={!history.redo} onClick={redo}><Redo2 size={14} /></button>
      </div>
      <div className="canvas-controls" onDoubleClick={event => event.stopPropagation()}>
        <button className="icon-button" aria-label="缩小" onClick={() => zoomAt(0.8)}><Minus size={14} /></button>
        <button className="zoom-level" title="实际大小" onClick={() => zoomAt(1 / viewport.zoom)}>{Math.round(viewport.zoom * 100)}%</button>
        <button className="icon-button" aria-label="放大" onClick={() => zoomAt(1.25)}><Plus size={14} /></button>
        <span className="controls-divider" />
        <button className="icon-button" aria-label="缩放以显示全部" title={`缩放以显示全部（${shortcut('0')}）`} onClick={() => fit()}><Maximize size={13} /></button>
      </div>
    </div>
  );
}
