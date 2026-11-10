import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Folder, FolderOpen, Layers3, Clock3, Terminal, Trash2, MoreHorizontal, Check, Settings2, FlaskConical } from 'lucide-react';
import type { Project, Collection } from '../types';
import { useLab } from '../context';
import { send } from '../api';
export function Sidebar({ projects, projectId, onProject }: { projects: Project[]; projectId: string; onProject: (id: string) => void }) {
  const lab = useLab(), { snapshot: s, view } = lab;
  const [projectMenu, setProjectMenu] = useState(false), [menu, setMenu] = useState<string|null>(null), [collapsed, setCollapsed] = useState<string[]>([]), [drop, setDrop] = useState<string|null>(null);
  const nav = (key: string) => { lab.setView(key); lab.setSelected([]); };
  const results = s.items.filter(i => i.role === 'result');
  const render = (parent: string|null, depth: number): React.ReactNode => s.collections.filter(c => c.parent_id === parent).map(c => {
    const children = s.collections.some(x => x.parent_id === c.id), active = view === `collection:${c.id}`;
    const count = results.filter(i => i.collectionIds.includes(c.id)).length;
    return <div key={c.id}>
      <div className={`collection-row ${active ? 'active' : ''} ${drop === c.id ? 'drop-target' : ''}`} style={{ paddingLeft: 11 + depth*15 }} data-collection-id={c.id}
        onDragOver={e => { e.preventDefault(); setDrop(c.id); }} onDragLeave={() => setDrop(null)} onDrop={e => { e.preventDefault(); setDrop(null); try { const ids = JSON.parse(e.dataTransfer.getData('application/labcanvas')); void lab.run(async () => { for (const target_id of ids) await send(`/projects/${projectId}/memberships`, 'PUT', { target_id, collection_id: c.id }); }, '已加入分类'); } catch { lab.notify('请拖入当前项目中的资料', true); } }}>
        <button className={`tree-toggle ${children ? '' : 'invisible'}`} aria-label={`${collapsed.includes(c.id) ? '展开' : '折叠'} ${c.name}`} onClick={() => setCollapsed(p => p.includes(c.id) ? p.filter(x => x !== c.id) : [...p,c.id])}>{collapsed.includes(c.id) ? <ChevronRight size={12}/> : <ChevronDown size={12}/>}</button>
        <button className="collection-main" aria-label={c.name} onClick={() => nav(`collection:${c.id}`)}>{active ? <FolderOpen size={16}/> : <Folder size={16}/>}<span>{c.name}</span><small>{count || ''}</small></button>
        <button className="row-more icon-button" aria-label={`${c.name} 操作`} onClick={() => setMenu(menu === c.id ? null : c.id)}><MoreHorizontal size={15}/></button>
        {menu === c.id && <><div className="menu-dismiss" onClick={() => setMenu(null)}/><div className="context-menu collection-menu"><button onClick={() => { lab.showModal({ type: 'collection', collection: c }); setMenu(null); }}><Plus size={14}/>新建子分类</button><button onClick={() => { lab.showModal({ type: 'editCollection', collection: c }); setMenu(null); }}>重命名</button><button className="danger" onClick={() => { lab.showModal({ type: 'deleteCollection', collection: c }); setMenu(null); }}>删除分类</button></div></>}
      </div>
      {!collapsed.includes(c.id) && render(c.id, depth + 1)}
    </div>;
  });
  return <aside className="sidebar">
    <div className="brand"><img src="/icon.svg" alt=""/><span>LabCanvas</span><span className="version-label">1.0</span></div>
    <div className="project-selector-wrap"><button className="project-selector" aria-label="切换项目" onClick={() => setProjectMenu(!projectMenu)}><span className="project-mark"><FlaskConical size={18}/></span><span>{s.project.name}{!!s.project.is_demo && <small>示例</small>}</span><ChevronDown size={15}/></button>
    {projectMenu && <><div className="menu-dismiss" onClick={() => setProjectMenu(false)}/><div className="context-menu project-menu"><div className="menu-caption">项目</div>{projects.map(p => <button key={p.id} onClick={() => { onProject(p.id); setProjectMenu(false); }}><Folder size={15}/><span>{p.name}</span>{p.id === projectId && <Check size={14}/>}</button>)}<div className="menu-divider"/><button onClick={() => { lab.showModal({ type: 'project' }); setProjectMenu(false); }}><Plus size={15}/>新建项目</button><button onClick={() => { lab.showModal({ type: 'editProject' }); setProjectMenu(false); }}><Settings2 size={15}/>项目设置</button></div></>}
    </div>
    <nav className="primary-nav">
      <button className={view === 'all' ? 'active' : ''} onClick={() => nav('all')}><Layers3 size={17}/><span>全部资料</span><small>{results.length}</small></button>
      <button className={view === 'recent' ? 'active' : ''} onClick={() => nav('recent')}><Clock3 size={17}/><span>最近导入</span></button>
      <button className={view === 'runs' ? 'active' : ''} onClick={() => nav('runs')}><Terminal size={17}/><span>运行记录</span><small>{s.runs.length || ''}</small></button>
    </nav>
    <div className="section-label"><span>分类</span><button className="icon-button" aria-label="新建分类" onClick={() => lab.showModal({ type: 'collection' })}><Plus size={15}/></button></div>
    <div className="collection-tree">{render(null, 0)}{!s.collections.length && <button className="empty-collection" onClick={() => lab.showModal({ type: 'collection' })}>新建分类</button>}</div>
    <div className="sidebar-bottom"><button className={view === 'trash' ? 'active' : ''} onClick={() => nav('trash')}><Trash2 size={16}/><span>回收站</span><small>{s.trash.length || ''}</small></button><button className="library-status" onClick={() => lab.showModal({ type: 'help' })}><span className="status-dot"/><span>本机资料库</span><Terminal size={14}/></button></div>
  </aside>;
}
export function collectionPaths(collections: Collection[], ids: string[]) { return collections.filter(c => ids.includes(c.id)).map(c => c.path); }
