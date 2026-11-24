export type Project = { id: string; slug: string; name: string; created_at: string; entry_count: number };

export type Collection = {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  position: number;
  entry_count: number;
};

export type FileKind = 'table' | 'image' | 'text' | 'pdf' | 'file';

export type Preview = {
  rows?: string[][];
  totalRows?: number;
  totalColumns?: number;
  sheets?: number;
  image?: string;
  width?: number;
  height?: number;
  text?: string;
  error?: string;
};

export type LabFile = {
  id: string;
  entry_id: string;
  name: string;
  kind: FileKind;
  position: number;
  source_file_id: string | null;
  /** Version of the source this file was last known to match. */
  source_version: number | null;
  version: number;
  size: number;
  sha256: string;
  mime: string;
  preview: Preview;
  created_at: string;
  updated_at: string;
};

/** A free-form property of an entry, such as an experiment parameter. */
export type Field = { name: string; value: string };

export type Entry = {
  id: string;
  project_id: string;
  key: string | null;
  title: string;
  note: string;
  date: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  files: LabFile[];
  collection_ids: string[];
  fields: Field[];
};

export type Snapshot = { project: Project; collections: Collection[]; entries: Entry[]; trash: Entry[] };

export type Position = { entry_id: string; x: number; y: number; w: number };
export type Viewport = { x: number; y: number; zoom: number };
/** A text note or a frame drawn on the canvas of one view. */
export type Annotation = { id: string; kind: 'note' | 'frame'; x: number; y: number; w: number; h: number; text: string };
export type Layout = { view: string; positions: Position[]; annotations: Annotation[]; viewport: Viewport | null };
export type SearchHit = { entry_id: string; snippet: string };

export type TableData = {
  sheets: { name: string; rows: number; columns: number }[];
  sheet: number;
  offset: number;
  rows: string[][];
  formulas: Record<string, string>;
  totalRows: number;
  totalColumns: number;
  version: number;
};

export type TableOp =
  | { type: 'set'; sheet: number; row: number; column: number; value: string }
  | { type: 'insertRows' | 'deleteRows' | 'insertColumns' | 'deleteColumns'; sheet: number; at: number; count: number };

export type FileVersion = { number: number; size: number; sha256: string; created_at: string; current: boolean };

/** 'all' | 'unfiled' | 'trash' | `collection:${id}` */
export type ViewKey = string;
