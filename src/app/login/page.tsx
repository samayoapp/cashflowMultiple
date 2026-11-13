'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { TrendingUp } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, ErrorBox, Field } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/api/auth/login', { body: { email, password } });
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar sesión');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="glass w-full max-w-sm space-y-4 p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white">
          <TrendingUp className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Cashflow Publimatec</h1>
          <p className="text-xs text-slate-500">Tesorería y flujo de efectivo</p>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      <Field label="Correo">
        <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Contraseña">
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" loading={loading} className="w-full">
        Iniciar sesión
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-emerald-50 via-slate-50 to-sky-50 p-4 dark:from-slate-950 dark:via-slate-950 dark:to-emerald-950/30">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
