import { useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, Plus, TriangleAlert, X } from 'lucide-react';
import { rawUrl } from '../api';
import { useLab } from '../state';
import { useOverlay } from './ui';
import { Mascot } from './Art';
import { KindIcon, fileMeta } from './FilePreview';
import { formatDateTime } from '../util';
import type { Entry, LabFile } from '../types';

/** A text field that keeps local edits and commits them on blur or Enter. */
function CommitField({ value, onCommit, multiline, className, ariaLabel, placeholder, list }: {
  value: string; onCommit: (value: string) => void; multiline?: boolean; className: string; ariaLabel: string; placeholder?: string; list?: string;
}) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft !== value) onCommit(draft);
  };
  const cancel = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    event.stopPropagation();
    cancelled.current = true;
    setDraft(value);
    event.currentTarget.blur();
  };
  const shared = {
    className,
    value: draft,
    placeholder,
    'aria-label': ariaLabel,
    onBlur: commit,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value)
  };
  if (multiline) return <textarea {...shared} rows={4} onKeyDown={event => { if (event.key === 'Escape') cancel(event); }} />;
  return (
    <input
      {...shared}
      list={list}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') cancel(event);
      }}
    />
  );
}

/** A date field that saves once a whole date has been entered, not on every keystroke. */
function DateField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (next: string) => { if (next && next !== value) onCommit(next); };
  return (
    <input
      className="property-input"
      type="date"
      aria-label="实验日期"
      value={draft}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => { if (draft) commit(draft); else setDraft(value); }}
      onKeyDown={event => {
        if (event.key === 'Enter') commit(draft);
        if (event.key === 'Escape') { event.stopPropagation(); setDraft(value); }
      }}
    />
  );
}

function FileRow({ file, entry }: { file: LabFile; entry: Entry }) {
  const lab = useLab();
  const overlay = useOverlay();
  const { actions } = lab;
  const source = file.source_file_id ? lab.fileById.get(file.source_file_id) : undefined;
  const stale = lab.staleFiles.has(file.id);
  const tables = entry.files.filter(other => other.kind === 'table' && other.id !== file.id);
  const index = entry.files.findIndex(other => other.id === file.id);
  const menu = (at: HTMLElement | { x: number; y: number }) => overlay.menu(at, [
    { label: '打开', onSelect: () => lab.open(entry.id, file.id) },
    { label: '重命名…', onSelect: () => void actions.renameFile(file) },
    { label: '替换为新版本…', onSelect: () => void actions.replaceFile(file) },
    { label: '下载', onSelect: () => { window.location.href = rawUrl(file, true); } },
    ...(entry.files.length > 1 ? [
      'separator' as const,
      { label: '上移', disabled: index === 0, onSelect: () => void actions.moveFile(file, index - 1) },
      { label: '下移', disabled: index === entry.files.length - 1, onSelect: () => void actions.moveFile(file, index + 1) }
    ] : []),
    ...(tables.length || source ? ['separator' as const] : []),
    ...tables.map(table => ({
      label: `来源：${table.name}`,
      checked: file.source_file_id === table.id,
      onSelect: () => void actions.setSource(file, file.source_file_id === table.id ? null : table.id)
    })),
    ...(stale ? [{ label: '已核对，仍与来源一致', onSelect: () => void actions.confirmSource(file) }] : []),
    ...(source && !tables.some(table => table.id === source.id) ? [{ label: '清除来源', onSelect: () => void actions.setSource(file, null) }] : []),
    'separator',
    { label: '拆分为独立条目', disabled: entry.files.length < 2, onSelect: () => void actions.splitFile(file) },
    { label: '删除文件…', danger: true, disabled: entry.files.length < 2, onSelect: () => void actions.deleteFile(file) }
  ]);
  return (
    <li
      className="file-row"
      onDoubleClick={() => lab.open(entry.id, file.id)}
      onContextMenu={event => { event.preventDefault(); menu({ x: event.clientX, y: event.clientY }); }}
    >
      <KindIcon kind={file.kind} />
      <div className="file-row-text">
        <button className="file-row-name" title={file.name} onClick={() => lab.open(entry.id, file.id)}>{file.name}</button>
        <span className="file-row-meta">
          {fileMeta(file)}{file.version > 1 && ` · 第 ${file.version} 版`}{source && ` · 来自 ${source.name}`}
        </span>
        {stale && source && (
          <span className="file-row-stale">
            <TriangleAlert size={11} />
            <span title={`生成此文件时来源为第 ${file.source_version} 版，现为第 ${source.version} 版`}>来源已更新到第 {source.version} 版，此文件可能已过期</span>
          </span>
        )}
      </div>
      <button className="icon-button small" aria-label={`${file.name} 的操作`} onClick={event => menu(event.currentTarget)}><MoreHorizontal size={14} /></button>
    </li>
  );
}

/** Properties such as experiment parameters: free-form name and value pairs. */
function Fields({ entry }: { entry: Entry }) {
  const lab = useLab();
  const { actions } = lab;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);
  /** Names used elsewhere in the project, offered as suggestions so the same parameter keeps one spelling. */
  const known = useMemo(() => {
    const names = new Set<string>();
    for (const other of lab.snapshot?.entries ?? []) for (const field of other.fields) names.add(field.name);
    for (const field of entry.fields) names.delete(field.name);
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [lab.snapshot?.entries, entry.fields]);

  const close = () => { setAdding(false); setName(''); setValue(''); };
  /** Saves the pair being typed, if it is complete. */
  const store = () => {
    const key = name.trim();
    if (!key || !value.trim()) return false;
    void actions.setFields(entry.id, { [key]: value.trim() });
    return true;
  };
  /** Enter saves and leaves the row ready for the next property. */
  const submit = () => {
    if (!name.trim()) return nameInput.current?.focus();
    if (!value.trim()) return valueInput.current?.focus();
    store();
    setName('');
    setValue('');
    nameInput.current?.focus();
  };

  return (
    <section className="inspector-section">
      <div className="section-heading">
        <span>属性</span>
        <button className="icon-button small" aria-label="添加属性" title="添加属性，例如实验参数" onClick={() => setAdding(true)}><Plus size={14} /></button>
      </div>
      {entry.fields.length === 0 && !adding && <div className="section-empty">无。可记录模型、学习率等实验参数，用于搜索和列表排序。</div>}
      <datalist id="field-names">{known.map(item => <option key={item} value={item} />)}</datalist>
      {entry.fields.map(field => (
        <div key={field.name} className="field-pair">
          <CommitField
            className="field-name"
            ariaLabel={`属性名 ${field.name}`}
            value={field.name}
            onCommit={next => { if (next.trim()) void actions.renameField(entry, field, next.trim()); }}
          />
          <CommitField
            className="field-value"
            ariaLabel={`${field.name} 的值`}
            value={field.value}
            onCommit={next => void actions.setFields(entry.id, { [field.name]: next.trim() || null })}
          />
          <button className="icon-button small" aria-label={`删除属性 ${field.name}`} title="删除属性" onClick={() => void actions.setFields(entry.id, { [field.name]: null })}><X size={12} /></button>
        </div>
      ))}
      {adding && (
        <form
          className="field-pair adding"
          onSubmit={event => { event.preventDefault(); submit(); }}
          // Leaving the row keeps a finished pair and drops an unfinished one.
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { store(); close(); } }}
          onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}
        >
          <input ref={nameInput} className="field-name" autoFocus list="field-names" aria-label="新属性名" placeholder="名称" maxLength={60} value={name} onChange={event => setName(event.target.value)} />
          <input ref={valueInput} className="field-value" aria-label="新属性值" placeholder="值" value={value} onChange={event => setValue(event.target.value)} />
          <button type="submit" hidden />
          <button type="button" className="icon-button small" aria-label="取消添加属性" onClick={close}><X size={12} /></button>
        </form>
      )}
    </section>
  );
}

function EntryDetails({ entry }: { entry: Entry }) {
  const lab = useLab();
  const { actions } = lab;
  const collections = (lab.snapshot?.collections ?? []).filter(collection => entry.collection_ids.includes(collection.id));
  return (
    <>
      <CommitField className="inspector-title" ariaLabel="标题" value={entry.title} onCommit={title => title.trim() && void actions.updateEntry(entry.id, { title: title.trim() })} />
      <section className="inspector-section">
        <div className="property">
          <span className="property-name">实验日期</span>
          <DateField value={entry.date} onCommit={date => void actions.updateEntry(entry.id, { date })} />
        </div>
        <div className="property top">
          <span className="property-name">分类</span>
          <div className="chips">
            {collections.map(collection => (
              <span key={collection.id} className="chip" title={collection.path}>
                <button className="chip-label" onClick={() => lab.setView(`collection:${collection.id}`)}>{collection.name}</button>
                <button className="chip-remove" aria-label={`从「${collection.name}」移除`} title="从该分类移除" onClick={() => void actions.removeFromCollection([entry.id], collection.id)}><X size={11} /></button>
              </span>
            ))}
            <button className="chip add" onClick={() => lab.setDialog({ type: 'collections', entryIds: [entry.id] })}><Plus size={12} />添加</button>
          </div>
        </div>
      </section>
      <Fields entry={entry} />
      <section className="inspector-section">
        <div className="section-heading">
          <span>文件</span>
          <button className="icon-button small" aria-label="添加文件到此条目" title="添加文件到此条目" onClick={async () => {
            const files = await lab.pickFiles();
            if (files.length) void actions.addFilesToEntry(entry.id, files);
          }}><Plus size={14} /></button>
        </div>
        <ul className="file-rows">{entry.files.map(file => <FileRow key={file.id} file={file} entry={entry} />)}</ul>
      </section>
      <section className="inspector-section">
        <div className="section-heading"><span>备注</span></div>
        <CommitField multiline className="inspector-note" ariaLabel="备注" value={entry.note} placeholder="实验条件、结论、待办…" onCommit={note => void actions.updateEntry(entry.id, { note })} />
      </section>
      <section className="inspector-section meta">
        <div className="property"><span className="property-name">添加时间</span><span>{formatDateTime(entry.created_at)}</span></div>
        <div className="property"><span className="property-name">修改时间</span><span>{formatDateTime(entry.updated_at)}</span></div>
        {entry.key && <div className="property"><span className="property-name">导入标识</span><span className="selectable">{entry.key}</span></div>}
        <div className="property"><span className="property-name">ID</span><span className="selectable mono">{entry.id}</span></div>
      </section>
    </>
  );
}

function MultiDetails({ entries }: { entries: Entry[] }) {
  const lab = useLab();
  const { actions, selection } = lab;
  const dates = new Set(entries.map(entry => entry.date));
  const shared = dates.size === 1 ? entries[0].date : '';
  // Only entries filed directly in the collection shown can be removed from it.
  const direct = lab.collectionId ? selection.filter(id => lab.entryById.get(id)?.collection_ids.includes(lab.collectionId!)) : [];
  return (
    <div className="inspector-multi">
      <div className="inspector-count">已选择 {entries.length} 个条目</div>
      <div className="property">
        <span className="property-name">实验日期</span>
        <DateField value={shared} onCommit={date => void actions.updateEntries(selection, { date })} />
        {!shared && <span className="muted">各不相同</span>}
      </div>
      <button className="button block" onClick={() => void actions.merge(selection)}>合并为一个条目</button>
      <button className="button block" onClick={() => lab.setDialog({ type: 'collections', entryIds: selection })}>加入分类…</button>
      {direct.length > 0 && <button className="button block" onClick={() => void actions.removeFromCollection(direct, lab.collectionId!)}>从当前分类移除</button>}
      <button className="button block" onClick={() => actions.exportEntries(selection)}>导出…</button>
      <button className="button block danger-text" onClick={() => void actions.trash(selection)}>移到回收站</button>
    </div>
  );
}

export function Inspector() {
  const lab = useLab();
  const { selection, actions, view } = lab;
  const entries = selection.map(id => lab.entryById.get(id)).filter(entry => entry !== undefined);
  let content;
  if (entries.length === 0) {
    content = <div className="inspector-empty"><Mascot mood="sleepy" size={84} /><span>未选择条目</span></div>;
  } else if (view === 'trash') {
    content = (
      <div className="inspector-multi">
        <div className="inspector-count">{entries.length === 1 ? entries[0].title : `已选择 ${entries.length} 个条目`}</div>
        <button className="button block" onClick={() => void actions.restore(selection)}>恢复</button>
        <button className="button block danger-text" onClick={() => void actions.purge(selection)}>永久删除…</button>
      </div>
    );
  } else if (entries.length === 1) {
    content = <EntryDetails key={entries[0].id} entry={entries[0]} />;
  } else {
    content = <MultiDetails entries={entries} />;
  }
  return <aside className="inspector" aria-label="详情">{content}</aside>;
}
