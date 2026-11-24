import { linkSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { assert, AppError } from './errors.mjs';

export const MAX_FILE = 200 * 1024 * 1024;
const PREVIEW_ROWS = 14;
const PREVIEW_COLUMNS = 8;
/** How much of a file's text is kept for searching. */
export const SEARCH_TEXT = 200_000;

const tableExt = new Set(['.csv', '.tsv', '.xlsx']);
const imageExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.tif', '.tiff']);
const textExt = new Set([
  '.txt', '.md', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.py', '.sh', '.r', '.out', '.err', '.tex', '.xml', '.html', '.js', '.ts', '.c', '.cpp', '.h',
  '.rs', '.go', '.java', '.sql', '.ipynb'
]);
const mimes = {
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf'
};

export function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (tableExt.has(ext)) return 'table';
  if (imageExt.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (textExt.has(ext)) return 'text';
  return 'file';
}

export function mimeOf(name) {
  const ext = path.extname(name).toLowerCase();
  return mimes[ext] || (textExt.has(ext) ? 'text/plain' : 'application/octet-stream');
}

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().replace('T00:00:00.000Z', '');
  if (typeof value !== 'object') return String(value);
  if ('formula' in value || 'sharedFormula' in value) {
    return value.result == null ? `=${value.formula || value.sharedFormula}` : cellText(value.result);
  }
  if (value.richText) return value.richText.map(part => part.text).join('');
  return value.text ?? value.error ?? JSON.stringify(value);
}

function excelValue(value) {
  if (typeof value !== 'string') return value;
  if (value === '') return null;
  if (value.startsWith('=') && value.length > 1) return { formula: value.slice(1) };
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && !/^-?0\d/.test(value)) return Number(value);
  return value;
}

export async function readTable(filePath, name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    assert(workbook.worksheets.length > 0, '工作簿中没有工作表', 422, 'INVALID_TABLE');
    return {
      type: 'xlsx',
      workbook,
      sheets: workbook.worksheets.map(s => ({ name: s.name, rows: s.rowCount, columns: s.columnCount }))
    };
  }
  const content = await fs.readFile(filePath, 'utf8');
  const delimiter = ext === '.tsv' ? '\t' : ',';
  let rows;
  try {
    rows = parse(content, { delimiter, bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: false });
  } catch (error) {
    throw new AppError(`表格无法解析：${error.message}`, 422, 'INVALID_TABLE');
  }
  const columns = rows.reduce((n, row) => Math.max(n, row.length), 0);
  return {
    type: 'csv',
    rows,
    delimiter,
    bom: content.charCodeAt(0) === 0xfeff,
    sheets: [{ name: path.basename(name, ext), rows: rows.length, columns }]
  };
}

export function tableSlice(table, sheetIndex = 0, offset = 0, limit = 200) {
  const meta = table.sheets[sheetIndex];
  assert(meta, '工作表不存在', 404, 'NOT_FOUND');
  const worksheet = table.type === 'xlsx' ? table.workbook.worksheets[sheetIndex] : null;
  const data = [];
  const formulas = {};
  for (let r = offset; r < Math.min(meta.rows, offset + limit); r++) {
    const row = [];
    for (let c = 0; c < meta.columns; c++) {
      const value = worksheet ? worksheet.getCell(r + 1, c + 1).value : table.rows[r]?.[c];
      row.push(cellText(value));
      if (value && typeof value === 'object' && (value.formula || value.sharedFormula)) {
        formulas[`${r}:${c}`] = `=${value.formula || value.sharedFormula}`;
      }
    }
    data.push(row);
  }
  return { sheets: table.sheets, sheet: sheetIndex, offset, rows: data, formulas, totalRows: meta.rows, totalColumns: meta.columns };
}

function tablePreview(table) {
  const meta = table.sheets[0];
  const worksheet = table.type === 'xlsx' ? table.workbook.worksheets[0] : null;
  const rows = [];
  for (let r = 0; r < Math.min(meta.rows, PREVIEW_ROWS); r++) {
    const row = [];
    for (let c = 0; c < Math.min(meta.columns, PREVIEW_COLUMNS); c++) {
      const text = cellText(worksheet ? worksheet.getCell(r + 1, c + 1).value : table.rows[r]?.[c]);
      row.push(text.length > 40 ? `${text.slice(0, 40)}…` : text);
    }
    rows.push(row);
  }
  return { rows, totalRows: meta.rows, totalColumns: meta.columns, sheets: table.sheets.length };
}

/** Plain text of a table for the search index: cells separated by tabs, all sheets. */
function tableText(table) {
  const parts = [];
  let length = 0;
  const push = text => {
    if (!text) return true;
    parts.push(text);
    length += text.length + 1;
    return length < SEARCH_TEXT;
  };
  if (table.type === 'csv') {
    for (const row of table.rows) if (!push(row.join('\t'))) break;
  } else {
    outer: for (const sheet of table.workbook.worksheets) {
      if (!push(sheet.name)) break;
      for (let r = 1; r <= sheet.rowCount; r++) {
        const cells = [];
        sheet.getRow(r).eachCell(cell => cells.push(cellText(cell.value)));
        if (!push(cells.join('\t'))) break outer;
      }
    }
  }
  return parts.join('\n').slice(0, SEARCH_TEXT);
}

/** Searchable text of stored bytes; empty for kinds that have none. */
export async function extractText(objectPath, name) {
  const kind = kindOf(name);
  try {
    if (kind === 'table') return tableText(await readTable(objectPath, name));
    if (kind === 'text') {
      const handle = await fs.open(objectPath);
      try {
        const buffer = Buffer.alloc(SEARCH_TEXT * 3);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8').slice(0, SEARCH_TEXT);
      } finally {
        await handle.close();
      }
    }
  } catch { /* unreadable content is simply not searchable */ }
  return '';
}

async function stageBytes(home, buffer) {
  const temp = path.join(home, 'tmp', `asset-${randomUUID()}`);
  try {
    await fs.writeFile(temp, buffer, { flag: 'wx', mode: 0o600 });
    return temp;
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

/** Called with the database write lock, before committing metadata that references the bytes. */
export function publishStaged(home, { objectPath, objectKey, previewPath, preview }) {
  const link = (temp, directory, name) => {
    if (!temp) return;
    try {
      linkSync(temp, path.join(home, directory, name));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  };
  link(objectPath, 'objects', objectKey);
  link(previewPath, 'previews', preview.image);
}

export async function discardStaged(files) {
  await Promise.all(files.flatMap(file => [file.objectPath, file.previewPath]
    .filter(Boolean).map(temp => fs.unlink(temp).catch(() => {}))));
}

/** Prepares immutable bytes and a thumbnail before taking the database write lock. */
export async function stageBuffer(home, buffer, name) {
  assert(buffer.length <= MAX_FILE, '单个文件最大支持 200 MB', 413, 'FILE_TOO_LARGE');
  name = path.basename(name).slice(0, 255);
  assert(name.length > 0, '文件名不能为空');
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const objectKey = `${sha256}${ext}`;
  const objectPath = await stageBytes(home, buffer);
  const kind = kindOf(name);
  const preview = {};
  let previewPath;
  let text = '';
  try {
    if (kind === 'table') {
      const table = await readTable(objectPath, name);
      Object.assign(preview, tablePreview(table));
      text = tableText(table);
    } else if (kind === 'image') {
      const image = sharp(buffer, { limitInputPixels: 200_000_000, density: ext === '.svg' ? 144 : undefined });
      const meta = await image.metadata();
      preview.width = meta.width;
      preview.height = meta.height;
      const { data: thumbnail, info } = await image
        .rotate()
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer({ resolveWithObject: true });
      if (meta.orientation >= 5 && meta.orientation <= 8) {
        preview.width = meta.height;
        preview.height = meta.width;
      }
      previewPath = await stageBytes(home, thumbnail);
      preview.width ||= info.width;
      preview.height ||= info.height;
      preview.image = `${sha256}.png`;
    } else if (kind === 'text') {
      preview.text = buffer.subarray(0, 2400).toString('utf8').replace(/�$/, '');
      text = buffer.subarray(0, SEARCH_TEXT * 3).toString('utf8').slice(0, SEARCH_TEXT);
    }
  } catch (error) {
    preview.error = error.message;
  }
  return { objectKey, objectPath, previewPath, sha256, size: buffer.length, name, kind, mime: mimeOf(name), preview, text };
}

export async function stageFile(home, source, name) {
  const stat = await fs.stat(source).catch(() => null);
  assert(stat?.isFile(), `文件不存在或不可读：${source}`, 422, 'FILE_NOT_FOUND');
  assert(stat.size <= MAX_FILE, '单个文件最大支持 200 MB', 413, 'FILE_TOO_LARGE');
  return stageBuffer(home, await fs.readFile(source), name || path.basename(source));
}

const isIndex = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;

function applyCsv(table, op) {
  const rows = table.rows;
  const width = () => rows.reduce((n, row) => Math.max(n, row.length), 0);
  if (op.type === 'set') {
    while (rows.length <= op.row) rows.push([]);
    while (rows[op.row].length <= op.column) rows[op.row].push('');
    rows[op.row][op.column] = op.value == null ? '' : String(op.value);
  } else if (op.type === 'insertRows') {
    rows.splice(Math.min(op.at, rows.length), 0, ...Array.from({ length: op.count }, () => []));
  } else if (op.type === 'deleteRows') {
    rows.splice(op.at, op.count);
  } else if (op.type === 'insertColumns') {
    const total = Math.max(width(), op.at);
    for (const row of rows) {
      while (row.length < total) row.push('');
      row.splice(op.at, 0, ...Array.from({ length: op.count }, () => ''));
    }
  } else if (op.type === 'deleteColumns') {
    for (const row of rows) row.splice(op.at, op.count);
  }
}

function applyXlsx(table, op) {
  const sheet = table.workbook.worksheets[op.sheet ?? 0];
  if (op.type === 'set') sheet.getCell(op.row + 1, op.column + 1).value = excelValue(op.value == null ? '' : op.value);
  else if (op.type === 'insertRows') sheet.spliceRows(op.at + 1, 0, ...Array.from({ length: op.count }, () => []));
  else if (op.type === 'deleteRows') sheet.spliceRows(op.at + 1, op.count);
  else if (op.type === 'insertColumns') sheet.spliceColumns(op.at + 1, 0, ...Array.from({ length: op.count }, () => []));
  else if (op.type === 'deleteColumns') sheet.spliceColumns(op.at + 1, op.count);
}

/**
 * Applies edit operations in order and stages the result as new bytes.
 * Operations: set {sheet,row,column,value}; insertRows / deleteRows / insertColumns / deleteColumns {sheet,at,count}.
 */
export async function editTable(home, version, name, operations) {
  assert(Array.isArray(operations) && operations.length > 0 && operations.length <= 50000, '须提交 1–50000 个编辑操作');
  const table = await readTable(path.join(home, 'objects', version.object_key), name);
  for (const op of operations) {
    assert(op && typeof op === 'object' && table.sheets[op.sheet ?? 0], '工作表不存在');
    if (op.type === 'set') {
      assert(isIndex(op.row, 1_048_575) && isIndex(op.column, 16_383), '无效的单元格地址');
      assert(op.value === null || ['string', 'number', 'boolean'].includes(typeof op.value), '单元格值须为文本、数字或布尔值');
      assert(String(op.value ?? '').length <= 32767, '单元格文本过长');
    } else {
      assert(['insertRows', 'deleteRows', 'insertColumns', 'deleteColumns'].includes(op.type), `未知的编辑操作：${op.type}`);
      assert(isIndex(op.at, 1_048_575) && Number.isInteger(op.count) && op.count >= 1 && op.count <= 10000, '无效的行列范围');
    }
    if (table.type === 'xlsx') applyXlsx(table, op);
    else applyCsv(table, op);
  }
  let buffer;
  if (table.type === 'xlsx') {
    table.workbook.calcProperties.fullCalcOnLoad = true;
    buffer = Buffer.from(await table.workbook.xlsx.writeBuffer());
  } else {
    const width = table.rows.reduce((n, row) => Math.max(n, row.length), 0);
    const rows = table.rows.map(row => Array.from({ length: width }, (_, c) => row[c] ?? ''));
    buffer = Buffer.from(stringify(rows, { delimiter: table.delimiter, bom: table.bom }));
  }
  return stageBuffer(home, buffer, name);
}
