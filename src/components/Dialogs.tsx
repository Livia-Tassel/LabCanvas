import { useEffect, useMemo, useState } from 'react';
import { api, send } from '../api';
import { useLab } from '../state';
import { Dialog, DialogActions } from './ui';
import { buildTree, flattenTree, formatBytes, isMac, shortcut } from '../util';

function HelpDialog({ onClose }: { onClose: () => void }) {
  const { snapshot, actions } = useLab();
  const [info, setInfo] = useState<{ home: string; version: string } | null>(null);
  const project = snapshot?.project.slug ?? 'PROJECT';
  useEffect(() => {
    api<{ home: string; version: string }>('/info').then(setInfo).catch(() => {});
  }, []);
  return (
    <Dialog title="终端与资料库" onClose={onClose} width={480}>
      <p className="dialog-message">终端命令与此窗口共用本机资料库，窗口会随命令的结果更新。若使用自定义目录，请在命令中指定相同的 <code>--home</code>。</p>
      <pre className="terminal-example">{[
        'labcanvas projects --json',
        `labcanvas add results.csv -p ${project} -c Baseline -f lr=3e-4 --json`,
        `labcanvas search "关键词" -p ${project} --json`,
        'labcanvas backup ~/labcanvas-backup'
      ].join('\n')}</pre>
      {info && (
        <dl className="info-list">
          <dt>资料库位置</dt><dd className="selectable">{info.home}</dd>
          <dt>版本</dt><dd className="selectable">{info.version}</dd>
        </dl>
      )}
      <DialogActions>
        <button className="button" onClick={() => { onClose(); void actions.backup(); }}>备份资料库…</button>
        <span className="spacer" />
        <button className="button primary" onClick={onClose}>关闭</button>
      </DialogActions>
    </Dialog>
  );
}

const alt = isMac ? '⌥' : 'Alt+';
const SHORTCUTS: { title: string; items: [string, string][] }[] = [
  {
    title: '通用',
    items: [
      [shortcut('F'), '搜索'],
      [shortcut('1'), '画布视图'],
      [shortcut('2'), '列表视图'],
      [shortcut('I'), '显示或隐藏详情面板'],
      [shortcut('A'), '全选'],
      [shortcut('V'), '粘贴剪贴板中的图片或文件为新条目'],
      ['↩', '打开选中的条目'],
      ['⌫', '从当前分类移除；不在分类中时移到回收站'],
      [isMac ? '⇧⌫' : 'Shift+Del', '移到回收站'],
      ['Esc', '取消选择'],
      ['?', '显示此列表']
    ]
  },
  {
    title: '画布',
    items: [
      ['← ↑ ↓ →', '选择相邻的卡片'],
      ['空格 + 拖动', '平移'],
      [`${isMac ? '⌘' : 'Ctrl+'}滚轮`, '缩放'],
      [`${isMac ? '⇧' : 'Shift+'}拖动`, '框选'],
      [shortcut('0'), '缩放以显示全部'],
      [`${shortcut('+')}　${shortcut('-')}`, '放大、缩小'],
      [shortcut('Z'), '撤销移动、调整和标注'],
      [shortcut('Z', true), '重做'],
      ['N', '添加便签'],
      ['G', '添加分组框，圈起选中的卡片']
    ]
  },
  {
    title: '列表',
    items: [
      ['↑ ↓', '上一个、下一个条目'],
      [`${isMac ? '⇧' : 'Shift+'}↑ ↓`, '扩展选择'],
      ['Home　End', '第一个、最后一个条目']
    ]
  },
  {
    title: '查看器',
    items: [
      ['← →', '上一个、下一个条目'],
      [`${alt}← →`, '在表格中切换条目'],
      [shortcut('F'), '在表格或文本中查找'],
      [shortcut('S'), '保存'],
      [shortcut('Z'), '撤销表格编辑'],
      [shortcut('Z', true), '重做'],
      [`${shortcut('+')}　${shortcut('-')}　${shortcut('0')}`, '缩放图片或 PDF'],
      ['Esc', '返回']
    ]
  }
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="键盘快捷键" onClose={onClose} width={640} className="shortcut-dialog">
      <div className="shortcut-groups" role="region" aria-label="快捷键列表" tabIndex={0}>
        {SHORTCUTS.map(group => (
          <section key={group.title}>
            <h2>{group.title}</h2>
            <dl>
              {group.items.map(([keys, label]) => (
                <div key={label} className="shortcut-row"><dt>{label}</dt><dd>{keys}</dd></div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <DialogActions>
        <button className="button primary" onClick={onClose}>关闭</button>
      </DialogActions>
    </Dialog>
  );
}

function NewTableDialog({ onClose }: { onClose: () => void }) {
  const lab = useLab();
  const [title, setTitle] = useState('');
  const [rows, setRows] = useState(12);
  const [columns, setColumns] = useState(5);
  const valid = title.trim() && rows >= 1 && rows <= 1000 && columns >= 1 && columns <= 100;
  return (
    <Dialog title="新建表格" onClose={onClose} width={360}>
      <form onSubmit={async event => {
        event.preventDefault();
        if (!valid) return;
        onClose();
        const created = await lab.actions.createTable(title.trim(), rows, columns);
        if (created) lab.open(created.id);
      }}>
        <label className="field"><span>标题</span><input className="input" autoFocus value={title} onChange={event => setTitle(event.target.value)} /></label>
        <div className="field-row">
          <label className="field"><span>行</span><input className="input" type="number" min={1} max={1000} value={rows} onChange={event => setRows(Number(event.target.value))} /></label>
          <label className="field"><span>列</span><input className="input" type="number" min={1} max={100} value={columns} onChange={event => setColumns(Number(event.target.value))} /></label>
        </div>
        <DialogActions>
          <button type="button" className="button" onClick={onClose}>取消</button>
          <button type="submit" className="button primary" disabled={!valid}>创建</button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function ImportDialog({ files, position, collectionId, onClose }: { files: File[]; position?: { x: number; y: number }; collectionId: string | null; onClose: () => void }) {
  const lab = useLab();
  const [mode, setMode] = useState<'single' | 'separate'>('single');
  const [title, setTitle] = useState('');
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return (
    <Dialog title={`添加 ${files.length} 个文件`} onClose={onClose} width={420}>
      <form onSubmit={event => {
        event.preventDefault();
        onClose();
        void lab.actions.importFiles(files, { mode, title: mode === 'single' ? title.trim() : undefined, position, collectionId });
      }}>
        <ul className="file-list">
          {files.map((file, index) => <li key={index}><span>{file.name}</span><span>{formatBytes(file.size)}</span></li>)}
        </ul>
        <div className="file-list-total">共 {formatBytes(total)}</div>
        <label className="radio">
          <input type="radio" checked={mode === 'single'} onChange={() => setMode('single')} />
          <span>组合为一个条目<small>例如一张数据表和由它生成的图</small></span>
        </label>
        <label className="radio">
          <input type="radio" checked={mode === 'separate'} onChange={() => setMode('separate')} />
          <span>每个文件各自成为一个条目</span>
        </label>
        {mode === 'single' && (
          <label className="field"><span>标题</span><input className="input" autoFocus value={title} placeholder="留空则使用文件名" onChange={event => setTitle(event.target.value)} /></label>
        )}
        <DialogActions>
          <button type="button" className="button" onClick={onClose}>取消</button>
          <button type="submit" className="button primary">添加</button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Check boxes for every collection; a box is mixed when only some of the selected entries are members. */
function CollectionsDialog({ entryIds, onClose }: { entryIds: string[]; onClose: () => void }) {
  const lab = useLab();
  const collections = lab.snapshot?.collections ?? [];
  const rows = useMemo(() => flattenTree(buildTree(collections)), [collections]);
  const entries = entryIds.map(id => lab.entryById.get(id)).filter(entry => entry !== undefined);
  const initial = useMemo(() => {
    const state = new Map<string, boolean | 'mixed'>();
    for (const collection of collections) {
      const count = entries.filter(entry => entry.collection_ids.includes(collection.id)).length;
      state.set(collection.id, count === 0 ? false : count === entries.length ? true : 'mixed');
    }
    return state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [state, setState] = useState(initial);
  const [newPath, setNewPath] = useState('');
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter(node => node.path.toLowerCase().includes(needle)) : rows;

  const apply = async () => {
    onClose();
    await lab.act(async () => {
      const url = `/projects/${lab.projectId}/memberships`;
      for (const [id, value] of state) {
        if (value === initial.get(id) || value === 'mixed') continue;
        await send('POST', url, { entry_ids: entryIds, collection_id: id, member: value });
      }
      if (newPath.trim()) await send('POST', url, { entry_ids: entryIds, collection_id: newPath.trim(), member: true });
    });
  };

  return (
    <Dialog title={entries.length === 1 ? `「${entries[0].title}」的分类` : `${entries.length} 个条目的分类`} onClose={onClose} width={380}>
      {rows.length > 12 && (
        <input className="input check-filter" aria-label="筛选分类" placeholder="筛选分类" value={filter} onChange={event => setFilter(event.target.value)} />
      )}
      <div className="check-tree">
        {shown.map(node => {
          const value = state.get(node.id);
          return (
            <label key={node.id} className="check-row" title={node.path} style={{ paddingLeft: 6 + (needle ? 0 : Math.min(node.depth, 8) * 16) }}>
              <input
                type="checkbox"
                checked={value === true}
                ref={element => { if (element) element.indeterminate = value === 'mixed'; }}
                onChange={event => setState(new Map(state).set(node.id, event.target.checked))}
              />
              <span>{needle ? node.path.split('/').join(' / ') : node.name}</span>
            </label>
          );
        })}
        {rows.length === 0 && <div className="check-empty">尚无分类</div>}
        {rows.length > 0 && shown.length === 0 && <div className="check-empty">没有匹配的分类</div>}
      </div>
      <label className="field">
        <span>新分类</span>
        <input className="input" value={newPath} placeholder="名称，或用 / 表示层级，如 实验目的/Baseline" onChange={event => setNewPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void apply(); }} />
      </label>
      <DialogActions>
        <button className="button" onClick={onClose}>取消</button>
        <button className="button primary" onClick={() => void apply()}>完成</button>
      </DialogActions>
    </Dialog>
  );
}

export function Dialogs() {
  const { dialog, setDialog } = useLab();
  const close = () => setDialog(null);
  if (!dialog) return null;
  if (dialog.type === 'help') return <HelpDialog onClose={close} />;
  if (dialog.type === 'shortcuts') return <ShortcutsDialog onClose={close} />;
  if (dialog.type === 'newTable') return <NewTableDialog onClose={close} />;
  if (dialog.type === 'import') return <ImportDialog files={dialog.files} position={dialog.position} collectionId={dialog.collectionId} onClose={close} />;
  return <CollectionsDialog entryIds={dialog.entryIds} onClose={close} />;
}
