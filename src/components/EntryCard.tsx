import { memo } from 'react';
import { FilePreview, KindIcon, fileMeta } from './FilePreview';
import type { Entry } from '../types';

type Props = {
  entry: Entry;
  x: number;
  y: number;
  w: number;
  selected: boolean;
  placed: boolean;
  dropTarget: boolean;
  /** Ids of files whose source has changed since, joined by commas (a string keeps the card memoized). */
  stale: string;
};

export function defaultCardWidth(entry: Entry) {
  return entry.files.length <= 1 ? 340 : entry.files.length === 2 ? 660 : 980;
}

/**
 * A canvas card. An entry with several files shows all of them side by side,
 * so a table and the figures drawn from it read as one result.
 */
export const EntryCard = memo(function EntryCard({ entry, x, y, w, selected, placed, dropTarget, stale }: Props) {
  const multiple = entry.files.length > 1;
  const staleIds = stale ? stale.split(',') : [];
  return (
    <article
      className={`card${selected ? ' selected' : ''}${dropTarget ? ' drop-target' : ''}`}
      data-entry-id={entry.id}
      aria-label={entry.title}
      style={{ transform: `translate(${x}px, ${y}px)`, width: w, visibility: placed ? 'visible' : 'hidden' }}
    >
      <header className="card-header">
        <span className="card-title" title={entry.title}>{entry.title}</span>
        <span className="card-date">{entry.date}</span>
      </header>
      {entry.fields.length > 0 && (
        <div className="card-fields">
          {entry.fields.slice(0, 6).map(field => (
            <span key={field.name} className="card-field" title={`${field.name}: ${field.value}`}>
              <span className="card-field-name">{field.name}</span>{field.value}
            </span>
          ))}
          {entry.fields.length > 6 && <span className="card-field">+{entry.fields.length - 6}</span>}
        </div>
      )}
      <div className={`card-files${multiple ? ' multiple' : ''}`}>
        {entry.files.map(file => (
          <figure key={file.id} className="tile" data-file-id={file.id}>
            <div className={`tile-preview kind-${file.kind}`}>
              <FilePreview file={file} />
            </div>
            <figcaption>
              <KindIcon kind={file.kind} size={12} />
              <span className="tile-name" title={file.name}>{file.name}</span>
              {staleIds.includes(file.id)
                ? <span className="tile-stale" title="来源表格在此文件之后有了新版本，此文件可能已过期">来源已更新</span>
                : <span className="tile-meta">{fileMeta(file)}</span>}
            </figcaption>
          </figure>
        ))}
      </div>
      {entry.note && <p className="card-note">{entry.note}</p>}
      <div className="card-resize" data-resize aria-hidden />
    </article>
  );
});
