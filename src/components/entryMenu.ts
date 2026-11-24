import { useCallback } from 'react';
import { useLab } from '../state';
import { useOverlay } from './ui';
import type { MenuItem } from './ui';
import { isMac } from '../util';

/** Builds the context menu for the current selection; shared by the canvas and the list. */
export function useEntryMenu() {
  const lab = useLab();
  const overlay = useOverlay();
  return useCallback((at: { x: number; y: number }, ids: string[], extra: MenuItem[] = []) => {
    const { actions, view, collectionId, snapshot } = lab;
    if (!ids.length) return;
    const single = ids.length === 1 ? lab.entryById.get(ids[0]) : undefined;
    let items: MenuItem[];
    if (view === 'trash') {
      items = [
        { label: '恢复', onSelect: () => void actions.restore(ids) },
        'separator',
        { label: '永久删除…', danger: true, onSelect: () => void actions.purge(ids) }
      ];
    } else {
      const collection = snapshot?.collections.find(c => c.id === collectionId);
      // Removing from the collection shown only makes sense for entries filed directly in it.
      const direct = collection ? ids.filter(id => lab.entryById.get(id)?.collection_ids.includes(collection.id)) : [];
      const pair = ids.length === 2 ? ids.map(id => lab.entryById.get(id)) : [];
      const comparable = pair.length === 2 && pair[0] && pair[1]
        ? pair[1].files.find(file => file.kind === pair[0]!.files[0]?.kind && ['image', 'table', 'text', 'pdf'].includes(file.kind))
        : undefined;
      items = [
        { label: '打开', shortcut: '↩', disabled: !single, onSelect: () => single && lab.open(single.id) },
        {
          label: '重命名…',
          disabled: !single,
          onSelect: async () => {
            if (!single) return;
            const title = await overlay.prompt({ title: '重命名条目', value: single.title });
            if (title && title !== single.title) void actions.updateEntry(single.id, { title });
          }
        },
        ...(comparable ? [{ label: '并排对比', onSelect: () => lab.setViewer({ entryId: pair[0]!.id, compare: { fileId: comparable.id } }) } as MenuItem] : []),
        'separator',
        { label: '加入分类…', onSelect: () => lab.setDialog({ type: 'collections', entryIds: ids }) },
        ...(collection && direct.length
          ? [{ label: `从「${collection.name}」移除`, shortcut: '⌫', onSelect: () => void actions.removeFromCollection(direct, collection.id) } as MenuItem]
          : []),
        { label: '合并为一个条目', disabled: ids.length < 2, onSelect: () => void actions.merge(ids) },
        ...extra,
        'separator',
        { label: ids.length > 1 ? `导出 ${ids.length} 个条目…` : '导出…', onSelect: () => actions.exportEntries(ids) },
        'separator',
        { label: '移到回收站', shortcut: collection ? (isMac ? '⇧⌫' : 'Shift+Del') : '⌫', danger: true, onSelect: () => void actions.trash(ids) }
      ];
    }
    overlay.menu(at, items);
  }, [lab, overlay]);
}
