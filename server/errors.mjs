export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT', details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assert(condition, message, status = 400, code = 'INVALID_INPUT') {
  if (!condition) throw new AppError(message, status, code);
}

export function notFound(what) {
  return new AppError(`${what}不存在`, 404, 'NOT_FOUND');
}

export function nameOf(value, label = '名称') {
  assert(
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200,
    `${label}须为 1–200 个字符`
  );
  return value.trim();
}

/** Experiment dates are calendar days (YYYY-MM-DD) in the user's local time. */
export function localDate(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dayOf(value) {
  if (value == null || value === '') return localDate();
  assert(typeof value === 'string', '日期须为 YYYY-MM-DD');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    assert(Number.isFinite(Date.parse(`${value}T00:00:00Z`)), '日期无效');
    return value;
  }
  assert(Number.isFinite(Date.parse(value)), '日期须为 YYYY-MM-DD');
  return localDate(new Date(value));
}
