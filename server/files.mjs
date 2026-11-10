import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { assert, AppError } from './errors.mjs';

export const MAX_FILE = 100 * 1024 * 1024;
const imageExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.tif', '.tiff']);
const textExt = new Set(['.txt', '.md', '.log', '.json', '.yaml', '.yml', '.toml', '.ini', '.py', '.sh', '.r', '.out', '.conf']);
const mimes = { '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/plain', '.log': 'text/plain', '.json': 'text/plain' };
export function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  return ['.csv', '.tsv', '.xlsx'].includes(ext) ? 'table' : imageExt.has(ext) ? 'image' : ext === '.pdf' ? 'pdf' : textExt.has(ext) ? 'text' : 'file';
}
export function roleOf(name) { return /\.(log|out|conf|ini)$/i.test(name) ? 'supporting' : 'result'; }
export function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if ('formula' in value || 'sharedFormula' in value) return value.result == null ? `=${value.formula || value.sharedFormula}` : cellText(value.result);
  if (value.richText) return value.richText.map(p => p.text).join('');
  return value.text ?? value.error ?? JSON.stringify(value);
}
export function excelValue(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('=') && value.length > 1) return { formula: value.slice(1) };
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && !/^0\d/.test(value)) return Number(value);
  return value;
}
export async function readTable(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    assert(workbook.worksheets.length > 0, '工作簿中没有工作表');
    return { type: 'xlsx', workbook, sheets: workbook.worksheets.map(s => ({ name: s.name, rows: s.rowCount, columns: s.columnCount })) };
  }
  const content = await fs.readFile(filePath, 'utf8');
  const delimiter = ext === '.tsv' ? '\t' : ',';
  let rows;
  try { rows = parse(content, { delimiter, bom: true, relax_column_count: true, skip_empty_lines: false }); }
  catch (e) { throw new AppError(`表格格式无法解析：${e.message}`, 422, 'INVALID_TABLE'); }
  const columns = rows.reduce((n, r) => Math.max(n, r.length), 0);
  return { type: 'csv', rows, delimiter, bom: content.charCodeAt(0) === 0xfeff, sheets: [{ name: 'Sheet1', rows: rows.length, columns }] };
}
export function tableSlice(table, sheetIndex = 0, offset = 0, limit = 100, colOffset = 0, colLimit = 60) {
  const meta = table.sheets[sheetIndex];
  assert(meta, '工作表不存在', 404, 'NOT_FOUND');
  const data = [], formulas = {};
  for (let r = offset; r < Math.min(meta.rows, offset + limit); r++) {
    const row = [];
    for (let c = colOffset; c < Math.min(meta.columns, colOffset + colLimit); c++) {
      const value = table.type === 'xlsx' ? table.workbook.worksheets[sheetIndex].getCell(r + 1, c + 1).value : table.rows[r]?.[c];
      row.push(cellText(value));
      if (value && typeof value === 'object' && (value.formula || value.sharedFormula)) formulas[`${r}:${c}`] = `=${value.formula || value.sharedFormula}`;
    }
    data.push(row);
  }
  return { sheets: table.sheets, sheet: sheetIndex, offset, colOffset, data, formulas, totalRows: meta.rows, totalColumns: meta.columns };
}
export async function stageFile(home, source, originalName) {
  const stat = await fs.stat(source).catch(() => null);
  assert(stat?.isFile(), `文件不存在或不可读：${originalName || source}`, 422, 'FILE_NOT_FOUND');
  assert(stat.size <= MAX_FILE, '单个文件最大支持 100 MB', 413, 'FILE_TOO_LARGE');
  const buffer = await fs.readFile(source);
  return stageBuffer(home, buffer, originalName || path.basename(source));
}
async function publishFile(directory, filename, buffer) {
  const destination = path.join(directory, filename);
  if (await fs.stat(destination).catch(() => null)) return;
  const temp = path.join(directory, `.staging-${randomUUID()}`);
  try {
    await fs.writeFile(temp, buffer, { flag: 'wx', mode: 0o600 });
    // Link only completed bytes into the immutable namespace; concurrent writers never see a partial object.
    await fs.link(temp, destination).catch(error => { if (error.code !== 'EEXIST') throw error; });
  } finally { await fs.unlink(temp).catch(() => {}); }
}
export async function stageBuffer(home, buffer, originalName) {
  assert(buffer.length <= MAX_FILE, '单个文件最大支持 100 MB', 413, 'FILE_TOO_LARGE');
  const name = path.basename(originalName).slice(0, 255);
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const objectKey = `${sha256}${ext}`;
  const filePath = path.join(home, 'objects', objectKey);
  // Content-addressed immutable files are safe for concurrent CLI and GUI writers.
  await publishFile(path.join(home, 'objects'), objectKey, buffer);
  const kind = kindOf(name);
  const preview = { status: 'ready' };
  try {
    if (kind === 'table') {
      const table = await readTable(filePath, name);
      Object.assign(preview, tableSlice(table, 0, 0, 8, 0, 7));
    } else if (kind === 'image') {
      const image = sharp(buffer, { limitInputPixels: 100_000_000 });
      const meta = await image.metadata();
      preview.width = meta.width; preview.height = meta.height;
      const thumbnail = await image.rotate().resize(1000, 700, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      await publishFile(path.join(home, 'previews'), `${sha256}.png`, thumbnail);
      preview.image = `${sha256}.png`;
    } else if (kind === 'text') preview.text = buffer.subarray(0, 1800).toString('utf8');
  } catch (e) { preview.status = 'failed'; preview.warning = e.message; }
  return { objectKey, sha256, size: buffer.length, originalName: name, kind, mime: mimes[ext] || 'application/octet-stream', preview };
}
export async function patchedTable(home, current, changes) {
  assert(Array.isArray(changes) && changes.length > 0 && changes.length <= 20000, '每次须提交 1–20000 个单元格修改');
  const table = await readTable(path.join(home, 'objects', current.object_key), current.original_name);
  for (const change of changes) {
    const { sheet = 0, row, column, value } = change;
    assert(Number.isInteger(sheet) && table.sheets[sheet] && Number.isInteger(row) && row >= 0 && row < 1_000_000 && Number.isInteger(column) && column >= 0 && column < 16384, '无效的单元格地址');
    assert(['string', 'number', 'boolean'].includes(typeof value) || value === null, '单元格值须为文本、数字、布尔值或 null');
    assert(String(value ?? '').length <= 32767, '单元格文本过长');
    if (table.type === 'xlsx') table.workbook.worksheets[sheet].getCell(row + 1, column + 1).value = excelValue(value);
    else {
      assert(row <= table.rows.length + 10000 && column <= Math.max(table.sheets[0].columns, 1) + 100, '请分批增加行列');
      while (table.rows.length <= row) table.rows.push([]);
      while (table.rows[row].length <= column) table.rows[row].push('');
      table.rows[row][column] = value == null ? '' : String(value);
    }
  }
  let buffer;
  if (table.type === 'xlsx') {
    table.workbook.calcProperties.fullCalcOnLoad = true;
    buffer = Buffer.from(await table.workbook.xlsx.writeBuffer());
  } else {
    const width = table.rows.reduce((n, r) => Math.max(n, r.length), 0);
    buffer = Buffer.from(stringify(table.rows.map(r => Array.from({ length: width }, (_, c) => r[c] ?? '')), { delimiter: table.delimiter, bom: table.bom }));
  }
  return stageBuffer(home, buffer, current.original_name);
}
export async function atomicJson(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 });
  await fs.rename(temp, file);
}
