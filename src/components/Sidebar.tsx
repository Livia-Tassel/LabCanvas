import { useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsUpDown, CircleHelp, Folder, FolderOpen, Inbox, Library, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { useLab } from '../state';
import { useOverlay } from './ui';
import { buildTree, descendants, flattenTree } from '../util';
import type { CollectionNode } from '../util';

export const ENTRY_DRAG = 'application/x-labcanvas-entries';
const COLLECTION_DRAG = 'application/x-labcanvas-collection';

/** Where a dragged collection would land relative to the row under the pointer. */
type Drop = { id: string; where: 'before' | 'inside' | 'after' };

function loadCollapsed(projectId: string) {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(`labcanvas.collapsed.${projectId}`) ?? '[]'));
  } catch {
    return new Set<string>();
  }
}

export function Sidebar() {
  const lab = useLab();
  const overlay = useOverlay();
  const { snapshot, projects, view, setView, actions } = lab;
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(lab.projectId));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const draggedCollection = useRef<string | null>(null);
  const collapsedFor = useRef(lab.projectId);
  if (collapsedFor.current !== lab.projectId) {
    collapsedFor.current = lab.projectId;
    setCollapsed(loadCollapsed(lab.projectId));
  }

  const tree = useMemo(() => buildTree(snapshot?.collections ?? []), [snapshot?.collections]);
  const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);
  const siblingsOf = useMemo(() => {
    const map = new Map<string, CollectionNode[]>();
    const walk = (list: CollectionNode[]) => {
      for (const node of list) {
        map.set(node.id, list);
        walk(node.children);
      }
    };
    walk(tree);
    return map;
  }, [tree]);
  /** With nested entries shown, a collection counts everything filed anywhere under it. */
  const nestedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!lab.nested || !snapshot) return counts;
    for (const collection of snapshot.collections) {
      const ids = descendants(snapshot.collections, collection.id);
      if (ids.size > 1) counts.set(collection.id, snapshot.entries.filter(entry => entry.collection_ids.some(id => ids.has(id))).length);
    }
    return counts;
  }, [lab.nested, snapshot]);

  if (!snapshot || !projects) return <aside className="sidebar" />;
  const project = snapshot.project;

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
    localStorage.setItem(`labcanvas.collapsed.${lab.projectId}`, JSON.stringify([...next]));
  };

  const projectMenu = (event: React.MouseEvent<HTMLElement>) => overlay.menu(event.currentTarget, [
    ...projects.map(item => ({ label: item.name, checked: item.id === project.id, onSelect: () => lab.selectProject(item.id) })),
    'separator',
    { label: '新建项目…', onSelect: () => void actions.createProject() },
    { label: '重命名项目…', onSelect: () => void actions.renameProject(project) },
    { label: '删除项目…', danger: true, onSelect: () => void actions.deleteProject(project) }
  ]);

  const sectionMenu = (at: HTMLElement | { x: number; y: number }) => overlay.menu(at, [
    { label: '新建分类…', onSelect: () => void actions.createCollection() },
    'separator',
    { label: '显示子分类中的条目', checked: lab.nested, onSelect: () => lab.setNested(!lab.nested) },
    { label: '按名称排序', disabled: snapshot.collections.length < 2, onSelect: () => void actions.sortCollections() }
  ]);

  const collectionMenu = (event: React.MouseEvent, node: CollectionNode) => {
    event.preventDefault();
    event.stopPropagation();
    overlay.menu({ x: event.clientX, y: event.clientY }, [
      { label: '新建子分类…', onSelect: () => void actions.createCollection(node) },
      { label: '重命名', onSelect: () => setRenaming(node.id) },
      ...(node.parent_id ? [{ label: '移到顶层', onSelect: () => void actions.moveCollection(node.id, null) }] : []),
      'separator',
      { label: '显示子分类中的条目', checked: lab.nested, onSelect: () => lab.setNested(!lab.nested) },
      { label: `导出「${node.name}」中的条目…`, disabled: !(nestedCounts.get(node.id) ?? node.entry_count), onSelect: () => {
        const ids = lab.nested ? descendants(snapshot.collections, node.id) : new Set([node.id]);
        actions.exportEntries(snapshot.entries.filter(entry => entry.collection_ids.some(id => ids.has(id))).map(entry => entry.id));
      } },
      'separator',
      { label: '删除分类…', danger: true, onSelect: () => void actions.deleteCollection(node) }
    ]);
  };

  const isCollectionDrag = (event: React.DragEvent) => event.dataTransfer.types.includes(COLLECTION_DRAG);
  const isFileDrag = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');
  const onRowDragOver = (event: React.DragEvent, node: CollectionNode) => {
    if (event.dataTransfer.types.includes(ENTRY_DRAG) || (isFileDrag(event) && view !== 'trash' && !lab.dialog)) {
      event.preventDefault();
      return setDrop({ id: node.id, where: 'inside' });
    }
    if (!isCollectionDrag(event) || draggedCollection.current === node.id) return;
    event.preventDefault();
    // The upper and lower quarters of a row reorder; the middle nests.
    const box = event.currentTarget.getBoundingClientRect();
    const offset = (event.clientY - box.top) / box.height;
    setDrop({ id: node.id, where: offset < 0.28 ? 'before' : offset > 0.72 ? 'after' : 'inside' });
  };
  const onRowDrop = (event: React.DragEvent, node: CollectionNode) => {
    if (isFileDrag(event)) {
      setDrop(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const where = drop?.id === node.id ? drop.where : 'inside';
    setDrop(null);
    const moved = event.dataTransfer.getData(COLLECTION_DRAG);
    if (moved) {
      if (moved === node.id) return;
      if (where === 'inside') {
        if (collapsed.has(node.id)) toggle(node.id);
        return void actions.moveCollection(moved, node.id);
      }
      const siblings = (siblingsOf.get(node.id) ?? []).filter(item => item.id !== moved);
      const index = siblings.findIndex(item => item.id === node.id);
      const before = where === 'before' ? node.id : siblings[index + 1]?.id ?? null;
      return void actions.moveCollection(moved, node.parent_id, before);
    }
    const entryIds = event.dataTransfer.getData(ENTRY_DRAG);
    if (entryIds) void actions.addToCollection(JSON.parse(entryIds), node);
  };

  const unfiled = snapshot.entries.filter(entry => entry.collection_ids.length === 0).length;

  return (
    <aside className="sidebar" inert={!!lab.viewer}>
      <div className="sidebar-header">
        <button className="project-switch" onClick={projectMenu} title="切换项目">
          <span className="project-name">{project.name}</span>
          <ChevronsUpDown size={13} />
        </button>
      </div>
      <nav className="sidebar-scroll" aria-label="分类">
        <button className={`nav-row${view === 'all' ? ' active' : ''}`} aria-current={view === 'all' ? 'page' : undefined} onClick={() => setView('all')}>
          <span className="nav-indent" /><Library size={15} strokeWidth={1.7} />
          <span className="nav-label">全部条目</span><span className="nav-count">{snapshot.entries.length}</span>
        </button>
        <button className={`nav-row${view === 'unfiled' ? ' active' : ''}`} aria-current={view === 'unfiled' ? 'page' : undefined} onClick={() => setView('unfiled')}>
          <span className="nav-indent" /><Inbox size={15} strokeWidth={1.7} />
          <span className="nav-label">未分类</span><span className="nav-count">{unfiled || ''}</span>
        </button>

        <div
          className={`sidebar-section${drop?.id === 'root' ? ' drop' : ''}`}
          onContextMenu={event => { event.preventDefault(); sectionMenu({ x: event.clientX, y: event.clientY }); }}
          onDragOver={event => { if (isCollectionDrag(event)) { event.preventDefault(); setDrop({ id: 'root', where: 'inside' }); } }}
          onDragLeave={() => setDrop(null)}
          onDrop={event => {
            event.preventDefault();
            setDrop(null);
            const moved = event.dataTransfer.getData(COLLECTION_DRAG);
            if (moved) void actions.moveCollection(moved, null);
          }}
        >
          <span>分类</span>
          <span className="section-actions">
            <button className="icon-button small" aria-label="分类选项" title="分类选项" onClick={event => sectionMenu(event.currentTarget)}><MoreHorizontal size={14} /></button>
            <button className="icon-button small" aria-label="新建分类" title="新建分类" onClick={() => void actions.createCollection()}><Plus size={14} /></button>
          </span>
        </div>
        {rows.map(node => {
          const key = `collection:${node.id}`;
          const open = !collapsed.has(node.id);
          const FolderIcon = node.children.length && open ? FolderOpen : Folder;
          const target = drop?.id === node.id ? drop.where : null;
          return (
            <div
              key={node.id}
              role="button"
              tabIndex={0}
              aria-current={view === key ? 'page' : undefined}
              aria-expanded={node.children.length ? open : undefined}
              className={`nav-row${view === key ? ' active' : ''}${target === 'inside' ? ' drop' : ''}${target === 'before' ? ' drop-before' : ''}${target === 'after' ? ' drop-after' : ''}`}
              style={{ paddingLeft: 8 + Math.min(node.depth, 6) * 14 }}
              data-drop-collection={node.id}
              draggable={renaming !== node.id}
              onClick={() => setView(key)}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter') setView(key);
                else if (event.key === 'F2') setRenaming(node.id);
                else if (event.key === 'ArrowRight' && node.children.length && !open) toggle(node.id);
                else if (event.key === 'ArrowLeft' && node.children.length && open) toggle(node.id);
                else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const list = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLElement>('.nav-row'));
                  list[list.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
                }
              }}
              onDoubleClick={() => setRenaming(node.id)}
              onContextMenu={event => collectionMenu(event, node)}
              onDragStart={event => {
                draggedCollection.current = node.id;
                event.dataTransfer.setData(COLLECTION_DRAG, node.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => { draggedCollection.current = null; setDrop(null); }}
              onDragOver={event => onRowDragOver(event, node)}
              onDragLeave={() => setDrop(current => (current?.id === node.id ? null : current))}
              onDrop={event => onRowDrop(event, node)}
            >
              <span
                className="nav-indent disclosure"
                onClick={event => { event.stopPropagation(); if (node.children.length) toggle(node.id); }}
              >
                {node.children.length > 0 && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
              </span>
              <FolderIcon size={15} strokeWidth={1.7} />
              {renaming === node.id ? (
                <input
                  className="nav-rename"
                  autoFocus
                  aria-label="分类名称"
                  defaultValue={node.name}
                  onClick={event => event.stopPropagation()}
                  onDoubleClick={event => event.stopPropagation()}
                  onFocus={event => event.target.select()}
                  onBlur={event => {
                    const name = event.target.value.trim();
                    setRenaming(null);
                    if (name && name !== node.name) void actions.renameCollection(node, name);
                  }}
                  onKeyDown={event => {
                    event.stopPropagation();
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') { event.currentTarget.value = node.name; event.currentTarget.blur(); }
                  }}
                />
              ) : (
                <span className="nav-label" title={node.path}>{node.name}</span>
              )}
              <span className="nav-count">{(nestedCounts.get(node.id) ?? node.entry_count) || ''}</span>
            </div>
          );
        })}
        {rows.length === 0 && <div className="sidebar-hint">尚无分类</div>}
      </nav>
      <div className="sidebar-footer">
        <button className={`nav-row${view === 'trash' ? ' active' : ''}`} data-drop-trash onClick={() => setView('trash')}>
          <span className="nav-indent" /><Trash2 size={15} strokeWidth={1.7} />
          <span className="nav-label">回收站</span><span className="nav-count">{snapshot.trash.length || ''}</span>
        </button>
        <button
          className="icon-button"
          aria-label="帮助与资料库"
          title="帮助与资料库"
          onClick={event => overlay.menu(event.currentTarget, [
            { label: '键盘快捷键', onSelect: () => lab.setDialog({ type: 'shortcuts' }) },
            { label: '终端与资料库', onSelect: () => lab.setDialog({ type: 'help' }) },
            'separator',
            { label: '备份资料库…', onSelect: () => void actions.backup() }
          ])}
        >
          <CircleHelp size={15} />
        </button>
      </div>
    </aside>
  );
}
