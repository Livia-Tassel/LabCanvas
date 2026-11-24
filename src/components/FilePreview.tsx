import { memo, useEffect, useState } from 'react';
import { File as FileIcon, FileSpreadsheet, FileText, FileType, Image as ImageIcon } from 'lucide-react';
import { rawUrl, thumbnailUrl } from '../api';
import { pdfThumbnail } from '../pdf';
import { formatBytes } from '../util';
import type { FileKind, LabFile } from '../types';

export function KindIcon({ kind, size = 14 }: { kind: FileKind; size?: number }) {
  const Icon = { table: FileSpreadsheet, image: ImageIcon, text: FileText, pdf: FileType, file: FileIcon }[kind];
  return <Icon size={size} strokeWidth={1.6} className={`kind-icon kind-${kind}`} />;
}

export function fileMeta(file: LabFile) {
  const { preview } = file;
  if (file.kind === 'table' && preview.totalRows != null) return `${preview.totalRows} 行 × ${preview.totalColumns} 列`;
  if (file.kind === 'image' && preview.width) return `${preview.width} × ${preview.height}`;
  return formatBytes(file.size);
}

const isNumeric = (text: string) => text !== '' && !Number.isNaN(Number(text.replace(/[%,]/g, '')));

function TablePreview({ file }: { file: LabFile }) {
  const rows = file.preview.rows ?? [];
  if (!rows.length) return <div className="preview-empty">空表格</div>;
  return (
    <div className="preview-table">
      <table>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className={r === 0 ? 'head' : undefined}>
              {row.map((cell, c) => (
                <td key={c} className={r > 0 && isNumeric(cell) ? 'num' : undefined}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PdfPreview({ file }: { file: LabFile }) {
  const [image, setImage] = useState('');
  useEffect(() => {
    let active = true;
    pdfThumbnail(rawUrl(file), file.sha256).then(url => { if (active) setImage(url); }).catch(() => {});
    return () => { active = false; };
  }, [file.id, file.sha256, file.version]);
  return (
    <div className="preview-pdf">
      {image ? <img className="preview-image" src={image} alt="" draggable={false} /> : <Generic file={file} />}
    </div>
  );
}

function Generic({ file }: { file: LabFile }) {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toUpperCase() : '';
  return (
    <div className="preview-generic">
      <KindIcon kind={file.kind} size={26} />
      <span>{ext || '文件'}</span>
    </div>
  );
}

/** Shows what a file actually contains, small enough to sit on a canvas card. */
export const FilePreview = memo(function FilePreview({ file }: { file: LabFile }) {
  const { preview } = file;
  if (preview.error) return <Generic file={file} />;
  if (file.kind === 'table') return <TablePreview file={file} />;
  if (file.kind === 'image' && preview.image) {
    return (
      <img
        className="preview-image"
        src={thumbnailUrl(file)}
        alt=""
        draggable={false}
        style={preview.width && preview.height ? { aspectRatio: `${preview.width} / ${preview.height}` } : undefined}
      />
    );
  }
  if (file.kind === 'text') return <pre className="preview-text">{preview.text || ' '}</pre>;
  if (file.kind === 'pdf') return <PdfPreview key={file.sha256} file={file} />;
  return <Generic file={file} />;
});
