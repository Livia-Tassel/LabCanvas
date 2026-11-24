export class ApiError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

async function request(url: string, init: RequestInit = {}) {
  const json = init.body !== undefined && !(init.body instanceof FormData);
  const response = await fetch(`/api${url}`, {
    ...init,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...init.headers }
  });
  const text = await response.text();
  if (!response.ok) {
    let data: { error?: { message?: string; code?: string } } = {};
    try { data = JSON.parse(text); } catch { /* reported below */ }
    throw new ApiError(data.error?.message || `请求失败（${response.status}）`, data.error?.code || 'NETWORK');
  }
  return text;
}

export async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const text = await request(url, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

/** The response body as received, for callers that want to skip work when nothing changed. */
export const apiText = (url: string) => request(url);

export const send = <T>(method: string, url: string, body?: unknown) =>
  api<T>(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** Uploads files, reporting how much has been sent (0–1). */
export function upload<T>(url: string, files: File[], meta?: unknown, onProgress?: (fraction: number) => void) {
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  if (meta !== undefined) form.append('meta', JSON.stringify(meta));
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${url}`);
    xhr.responseType = 'text';
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
    xhr.onerror = () => reject(new ApiError('上传失败，与本机服务的连接已断开', 'NETWORK'));
    xhr.onload = () => {
      let data: { error?: { message?: string; code?: string } } = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* reported below */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(data.error?.message || `请求失败（${xhr.status}）`, data.error?.code || 'NETWORK'));
    };
    xhr.send(form);
  });
}

export const rawUrl = (file: { id: string; version: number }, download = false) =>
  `/api/files/${file.id}/raw?version=${file.version}${download ? '&download=1' : ''}`;
export const thumbnailUrl = (file: { id: string; version: number }) =>
  `/api/files/${file.id}/thumbnail?version=${file.version}`;
