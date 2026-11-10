export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT', details) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
export function assert(condition, message, status = 400, code = 'INVALID_INPUT') {
  if (!condition) throw new AppError(message, status, code);
}
export function nameOf(value, label = '名称') {
  assert(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200, `${label}须为 1–200 个字符`);
  return value.trim();
}
export function dateOf(value, fallback = new Date().toISOString()) {
  if (!value) return fallback;
  assert(typeof value === 'string' && Number.isFinite(Date.parse(value)), '时间须为 ISO 8601 日期');
  return new Date(value).toISOString();
}
