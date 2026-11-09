/** Records every outbound request so the UI can PROVE what went where (method, host, path, byte size - never bodies). */
export type NetEntry = { at: number; method: string; host: string; path: string; bytes: number; kind: 'cipherwork-api' | 'near-ai-inference' | 'near-ai-attestation' | 'near-rpc' | 'other' };

const listeners = new Set<() => void>();
export const netLog: NetEntry[] = [];
export const subscribeNet = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export const clearNet = () => { netLog.length = 0; listeners.forEach((f) => f()); };

const API_HOST = (() => { try { return new URL(import.meta.env.VITE_API_URL ?? 'http://localhost:8787').host; } catch { return ''; } })();

function classify(host: string, path: string): NetEntry['kind'] {
  if (host === API_HOST) return 'cipherwork-api';
  if (host.endsWith('near.ai')) return /chat\/completions|\/responses|\/messages/.test(path) ? 'near-ai-inference' : 'near-ai-attestation';
  if (host.includes('rpc.')) return 'near-rpc';
  return 'other';
}

export function installNetLog() {
  if ((globalThis as any).__cwNetLog) return;
  (globalThis as any).__cwNetLog = true;
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: any, init?: any) => {
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
      let bytes = 0;
      const b = init?.body;
      if (typeof b === 'string') bytes = new TextEncoder().encode(b).length;
      else if (b instanceof Uint8Array || b instanceof ArrayBuffer) bytes = b.byteLength;
      netLog.push({ at: Date.now(), method, host: url.host, path: url.pathname, bytes, kind: classify(url.host, url.pathname) });
      listeners.forEach((f) => f());
    } catch { /* ignore */ }
    return orig(input, init);
  }) as typeof fetch;
}
