import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { api, send } from '../api';
import { useOverlay } from '../components/ui';
import { Mascot } from '../components/Art';
import { clamp, formatBytes, modKey, shortcut } from '../util';
import { FindBar, diffLines, findIsFor, useScrollSync } from './shared';
import type { ViewProps } from './shared';

type TextData = { content: string; truncated: boolean; tail: boolean; size: number; version: number };

/** Line height and padding of the editor, in pixels. The style sheet uses the same values. */
const LINE = 20;
const PAD = 12;
const MATCH_LIMIT = 20000;

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index of the last item that is not greater than the value, in a sorted list. */
function lastAtMost(sorted: number[], value: number) {
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (sorted[middle] <= value) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function TextView({ file, version: pinned, readOnly: locked = false, onDirtyChange, against, side, group, primary = false }: ViewProps) {
  const overlay = useOverlay();
  const root = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const measurer = useRef<CanvasRenderingContext2D | null>(null);
  const [data, setData] = useState<TextData | null>(null);
  const [draft, setDraft] = useState('');
  const [tail, setTail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [scroll, setScroll] = useState({ top: 0, left: 0, height: 600 });
  const [find, setFind] = useState<{ term: string; index: number } | null>(null);
  /** Text of the file shown beside this one, for marking the lines that differ. */
  const [otherText, setOtherText] = useState<string | null>(null);
  const dirty = data !== null && draft !== data.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const editable = !locked && pinned === undefined && !!data && !data.truncated;

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useScrollSync(area, group, data !== null);

  useEffect(() => {
    if (dirtyRef.current) return;
    let active = true;
    const query = [pinned ? `version=${pinned}` : '', tail ? 'tail=1' : ''].filter(Boolean).join('&');
    api<TextData>(`/files/${file.id}/text${query ? `?${query}` : ''}`).then(result => {
      if (!active) return;
      setData(result);
      setDraft(result.content);
      // The end of a log is what is looked at first.
      if (result.tail) requestAnimationFrame(() => { if (area.current) area.current.scrollTop = area.current.scrollHeight; });
    }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [file.id, file.version, pinned, tail]);

  useEffect(() => {
    if (!against || against.file.kind !== 'text') return setOtherText(null);
    let active = true;
    api<TextData>(`/files/${against.file.id}/text${against.version ? `?version=${against.version}` : ''}`)
      .then(result => { if (active) setOtherText(result.content); })
      .catch(() => { if (active) setOtherText(null); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [against?.file.id, against?.file.version, against?.version]);

  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    const update = () => setScroll({ top: element.scrollTop, left: element.scrollLeft, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [data === null]);

  /** Offset at which each line begins. */
  const lineStarts = useMemo(() => {
    const starts = [0];
    for (let i = draft.indexOf('\n'); i !== -1; i = draft.indexOf('\n', i + 1)) starts.push(i + 1);
    return starts;
  }, [draft]);
  const lineCount = lineStarts.length;

  /** Lines without a counterpart on the other side of a comparison. */
  const changed = useMemo(() => {
    if (otherText === null) return null;
    const mine = draft.split('\n');
    const theirs = otherText.split('\n');
    const flags = side === 'new' ? diffLines(theirs, mine).right : diffLines(mine, theirs).left;
    const lines: number[] = [];
    flags.forEach((flag, line) => { if (flag) lines.push(line); });
    return { flags, lines };
  }, [draft, otherText, side]);

  const term = find?.term ?? '';
  const matches = useMemo(() => {
    const list: number[] = [];
    if (!term) return list;
    const pattern = new RegExp(escapePattern(term), 'gi');
    for (let match = pattern.exec(draft); match && list.length < MATCH_LIMIT; match = pattern.exec(draft)) list.push(match.index);
    return list;
  }, [term, draft]);

  const measure = useCallback((text: string) => {
    if (!measurer.current && area.current) {
      const context = document.createElement('canvas').getContext('2d');
      if (context) context.font = getComputedStyle(area.current).font;
      measurer.current = context;
    }
    return measurer.current ? measurer.current.measureText(text).width : text.length * 7.5;
  }, []);

  /** Horizontal position of a column in a line, in pixels from the start of the text. */
  const offsetOf = (line: string, column: number) => {
    const tab = measure(' ') * 4;
    let x = 0;
    line.slice(0, column).split('\t').forEach((part, index) => {
      if (index > 0) x = (Math.floor(x / tab + 1e-6) + 1) * tab;
      x += measure(part);
    });
    return x;
  };

  const lineText = (line: number) => draft.slice(lineStarts[line], line + 1 < lineCount ? lineStarts[line + 1] - 1 : undefined);

  const revealLine = (line: number, x = 0) => {
    const element = area.current;
    if (!element) return;
    const top = PAD + line * LINE;
    if (top < element.scrollTop + LINE || top > element.scrollTop + element.clientHeight - 2 * LINE) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2);
    }
    if (x < element.scrollLeft || x > element.scrollLeft + element.clientWidth - 80) element.scrollLeft = Math.max(0, x - 80);
    if (group) group.driver = element;
  };

  const goToMatch = (index: number) => {
    const start = matches[index];
    if (start === undefined) return;
    setFind(current => (current ? { ...current, index } : current));
    const line = lastAtMost(lineStarts, start);
    revealLine(line, offsetOf(lineText(line), start - lineStarts[line]));
    // The selection is where typing continues once the search field is closed.
    area.current?.setSelectionRange(start, start + term.length);
  };
  const stepMatch = (delta: 1 | -1) => {
    if (matches.length) goToMatch(((find?.index ?? 0) + delta + matches.length) % matches.length);
  };
  useEffect(() => {
    if (!find || find.index >= 0 || !matches.length) return;
    // Start from the first match at or after the top of what is visible.
    const from = lineStarts[clamp(Math.floor((scroll.top - PAD) / LINE), 0, lineCount - 1)];
    const next = matches.findIndex(start => start >= from);
    goToMatch(next < 0 ? 0 : next);
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
    area.current?.focus({ preventScroll: true });
  };

  const stepChange = (delta: 1 | -1) => {
    if (!changed?.lines.length) return;
    const current = Math.floor((scroll.top + scroll.height / 2 - PAD) / LINE);
    // Changes come in runs of lines; move to the start of the next or previous run.
    const starts = changed.lines.filter((line, index) => index === 0 || changed.lines[index - 1] !== line - 1);
    const target = delta > 0 ? starts.find(line => line > current) ?? starts[0] : [...starts].reverse().find(line => line < current - 1) ?? starts[starts.length - 1];
    const element = area.current;
    if (element) {
      element.scrollTop = Math.max(0, PAD + target * LINE - element.clientHeight / 2 + LINE);
      if (group) group.driver = element;
    }
  };

  const save = async () => {
    if (!data || !dirty || saving || !editable) return;
    setSaving(true);
    try {
      const result = await send<{ version: number }>('PUT', `/files/${file.id}/text`, { content: draft, expected_version: data.version });
      setData({ ...data, content: draft, version: result.version });
    } catch (failure) {
      overlay.toast((failure as Error).message, { error: true });
    } finally {
      setSaving(false);
    }
  };

  const live = useRef({ openFind });
  live.current = { openFind };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !modKey(event) || event.key.toLowerCase() !== 'f') return;
      if (document.querySelector('.overlay-backdrop') || !findIsFor(root.current, primary)) return;
      event.preventDefault();
      live.current.openFind();
    };
    const onCommand = (event: Event) => {
      if ((event as CustomEvent<string>).detail === 'find' && findIsFor(root.current, primary)) live.current.openFind();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('labcanvas:viewer', onCommand);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('labcanvas:viewer', onCommand);
    };
  }, [primary]);

  if (error) return <div className="viewer-message"><Mascot mood="oops" /><span>{error}</span></div>;
  if (!data) return <div className="viewer-message"><Mascot mood="bubbling" size={76} /><span>正在载入…</span></div>;
  const status = data.truncated
    ? `文件共 ${formatBytes(data.size)}，显示${data.tail ? '末尾' : '开头'} 2 MB，不可编辑`
    : `${lineCount} 行${!editable ? ' · 只读' : ''}`;

  const firstLine = clamp(Math.floor((scroll.top - PAD) / LINE), 0, lineCount - 1);
  const lastLine = clamp(Math.ceil((scroll.top + scroll.height - PAD) / LINE), 0, lineCount - 1);
  // The end of a large file is shown without knowing how many lines came before it.
  const numbered = !data.tail;
  const numbers = [];
  if (numbered) for (let line = firstLine; line <= lastLine; line++) numbers.push(line + 1);

  const marks = [];
  if (changed) {
    for (let line = firstLine; line <= lastLine; line++) {
      if (changed.flags[line]) marks.push(<div key={`d${line}`} className={`text-mark ${side === 'new' ? 'added' : 'removed'}`} style={{ top: PAD + line * LINE - scroll.top }} />);
    }
  }
  if (term && matches.length) {
    const end = lastLine + 1 < lineCount ? lineStarts[lastLine + 1] : draft.length + 1;
    let index = matches.findIndex(start => start >= lineStarts[firstLine]);
    for (; index >= 0 && index < matches.length && matches[index] < end; index++) {
      const start = matches[index];
      const line = lastAtMost(lineStarts, start);
      const text = lineText(line);
      const column = start - lineStarts[line];
      marks.push(
        <div
          key={`m${start}`}
          className={`text-mark match${index === find?.index ? ' current' : ''}`}
          style={{ top: PAD + line * LINE - scroll.top, left: PAD + offsetOf(text, column) - scroll.left, width: Math.max(4, measure(text.slice(column, column + term.length))) }}
        />
      );
    }
  }

  return (
    <div ref={root} className="text-view">
      {find && (
        <FindBar
          term={find.term}
          count={matches.length}
          index={Math.max(0, find.index)}
          capped={matches.length >= MATCH_LIMIT}
          inputRef={findInput}
          onTerm={next => setFind({ term: next, index: -1 })}
          onStep={stepMatch}
          onClose={closeFind}
        />
      )}
      <div className="text-area">
        {numbered && (
          <div className="text-gutter" aria-hidden style={{ width: `calc(${String(lineCount).length}ch + 22px)` }}>
            <pre style={{ transform: `translateY(${PAD + firstLine * LINE - scroll.top}px)` }}>{numbers.join('\n')}</pre>
          </div>
        )}
        <div className="text-stack">
          <textarea
            ref={area}
            className="text-editor"
            aria-label={file.name}
            spellCheck={false}
            wrap="off"
            readOnly={!editable}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onScroll={event => setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft, height: event.currentTarget.clientHeight })}
            onKeyDown={event => {
              if (modKey(event) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
              else if (modKey(event) && event.key.toLowerCase() === 'g' && find) { event.preventDefault(); stepMatch(event.shiftKey ? -1 : 1); }
            }}
          />
          <div className="text-marks" aria-hidden>{marks}</div>
        </div>
      </div>
      <div className="table-status">
        <span className="status-detail" title={status}>{status}</span>
        {data.truncated && (
          <div className="sheet-tabs" role="group" aria-label="显示的部分">
            <button className={!tail ? 'active' : undefined} onClick={() => setTail(false)}>开头</button>
            <button className={tail ? 'active' : undefined} onClick={() => setTail(true)}>末尾</button>
          </div>
        )}
        {changed && (
          <span className="status-group">
            <span className={changed.lines.length ? 'differs' : undefined}>{changed.lines.length ? `${changed.lines.length} 行不同` : '内容相同'}</span>
            {changed.lines.length > 0 && (
              <>
                <button className="icon-button small" aria-label="上一处不同" title="上一处不同" onClick={() => stepChange(-1)}><ChevronUp size={13} /></button>
                <button className="icon-button small" aria-label="下一处不同" title="下一处不同" onClick={() => stepChange(1)}><ChevronDown size={13} /></button>
              </>
            )}
          </span>
        )}
        {dirty && <span className="unsaved">有未保存的修改</span>}
        <span className="spacer" />
        <button className={`icon-button small${find ? ' active' : ''}`} aria-label="查找" title={`查找（${shortcut('F')}）`} onClick={() => (find ? closeFind() : openFind())}><Search size={13} /></button>
        {dirty && <button className="button small" onClick={() => setDraft(data.content)}>还原</button>}
        {editable && <button className="button small primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? '正在保存…' : '保存'}</button>}
      </div>
    </div>
  );
}
