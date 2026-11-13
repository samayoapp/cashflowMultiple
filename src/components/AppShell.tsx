'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  Bell,
  Check,
  ChevronDown,
  FlaskConical,
  Inbox,
  LayoutDashboard,
  LogOut,
  Moon,
  Plus,
  Settings,
  Sun,
  Table2,
  TrendingUp,
  Layers,
} from 'lucide-react';
import { useApp } from './AppContext';
import { cn, Toggle } from './ui';
import { EntityFormModal } from './forms';
import { api } from '@/lib/client/api';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/matrix', label: 'Matriz de flujo', icon: Table2 },
  { href: '/operations', label: 'CxC / CxP', icon: ArrowLeftRight },
  { href: '/inbox', label: 'Bandeja externa', icon: Inbox },
  { href: '/settings', label: 'Configuración', icon: Settings },
];

export function EntityDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', className)} style={{ backgroundColor: color }} />;
}

function ContextSwitcher() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const current = app.currentEntity;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-[12rem] items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
      >
        {current ? <EntityDot color={current.color} /> : <Layers className="h-4 w-4 text-slate-500" />}
        <span className="truncate">{current ? current.name : 'Todas las entidades'}</span>
        <span className="ml-auto text-xs text-slate-500">{app.currency}</span>
        <ChevronDown className="h-4 w-4 text-slate-400" />
      </button>
      {open && (
        <div className="animate-fade-in absolute left-0 z-40 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-800 dark:bg-slate-900">
          <SwitchItem
            active={app.ctx === 'all'}
            onClick={() => {
              app.setCtx('all');
              setOpen(false);
            }}
          >
            <Layers className="h-4 w-4 text-slate-500" />
            <span>Vista consolidada</span>
            <span className="ml-auto text-xs text-slate-500">{app.settings.reportingCurrency}</span>
          </SwitchItem>
          <div className="my-1 border-t border-slate-200 dark:border-slate-800" />
          {app.activeEntities.map((e) => (
            <SwitchItem
              key={e.id}
              active={app.ctx === e.id}
              onClick={() => {
                app.setCtx(e.id);
                setOpen(false);
              }}
            >
              <EntityDot color={e.color} />
              <span className="truncate">{e.name}</span>
              <span className="ml-auto text-xs text-slate-500">{e.currency}</span>
            </SwitchItem>
          ))}
          {app.isAdmin && (
            <>
              <div className="my-1 border-t border-slate-200 dark:border-slate-800" />
              <button
                onClick={() => {
                  setCreating(true);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-500/10"
              >
                <Plus className="h-4 w-4" /> Nueva entidad
              </button>
            </>
          )}
        </div>
      )}
      <EntityFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={async (e) => {
          await app.refresh();
          app.setCtx(e.id);
        }}
      />
    </div>
  );
}

function SwitchItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800',
        active && 'bg-slate-100 font-semibold dark:bg-slate-800',
      )}
    >
      {children}
      {active && <Check className="h-4 w-4 text-brand-600" />}
    </button>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  return (
    <button
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle('dark', next);
        try {
          localStorage.setItem('cf_theme', next ? 'dark' : 'light');
        } catch {}
      }}
      className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
      aria-label="Cambiar tema"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const app = useApp();
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
  }

  return (
    <div className="min-h-screen lg:pl-60">
      {/* Sidebar escritorio */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-slate-200 bg-white/70 backdrop-blur dark:border-slate-800 dark:bg-slate-950/70 lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
            <TrendingUp className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold">Cashflow</p>
            <p className="text-[11px] text-slate-500">Publimatec</p>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition',
                pathname.startsWith(n.href)
                  ? 'bg-brand-50 text-brand-800 dark:bg-brand-500/10 dark:text-brand-300'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900',
              )}
            >
              <n.icon className="h-4 w-4" />
              {n.label}
              {n.href === '/inbox' && app.pendingStaging > 0 && (
                <span className="ml-auto rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">{app.pendingStaging}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3 dark:border-slate-800">
          <p className="truncate px-2 text-sm font-medium">{app.user.name}</p>
          <p className="truncate px-2 text-[11px] text-slate-500">
            {app.user.email} · {app.user.role === 'ADMIN' ? 'Administrador' : 'Usuario'}
          </p>
          <button
            onClick={logout}
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900"
          >
            <LogOut className="h-4 w-4" /> Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Barra superior global */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <ContextSwitcher />
          <div
            className={cn(
              'flex items-center gap-2 rounded-xl border px-3 py-1.5 transition',
              app.whatIf
                ? 'border-violet-300 bg-violet-50 dark:border-violet-800 dark:bg-violet-500/10'
                : 'border-slate-200 dark:border-slate-800',
            )}
          >
            <FlaskConical className={cn('h-4 w-4', app.whatIf ? 'text-violet-600' : 'text-slate-400')} />
            <Toggle
              tone="violet"
              checked={app.whatIf}
              onChange={app.setWhatIf}
              label={<span className="font-medium">Simulación</span>}
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Link href="/inbox" className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Bandeja externa">
              <Bell className="h-4 w-4" />
              {app.pendingStaging > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
                  {app.pendingStaging}
                </span>
              )}
            </Link>
            <ThemeToggle />
            <button onClick={logout} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden" aria-label="Cerrar sesión">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
        {/* Navegación móvil */}
        <nav className="flex gap-1 overflow-x-auto px-4 pb-2 lg:hidden">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium',
                pathname.startsWith(n.href) ? 'bg-brand-50 text-brand-800 dark:bg-brand-500/10 dark:text-brand-300' : 'text-slate-600 dark:text-slate-400',
              )}
            >
              <n.icon className="h-3.5 w-3.5" /> {n.label}
            </Link>
          ))}
        </nav>
        {app.whatIf && (
          <div className="border-t border-violet-200 bg-violet-600 px-4 py-1 text-center text-xs font-medium text-white dark:border-violet-900 sm:px-6">
            Modo simulación activo: los cambios en la matriz son hipotéticos y no alteran los registros reales.
          </div>
        )}
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
