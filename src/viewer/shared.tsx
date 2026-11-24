import { useEffect } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { LabFile } from '../types';

/** Scroll containers that move together: the two sides of a comparison. */
export type ScrollGroup = { members: Set<HTMLElement>; driver: HTMLElement | null };
export const createScrollGroup = (): ScrollGroup => ({ members: new Set(), driver: null });

/** Pan and zoom shared by two images shown side by side. */
export type ImageFrame = { x: number; y: number; zoom: number };
export type ImageLink = { view: ImageFrame | null; setView: (view: ImageFrame) => void };

export type ViewProps = {
  file: LabFile;
  /** An earlier version to show instead of the current one. It cannot be edited. */
  version?: number;
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  /** The file shown beside this one, whose differences are marked. */
  against?: { file: LabFile; version?: number };
  /** Which side of a comparison this is: the earlier or the later content. */
  side?: 'old' | 'new';
  group?: ScrollGroup;
  link?: ImageLink;
  /** The main pane takes the keyboard when the viewer opens. */
  primary?: boolean;
};

/**
 * Keeps the members of a group at the same scroll position. Only the pane the user is
 * working in leads, so a shorter document cannot pull a longer one back.
 */
export function useScrollSync(element: React.RefObject<HTMLElement | null>, group: ScrollGroup | undefined, ready: unknown = true) {
  useEffect(() => {
    const node = element.current;
    if (!node || !group) return;
    group.members.add(node);
    const lead = () => { group.driver = node; };
    const onScroll = () => {
      if (group.driver !== node) return;
      for (const other of group.members) {
        if (other === node) continue;
        if (Math.abs(other.scrollTop - node.scrollTop) > 1) other.scrollTop = node.scrollTop;
        if (Math.abs(other.scrollLeft - node.scrollLeft) > 1) other.scrollLeft = node.scrollLeft;
      }
    };
    const leading = ['wheel', 'pointerdown', 'keydown', 'focus', 'touchstart'] as const;
    for (const name of leading) node.addEventListener(name, lead, { passive: true });
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      group.members.delete(node);
      if (group.driver === node) group.driver = null;
      for (const name of leading) node.removeEventListener(name, lead);
      node.removeEventListener('scroll', onScroll);
    };
  }, [element, group, ready]);
}

/** The search field of the table and text viewers. */
export function FindBar({ term, count, index, capped, inputRef, onTerm, onStep, onClose }: {
  term: string;
  count: number;
  /** Position of the current match, starting at 0. */
  index: number;
  /** True when there are more matches than are listed. */
  capped?: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onTerm: (term: string) => void;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
}) {
  return (
    <div className="find-bar" role="search">
      <Search size={13} />
      <input
        ref={inputRef}
        autoFocus
        aria-label="查找"
        placeholder="查找"
        value={term}
        onChange={event => onTerm(event.target.value)}
        onFocus={event => event.target.select()}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); onStep(event.shiftKey ? -1 : 1); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        }}
      />
      <span className="find-count">{term ? (count ? `${index + 1} / ${count}${capped ? '+' : ''}` : '无结果') : ''}</span>
      <button className="icon-button small" aria-label="上一个结果" title="上一个（⇧↩）" disabled={!count} onClick={() => onStep(-1)}><ChevronUp size={13} /></button>
      <button className="icon-button small" aria-label="下一个结果" title="下一个（↩）" disabled={!count} onClick={() => onStep(1)}><ChevronDown size={13} /></button>
      <button className="icon-button small" aria-label="关闭查找" onClick={onClose}><X size={13} /></button>
    </div>
  );
}

/** True when a ⌘F pressed somewhere in the viewer is meant for the pane with this root element. */
export function findIsFor(root: HTMLElement | null, primary: boolean) {
  const active = document.activeElement;
  if (root && active && root.contains(active)) return true;
  return primary && !active?.closest?.('.table-view, .text-view');
}

/**
 * Marks the lines of each text that have no counterpart in the other,
 * by a longest common subsequence of whole lines.
 */
export function diffLines(a: string[], b: string[]) {
  const left = new Uint8Array(a.length);
  const right = new Uint8Array(b.length);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start;
  const m = endB - start;
  if (!n || !m) {
    left.fill(1, start, endA);
    right.fill(1, start, endB);
    return { left, right };
  }
  if (n * m > 4_000_000) {
    // Too much to align line by line: fall back to whether a line occurs on the other side at all.
    const inA = new Set(a.slice(start, endA));
    const inB = new Set(b.slice(start, endB));
    for (let i = start; i < endA; i++) if (!inB.has(a[i])) left[i] = 1;
    for (let j = start; j < endB; j++) if (!inA.has(b[j])) right[j] = 1;
    return { left, right };
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[start + i] === b[start + j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) { i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) left[start + i++] = 1;
    else right[start + j++] = 1;
  }
  while (i < n) left[start + i++] = 1;
  while (j < m) right[start + j++] = 1;
  return { left, right };
}
