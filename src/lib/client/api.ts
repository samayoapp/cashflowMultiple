'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const DATA_CHANGED_EVENT = 'cf:data-changed';
export const CONTEXT_CHANGED_EVENT = 'cf:context-changed';

export class ApiClientError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 401 && typeof window !== 'undefined' && !url.includes('/api/auth/')) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiClientError(401, 'Sesión expirada');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiClientError(res.status, (json as { error?: string }).error ?? `Error ${res.status}`);
  return json as T;
}

/** Notifica a todas las vistas que los datos cambiaron (patrón CustomEvent del CRM). */
export function emitDataChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT));
}

// Caché en memoria Stale-While-Revalidate: navegación instantánea entre pantallas.
const cache = new Map<string, unknown>();

export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | undefined>(() => (url ? (cache.get(url) as T | undefined) : undefined));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(url) && !cache.has(url ?? ''));
  const urlRef = useRef(url);
  urlRef.current = url;

  const reload = useCallback(async () => {
    const u = urlRef.current;
    if (!u) return;
    try {
      const d = await api<T>(u);
      cache.set(u, d);
      if (urlRef.current === u) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (urlRef.current === u) setError(e instanceof Error ? e.message : 'Error');
    } finally {
      if (urlRef.current === u) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!url) return;
    const cached = cache.get(url) as T | undefined;
    setData(cached);
    setLoading(!cached);
    void reload();
  }, [url, reload]);

  useEffect(() => {
    const h = () => void reload();
    window.addEventListener(DATA_CHANGED_EVENT, h);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, h);
  }, [reload]);

  return { data, error, loading, reload, setData };
}

export function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}
