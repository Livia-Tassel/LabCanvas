import type { Collection, Entry, FileKind } from './types';

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(value: string) {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const kindLabel: Record<FileKind, string> = { table: '表格', image: '图片', text: '文本', pdf: 'PDF', file: '其他文件' };
export const KINDS: FileKind[] = ['table', 'image', 'pdf', 'text', 'file'];

export function columnName(index: number) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** True when every word of the query occurs in the entry's own text. File contents are searched by the server. */
export function matchesQuery(entry: Entry, query: string, collectionNames?: Map<string, string>) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = [
    entry.title, entry.note, entry.date, entry.key ?? '',
    ...entry.files.map(file => file.name),
    ...entry.fields.map(field => `${field.name}: ${field.value}`),
    ...entry.collection_ids.map(id => collectionNames?.get(id) ?? '')
  ].join('\n').toLowerCase();
  return terms.every(term => text.includes(term));
}

export type CollectionNode = Collection & { children: CollectionNode[]; depth: number };

/** Collections arrive in their stored order, which the user arranges by hand. */
export function buildTree(collections: Collection[]): CollectionNode[] {
  const nodes = new Map<string, CollectionNode>(collections.map(c => [c.id, { ...c, children: [], depth: 0 }]));
  const roots: CollectionNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const level = (list: CollectionNode[], depth: number) => {
    for (const node of list) {
      node.depth = depth;
      level(node.children, depth + 1);
    }
  };
  level(roots, 0);
  return roots;
}

export function flattenTree(nodes: CollectionNode[], collapsed?: Set<string>): CollectionNode[] {
  const out: CollectionNode[] = [];
  const walk = (list: CollectionNode[]) => {
    for (const node of list) {
      out.push(node);
      if (!collapsed?.has(node.id)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** A collection together with everything nested under it. */
export function descendants(collections: Collection[], id: string) {
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const collection of collections) {
      if (collection.parent_id && ids.has(collection.parent_id) && !ids.has(collection.id)) {
        ids.add(collection.id);
        grew = true;
      }
    }
  }
  return ids;
}

export const isMac = navigator.platform.toLowerCase().includes('mac');
export const modKey = (event: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? event.metaKey : event.ctrlKey);
/** Shortcut text for menus and tooltips, e.g. shortcut('F') is ⌘F or Ctrl+F. */
export const shortcut = (key: string, shift = false) => (isMac ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`);

export const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return !!element?.tagName && (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable);
};

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (ok: (file: File) => void, fail: (error: unknown) => void) => void;
  createReader: () => { readEntries: (ok: (entries: FsEntry[]) => void, fail: (error: unknown) => void) => void };
};

export const MAX_IMPORT_FILES = 200;

/**
 * Files of a drop, including those inside dropped folders. Must be called during the drop event;
 * the returned promise resolves once the folders have been read.
 */
export function droppedFiles(transfer: DataTransfer): Promise<File[]> {
  const roots = Array.from(transfer.items ?? [])
    .map(item => (item.kind === 'file' ? (item as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() : null))
    .filter((entry): entry is FsEntry => !!entry);
  const plain = Array.from(transfer.files);
  if (!roots.some(entry => entry.isDirectory)) return Promise.resolve(plain);
  const files: File[] = [];
  const walk = async (entry: FsEntry): Promise<void> => {
    if (files.length > MAX_IMPORT_FILES || entry.name.startsWith('.')) return;
    if (entry.isFile) {
      files.push(await new Promise<File>((resolve, reject) => entry.file(resolve, reject)));
      return;
    }
    const reader = entry.createReader();
    // Read one past the limit, so the import can reject an oversize folder as a whole.
    while (files.length <= MAX_IMPORT_FILES) {
      const batch = await new Promise<FsEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))) await walk(child);
    }
  };
  return (async () => {
    for (const root of roots) await walk(root).catch(() => {});
    return files;
  })();
}

export function shortId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('');
}
