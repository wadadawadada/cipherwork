export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API_URL + path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message ?? j.error ?? `HTTP ${r.status}`), { code: j.error as string, status: r.status, body: j });
  return j;
}
