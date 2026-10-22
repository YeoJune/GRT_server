let csrf: string | undefined;
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: unknown[],
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET'
        ? { 'Idempotency-Key': crypto.randomUUID(), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }
        : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('grt:expired'));
    throw new ApiError(response.status, data.code, data.message, data.field_errors || []);
  }
  if (data?.csrf_token) csrf = data.csrf_token;
  return data;
}
export async function all(path: string): Promise<any[]> {
  let data: any[] = [];
  let cursor: string | null = null;
  do {
    const page: any = await api(
      `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    data.push(...page.data);
    cursor = page.next_cursor;
  } while (cursor);
  return data;
}
export const pretty = (v: unknown) => JSON.stringify(v, null, 2);
export function saveJSON(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([pretty(value)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
export function pointer(value: any, path: string) {
  if (!path.startsWith('/')) return null;
  return (
    path
      .slice(1)
      .split('/')
      .reduce((obj, k) => obj?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], value) ?? null
  );
}
