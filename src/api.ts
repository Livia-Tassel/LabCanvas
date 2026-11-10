export class ApiError extends Error {
  code: string; details?: unknown;
  constructor(message: string, code: string, details?: unknown) { super(message); this.code = code; this.details = details; }
}
export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${url}`, { ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error?.message || `请求失败 (${response.status})`, data.error?.code || 'NETWORK_ERROR', data.error?.details);
  return data as T;
}
export const send = <T>(url: string, method: string, body?: unknown) => api<T>(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024**2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024**2).toFixed(1)} MB`;
export const date = (value: string, time = false) => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) });
export const kindName = (kind: string) => ({ table: '表格', image: '图片', text: '文本', pdf: 'PDF', file: '文件' })[kind] || kind;
export function columnName(index: number) { let s = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }
