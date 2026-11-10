import { File, FileText, FileSpreadsheet, Image as ImageIcon, FileWarning } from 'lucide-react';
import type { Item } from '../types';
import { bytes } from '../api';
export function KindIcon({ kind, size = 16 }: { kind: string; size?: number }) {
  const Icon = kind === 'table' ? FileSpreadsheet : kind === 'image' ? ImageIcon : kind === 'text' ? FileText : File;
  return <Icon size={size} className={`kind-icon kind-${kind}`} strokeWidth={1.6}/>;
}
export function Preview({ item }: { item: Item }) {
  const p = item.preview;
  if (p.status === 'failed') return <div className="file-preview"><FileWarning size={32}/><span>预览暂不可用</span><small>{item.original_name}</small></div>;
  if (item.kind === 'image' && p.image) return <div className="image-preview"><img src={`/api/items/${item.id}/preview?v=${item.current_version}`} alt={item.title} loading="lazy" draggable={false}/></div>;
  if (item.kind === 'table' && p.data?.length) return <div className="table-preview"><table><thead><tr><th></th>{p.data[0].map((_, c) => <th key={c}>{String.fromCharCode(65 + c)}</th>)}</tr></thead><tbody>{p.data.slice(0, 7).map((row, r) => <tr key={r} className={r === 0 ? 'first-row' : ''}><th>{r+1}</th>{row.map((v, c) => <td key={c} title={v}>{v}</td>)}</tr>)}</tbody></table></div>;
  if (item.kind === 'text') return <div className="text-preview"><pre>{p.text || '空文本'}</pre></div>;
  return <div className="file-preview"><KindIcon kind={item.kind} size={38}/><span>{item.original_name}</span><small>{bytes(item.size)}</small></div>;
}
