import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, apiText, send, upload } from './api';
import { useOverlay } from './components/ui';
import { descendants, matchesQuery, MAX_IMPORT_FILES } from './util';
import type { Collection, Entry, Field, FileKind, LabFile, Project, SearchHit, Snapshot, ViewKey } from './types';

export type Mode = 'canvas' | 'list';
export type DialogState =
  | { type: 'newTable' }
  | { type: 'help' }
  | { type: 'shortcuts' }
  | { type: 'collections'; entryIds: string[] }
  | { type: 'import'; files: File[]; position?: { x: number; y: number }; collectionId: string | null };

/** What the full-window viewer shows; `compare` puts a second file beside the first. */
export type ViewerState = { entryId: string; fileId?: string; compare?: { fileId: string; version?: number } };

type ImportedFile = { id: string; name: string; duplicate_of?: { entry_id: string; title: string } };
type CreatedEntries = { entries: { id: string; files: ImportedFile[] }[] };
type Progress = { label: string; fraction: number };

function useLabState() {
  const overlay = useOverlay();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState(() => localStorage.getItem('labcanvas.project') ?? '');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setViewState] = useState<ViewKey>(() => localStorage.getItem(`labcanvas.view.${projectId}`) ?? 'all');
  const [mode, setModeState] = useState<Mode>(() => (localStorage.getItem('labcanvas.mode') === 'list' ? 'list' : 'canvas'));
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<FileKind[]>([]);
  const [nested, setNestedState] = useState(() => localStorage.getItem('labcanvas.nested') === '1');
  const [hits, setHits] = useState<{ query: string; found: Map<string, string> } | null>(null);
  const [selectedIds, setSelection] = useState<string[]>([]);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  /** Entry ids currently dragged from the canvas or list, used to highlight drop targets. */
  const [dragging, setDragging] = useState<string[] | null>(null);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const requestId = useRef(0);
  const lastSnapshot = useRef('');
  /** Canvas positions requested for entries that are about to appear (file drops). */
  const placementHints = useRef(new Map<string, { x: number; y: number }>());
  /** Entry ids in the order the current view presents them, for stepping through entries in the viewer. */
  const order = useRef<string[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const filePick = useRef<((files: File[]) => void) | null>(null);

  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    const list = await api<Project[]>('/projects');
    if (request !== requestId.current) return;
    setProjects(current => (JSON.stringify(current) === JSON.stringify(list) ? current : list));
    let id = projectRef.current;
    if (!list.some(project => project.id === id)) {
      if (id) setSelection([]);
      id = list[0]?.id ?? '';
      projectRef.current = id;
      setProjectId(id);
      localStorage.setItem('labcanvas.project', id);
      setViewState(localStorage.getItem(`labcanvas.view.${id}`) ?? 'all');
    }
    if (!id) {
      lastSnapshot.current = '';
      setSnapshot(null);
      setConnectionError('');
      return;
    }
    const text = await apiText(`/projects/${id}/snapshot`);
    if (request !== requestId.current) return;
    setConnectionError('');
    // Most reloads follow a change that did not touch this project; keep the current objects then.
    if (text === lastSnapshot.current) return;
    lastSnapshot.current = text;
    const data = JSON.parse(text) as Snapshot;
    setSnapshot(data);
    setViewState(current =>
      current.startsWith('collection:') && !data.collections.some(c => c.id === current.slice(11)) ? 'all' : current
    );
    const alive = new Set([...data.entries, ...data.trash].map(entry => entry.id));
    setSelection(current => (current.every(entryId => alive.has(entryId)) ? current : current.filter(entryId => alive.has(entryId))));
  }, []);

  useEffect(() => {
    refresh().catch(error => setConnectionError(error.message));
    // The server announces every change, including imports made by the command line tool.
    const events = new EventSource('/api/events');
    let timer = 0;
    events.addEventListener('change', () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => refresh().catch(() => {}), 120);
    });
    events.onopen = () => refresh().catch(() => {});
    events.onerror = () => setConnectionError('与本机服务的连接已断开');
    return () => { events.close(); clearTimeout(timer); };
  }, [refresh]);

  /** Runs a mutation, reloads, and reports failures in one place. */
  const act = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    try {
      const result = await work();
      await refresh();
      return result;
    } catch (error) {
      overlay.toast((error as Error).message, { error: true });
      await refresh().catch(() => {});
      return undefined;
    }
  }, [overlay, refresh]);

  const setView = useCallback((next: ViewKey) => {
    setViewState(next);
    setSelection([]);
    setViewer(null);
    localStorage.setItem(`labcanvas.view.${projectRef.current}`, next);
  }, []);

  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    localStorage.setItem('labcanvas.mode', next);
  }, []);

  const setNested = useCallback((next: boolean) => {
    setNestedState(next);
    localStorage.setItem('labcanvas.nested', next ? '1' : '0');
  }, []);

  const selectProject = useCallback((id: string) => {
    projectRef.current = id;
    setProjectId(id);
    localStorage.setItem('labcanvas.project', id);
    lastSnapshot.current = '';
    setSnapshot(null);
    setSelection([]);
    setViewer(null);
    setQuery('');
    setKinds([]);
    setViewState(localStorage.getItem(`labcanvas.view.${id}`) ?? 'all');
    refresh().catch(error => setConnectionError(error.message));
  }, [refresh]);

  const p = `/projects/${projectId}`;
  const collectionId = view.startsWith('collection:') ? view.slice(11) : null;

  // File contents are searched by the server; titles and the like match at once in the window.
  useEffect(() => {
    const text = query.trim();
    if (!text || !projectId) return setHits(null);
    let active = true;
    const timer = window.setTimeout(() => {
      api<SearchHit[]>(`/projects/${projectId}/search?q=${encodeURIComponent(text)}`)
        .then(list => { if (active) setHits({ query: text, found: new Map(list.map(hit => [hit.entry_id, hit.snippet])) }); })
        .catch(() => {});
    }, 140);
    return () => { active = false; clearTimeout(timer); };
  }, [query, projectId, snapshot]);

  const collectionNames = useMemo(() => new Map((snapshot?.collections ?? []).map(c => [c.id, c.path])), [snapshot?.collections]);

  /** Collections whose entries the current view shows: the selected one and, when asked, those nested in it. */
  const scope = useMemo(() => {
    if (!collectionId) return null;
    return nested ? descendants(snapshot?.collections ?? [], collectionId) : new Set([collectionId]);
  }, [collectionId, nested, snapshot?.collections]);

  const { entries, elsewhere } = useMemo(() => {
    if (!snapshot) return { entries: [] as Entry[], elsewhere: 0 };
    const found = hits && hits.query === query.trim() ? hits.found : null;
    const matches = (entry: Entry) =>
      (!kinds.length || entry.files.some(file => kinds.includes(file.kind))) &&
      (matchesQuery(entry, query, collectionNames) || !!found?.has(entry.id));
    const inView = (entry: Entry) =>
      view === 'unfiled' ? entry.collection_ids.length === 0 : !scope || entry.collection_ids.some(id => scope.has(id));
    if (view === 'trash') return { entries: snapshot.trash.filter(matches), elsewhere: 0 };
    const all = snapshot.entries.filter(matches);
    const shown = all.filter(inView);
    return { entries: shown, elsewhere: query.trim() || kinds.length ? all.length - shown.length : 0 };
  }, [snapshot, view, scope, query, kinds, hits, collectionNames]);

  const visibleIds = useMemo(() => new Set(entries.map(entry => entry.id)), [entries]);
  const selection = useMemo(() => selectedIds.filter(id => visibleIds.has(id)), [selectedIds, visibleIds]);
  useEffect(() => {
    setSelection(ids => ids.every(id => visibleIds.has(id)) ? ids : ids.filter(id => visibleIds.has(id)));
  }, [visibleIds]);

  const entryById = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const entry of [...(snapshot?.entries ?? []), ...(snapshot?.trash ?? [])]) map.set(entry.id, entry);
    return map;
  }, [snapshot]);

  const fileById = useMemo(() => {
    const map = new Map<string, LabFile>();
    for (const entry of entryById.values()) for (const file of entry.files) map.set(file.id, file);
    return map;
  }, [entryById]);

  /** Files whose source has gained a version since they were last matched against it. */
  const staleFiles = useMemo(() => {
    const stale = new Set<string>();
    for (const file of fileById.values()) {
      const source = file.source_file_id ? fileById.get(file.source_file_id) : undefined;
      if (source && file.source_version != null && source.version > file.source_version) stale.add(file.id);
    }
    return stale;
  }, [fileById]);

  /** Excerpt of the file content that made an entry match the current search, if that is why it matched. */
  const snippetOf = useCallback((entry: Entry) => {
    if (!hits || hits.query !== query.trim() || matchesQuery(entry, query, collectionNames)) return '';
    return hits.found.get(entry.id) ?? '';
  }, [hits, query, collectionNames]);

  const pickFiles = useCallback((multiple = true) => new Promise<File[]>(resolve => {
    const input = fileInput.current!;
    input.multiple = multiple;
    input.value = '';
    filePick.current = resolve;
    input.click();
  }), []);

  useEffect(() => {
    const input = fileInput.current;
    const cancel = () => {
      filePick.current?.([]);
      filePick.current = null;
    };
    input?.addEventListener('cancel', cancel);
    return () => input?.removeEventListener('cancel', cancel);
  }, []);

  const actions = useMemo(() => {
    /** Uploads with a visible progress bar. */
    const transfer = async <T,>(url: string, files: File[], meta?: unknown) => {
      const label = files.length === 1 ? `正在添加「${files[0].name}」` : `正在添加 ${files.length} 个文件`;
      setProgress({ label, fraction: 0 });
      try {
        return await upload<T>(url, files, meta, fraction => setProgress({ label, fraction }));
      } finally {
        setProgress(null);
      }
    };
    const reportDuplicates = (files: ImportedFile[]) => {
      const twins = files.filter(file => file.duplicate_of);
      if (!twins.length) return;
      const first = twins[0].duplicate_of!;
      overlay.toast(
        twins.length === 1 ? `「${twins[0].name}」与条目「${first.title}」中的文件内容相同` : `${twins.length} 个文件与已有条目中的文件内容相同`,
        { action: { label: '查看已有条目', run: () => { setQuery(''); setKinds([]); setView('all'); setSelection([first.entry_id]); } } }
      );
    };
    const importFiles = async (files: File[], options: { mode: 'single' | 'separate'; title?: string; position?: { x: number; y: number }; collectionId: string | null }) => {
      const created = await act(async () => {
        const result = await transfer<CreatedEntries>(`${p}/entries`, files, {
          mode: options.mode,
          title: options.title || undefined,
          collections: options.collectionId ? [options.collectionId] : []
        });
        result.entries.forEach((entry, index) => {
          if (options.position) placementHints.current.set(entry.id, { x: options.position.x + index * 28, y: options.position.y + index * 28 });
        });
        return result;
      });
      if (!created) return;
      setSelection(created.entries.map(entry => entry.id));
      reportDuplicates(created.entries.flatMap(entry => entry.files));
    };
    /** Entry point for every way of bringing files in: one file is imported directly, several ask how to group. */
    const canUpload = (files: File[]) => {
      if (!files.length) return false;
      if (files.length > MAX_IMPORT_FILES) {
        overlay.toast(`一次最多添加 ${MAX_IMPORT_FILES} 个文件`, { error: true });
        return false;
      }
      const tooLarge = files.find(file => file.size > 200 * 1024 * 1024);
      if (tooLarge) {
        overlay.toast(`「${tooLarge.name}」超过 200 MB，无法添加`, { error: true });
        return false;
      }
      return true;
    };
    const receiveFiles = (files: File[], position?: { x: number; y: number }, destination = collectionId) => {
      if (!canUpload(files)) return;
      if (files.length === 1) void importFiles(files, { mode: 'single', position, collectionId: destination });
      else setDialog({ type: 'import', files, position, collectionId: destination });
    };
    const setMembers = (entryIds: string[], id: string, member: boolean) =>
      act(() => send('POST', `${p}/memberships`, { entry_ids: entryIds, collection_id: id, member }));
    return {
      async createProject() {
        const name = await overlay.prompt({ title: '新建项目', label: '项目名称', placeholder: '例如 AgentFS', confirmLabel: '创建' });
        if (!name) return;
        const project = await act(() => send<Project>('POST', '/projects', { name }));
        if (project) selectProject(project.id);
      },
      async renameProject(project: Project) {
        const name = await overlay.prompt({ title: '重命名项目', value: project.name });
        if (name && name !== project.name) await act(() => send('PATCH', `/projects/${project.id}`, { name }));
      },
      async deleteProject(project: Project) {
        // An empty project can go after a plain confirmation; one with data asks for its name.
        const ok = project.entry_count === 0 && !snapshot?.trash.length
          ? await overlay.confirm({ title: `删除项目「${project.name}」？`, message: '项目中没有条目。', confirmLabel: '删除项目', danger: true })
          : await overlay.prompt({
            title: `删除项目「${project.name}」？`,
            message: `项目中的 ${project.entry_count} 个条目、回收站、全部文件和分类将被永久删除，无法恢复。建议先备份资料库。`,
            label: `输入项目名称「${project.name}」以确认`,
            confirmLabel: '删除项目',
            danger: true,
            require: project.name
          });
        if (ok) await act(() => send('DELETE', `/projects/${project.id}`));
      },

      async createCollection(parent?: Collection) {
        const name = await overlay.prompt({ title: parent ? `在「${parent.name}」下新建分类` : '新建分类', label: '名称', confirmLabel: '创建' });
        if (name) await act(() => send('POST', `${p}/collections`, { name, parent_id: parent?.id ?? null }));
      },
      renameCollection: (collection: Collection, name: string) => act(() => send('PATCH', `/collections/${collection.id}`, { name })),
      /** Moves a collection under `parentId`, in front of `beforeId` or to the end. */
      moveCollection: (id: string, parentId: string | null, beforeId: string | null = null) =>
        act(() => send('PATCH', `/collections/${id}`, { parent_id: parentId, before_id: beforeId })),
      sortCollections: () => act(() => send('POST', `${p}/collections/sort`)),
      async deleteCollection(collection: Collection) {
        const ok = await overlay.confirm({
          title: `删除分类「${collection.name}」？`,
          message: '分类及其子分类会被删除。其中的条目不会被删除，仍保留在项目和其他分类中。',
          confirmLabel: '删除分类',
          danger: true
        });
        if (ok) await act(() => send('DELETE', `/collections/${collection.id}`));
      },

      async addToCollection(entryIds: string[], collection: Collection) {
        if (await setMembers(entryIds, collection.id, true)) overlay.toast(`已加入「${collection.name}」`);
      },
      /** Drops the reference only: the entries stay in the project and in their other collections. */
      async removeFromCollection(entryIds: string[], id: string) {
        if (!entryIds.length || !(await setMembers(entryIds, id, false))) return;
        if (collectionId === id) setSelection([]);
        overlay.toast(entryIds.length > 1 ? `已将 ${entryIds.length} 个条目从分类中移除` : '已从分类中移除', {
          action: { label: '撤销', run: () => void setMembers(entryIds, id, true) }
        });
      },

      async trash(entryIds: string[]) {
        if (!entryIds.length) return;
        const done = await act(() => send('POST', `${p}/trash`, { entry_ids: entryIds }));
        if (!done) return;
        setSelection([]);
        overlay.toast(`已将 ${entryIds.length} 个条目移到回收站`, {
          action: { label: '撤销', run: () => void act(() => send('POST', `${p}/restore`, { entry_ids: entryIds })) }
        });
      },
      restore: (entryIds: string[]) => act(() => send('POST', `${p}/restore`, { entry_ids: entryIds })),
      async purge(entryIds: string[]) {
        const ok = await overlay.confirm({
          title: `永久删除 ${entryIds.length} 个条目？`,
          message: '条目及其文件会从资料库中彻底删除，并从所有分类中消失。此操作无法撤销。',
          confirmLabel: '永久删除',
          danger: true
        });
        if (ok) await act(() => send('POST', `${p}/purge`, { entry_ids: entryIds }));
      },
      async emptyTrash() {
        const ok = await overlay.confirm({ title: '清空回收站？', message: '回收站中的条目及其文件会被彻底删除。此操作无法撤销。', confirmLabel: '清空回收站', danger: true });
        if (ok) await act(() => send('POST', `${p}/empty-trash`));
      },
      async merge(entryIds: string[]) {
        const merged = await act(() => send<Entry>('POST', `${p}/merge`, { entry_ids: entryIds }));
        if (merged) setSelection([merged.id]);
      },

      updateEntry: (id: string, patch: Partial<Pick<Entry, 'title' | 'note' | 'date'>>) => act(() => send('PATCH', `/entries/${id}`, patch)),
      /** The same change for several entries, e.g. one date for a whole batch. */
      updateEntries: (entryIds: string[], patch: Partial<Pick<Entry, 'date'>> & { fields?: Record<string, string | null> }) =>
        act(() => send('PATCH', `${p}/entries`, { entry_ids: entryIds, patch })),
      /** Sets properties; a null value removes one. */
      setFields: (id: string, fields: Record<string, string | null>) => act(() => send('PATCH', `/entries/${id}`, { fields })),
      async renameField(entry: Entry, field: Field, name: string) {
        if (entry.fields.some(other => other.name === name)) return overlay.toast(`已有属性「${name}」`, { error: true });
        await act(() => send('PATCH', `/entries/${entry.id}`, { fields: { [field.name]: null, [name]: field.value } }));
      },
      importFiles,
      receiveFiles,
      async chooseAndImport() {
        receiveFiles(await pickFiles());
      },
      async addFilesToEntry(entryId: string, files: File[]) {
        if (!canUpload(files)) return;
        const result = await act(() => transfer<{ files: ImportedFile[] }>(`/entries/${entryId}/files`, files));
        if (result) reportDuplicates(result.files);
      },
      createTable: (title: string, rows: number, columns: number) =>
        act(() => send<{ id: string }>('POST', `${p}/tables`, { title, rows, columns, collections: collectionId ? [collectionId] : [] })),

      async renameFile(file: LabFile) {
        const name = await overlay.prompt({ title: '重命名文件', value: file.name });
        if (name && name !== file.name) await act(() => send('PATCH', `/files/${file.id}`, { name }));
      },
      setSource: (file: LabFile, sourceId: string | null) => act(() => send('PATCH', `/files/${file.id}`, { source_file_id: sourceId })),
      /** The figure has been checked against the newer source and still holds. */
      confirmSource: (file: LabFile) => act(() => send('PATCH', `/files/${file.id}`, { source_checked: true })),
      moveFile: (file: LabFile, position: number) => act(() => send('PATCH', `/files/${file.id}`, { position })),
      splitFile: (file: LabFile) => act(() => send('POST', `/files/${file.id}/split`)),
      async deleteFile(file: LabFile) {
        const ok = await overlay.confirm({ title: `删除文件「${file.name}」？`, message: '文件及其历史版本会被永久删除。', confirmLabel: '删除文件', danger: true });
        if (ok) await act(() => send('DELETE', `/files/${file.id}`));
      },
      async replaceFile(file: LabFile) {
        const [picked] = await pickFiles(false);
        if (picked) await act(() => transfer(`/files/${file.id}/replace`, [picked]));
      },

      /** Downloads the files of the given entries as one archive. */
      exportEntries(entryIds: string[]) {
        if (!entryIds.length) return;
        const size = entryIds.reduce((sum, id) => sum + (entryById.get(id)?.files.reduce((n, file) => n + file.size, 0) ?? 0), 0);
        if (size > 3.9 * 1024 ** 3) return overlay.toast('导出内容超过 3.9 GB，请分批导出', { error: true });
        window.location.href = `/api${p}/export?entries=${entryIds.join(',')}`;
      },
      async backup() {
        const info = await api<{ home: string; backup_suggestion: string }>('/info').catch(() => null);
        const target = await overlay.prompt({
          title: '备份资料库',
          message: '将数据库、全部文件和缩略图复制到一个新文件夹。恢复时把 LABCANVAS_HOME 指向该文件夹。',
          label: '备份到（新文件夹的路径）',
          value: info?.backup_suggestion ?? '',
          confirmLabel: '备份'
        });
        if (!target) return;
        setProgress({ label: '正在备份资料库', fraction: -1 });
        try {
          const result = await send<{ backup: string }>('POST', '/backup', { target });
          overlay.toast(`已备份到 ${result.backup}`);
        } catch (error) {
          overlay.toast((error as Error).message, { error: true });
        } finally {
          setProgress(null);
        }
      }
    };
  }, [act, overlay, p, collectionId, pickFiles, selectProject, setView, entryById, snapshot?.trash.length]);

  const open = useCallback((entryId: string, fileId?: string) => setViewer({ entryId, fileId }), []);

  const fileInputElement = (
    <input
      ref={fileInput}
      type="file"
      hidden
      onChange={event => {
        filePick.current?.(Array.from(event.target.files ?? []));
        filePick.current = null;
      }}
    />
  );

  return {
    projects, projectId, snapshot, view, setView, mode, setMode, query, setQuery, kinds, setKinds, nested, setNested,
    selection, setSelection, viewer, setViewer, open, dialog, setDialog, connectionError, progress, dragging, setDragging,
    entries, elsewhere, entryById, fileById, staleFiles, snippetOf, collectionId, refresh, act, actions, pickFiles,
    placementHints, order, selectProject, fileInputElement
  };
}

export type Lab = ReturnType<typeof useLabState>;
const LabContext = createContext<Lab | null>(null);

export function LabProvider({ children }: { children: ReactNode }) {
  const lab = useLabState();
  return <LabContext.Provider value={lab}>{children}{lab.fileInputElement}</LabContext.Provider>;
}

export function useLab() {
  const lab = useContext(LabContext);
  if (!lab) throw new Error('LabProvider is missing');
  return lab;
}
