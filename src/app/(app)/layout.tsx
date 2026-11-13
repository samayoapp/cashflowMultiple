'use client';

import { useEffect, useState } from 'react';
import { AppProvider, type ContextPayload } from '@/components/AppContext';
import { AppShell } from '@/components/AppShell';
import { ToastProvider, Loading, ErrorBox } from '@/components/ui';
import { api } from '@/lib/client/api';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [initial, setInitial] = useState<ContextPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ContextPayload>('/api/context')
      .then(setInitial)
      .catch((e) => setError(e instanceof Error ? e.message : 'Error al cargar'));
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-md p-8">
        <ErrorBox message={error} />
      </div>
    );
  }
  if (!initial) return <Loading label="Cargando Cashflow…" />;

  return (
    <ToastProvider>
      <AppProvider initial={initial}>
        <AppShell>{children}</AppShell>
      </AppProvider>
    </ToastProvider>
  );
}
