'use client';

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { AlertTriangle, HelpCircle, Loader2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatMoney } from '@/lib/money';
import { tableTotals, type ColumnValue } from '@/lib/totals';
import { createPortal } from 'react-dom';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        variant === 'primary' && 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
        variant === 'secondary' &&
          'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
        variant === 'ghost' && 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
        variant === 'danger' && 'bg-rose-600 text-white hover:bg-rose-700',
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('glass p-4 sm:p-5', className)}>{children}</div>;
}

export function Badge({
  tone = 'slate',
  className,
  children,
}: {
  tone?: 'slate' | 'green' | 'red' | 'amber' | 'blue' | 'violet';
  className?: string;
  children: ReactNode;
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
    red: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
    blue: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
    violet: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300',
  };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-slate-400', className)} />;
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
      {message}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <p className="text-sm font-medium text-slate-600 dark:text-slate-300">{title}</p>
      {children && <div className="text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  tone = 'brand',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  tone?: 'brand' | 'violet';
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-sm disabled:opacity-50"
    >
      <span
        className={cn(
          'relative h-5 w-9 rounded-full transition',
          checked ? (tone === 'violet' ? 'bg-violet-600' : 'bg-brand-600') : 'bg-slate-300 dark:bg-slate-700',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </span>
      {label}
    </button>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-900">
      {tabs.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-sm font-medium transition',
            value === t.id
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          'animate-fade-in max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900 sm:rounded-2xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Cerrar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---- Toasts ----
type Toast = { id: number; message: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <ConfirmHost />
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'animate-fade-in pointer-events-auto rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg',
              t.tone === 'ok' ? 'bg-slate-900 dark:bg-slate-700' : 'bg-rose-600',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/**
 * Pie de tabla con totales "como Excel": suma las filas que se están viendo (ya filtradas),
 * con un total por moneda y, si se indica, por sección (p. ej. ingresos y gastos por separado).
 * `columns` lleva una entrada por columna de la tabla: null = celda vacía; las primeras null
 * forman la etiqueta "Total". `section` devuelve false para excluir una fila (p. ej. canceladas).
 */
export function TableTotals<T>({
  rows,
  columns,
  section,
  note,
  noun = ['partida', 'partidas'],
}: {
  rows: readonly T[];
  columns: readonly (ColumnValue<T> | null)[];
  section?: (row: T) => string | null | false;
  /** Aclaración junto al conteo, p. ej. "sin canceladas". */
  note?: string;
  noun?: [string, string];
}) {
  const sumIdx = useMemo(() => columns.flatMap((c, i) => (c ? [i] : [])), [columns]);
  const totals = useMemo(
    () => tableTotals(rows, sumIdx.map((i) => columns[i]!), section),
    [rows, columns, sumIdx, section],
  );
  if (totals.length === 0 || sumIdx.length === 0) return null;
  const labelSpan = Math.max(sumIdx[0], 1);
  return (
    <tfoot className="border-t-2 border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50">
      {totals.map((t, k) => {
        const firstOfSection = k === 0 || totals[k - 1].section !== t.section;
        return (
          <tr key={`${t.section}|${t.currency}`} className={cn(firstOfSection && k > 0 && 'border-t border-slate-200 dark:border-slate-700')}>
            <td className="td font-semibold" colSpan={labelSpan}>
              {firstOfSection && (
                <>
                  {t.section ?? 'Total'}
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    {t.count} {t.count === 1 ? noun[0] : noun[1]}
                    {note && k === 0 && ` · ${note}`}
                  </span>
                </>
              )}
            </td>
            {columns.slice(labelSpan).map((c, j) => {
              const i = labelSpan + j;
              if (!c) return <td key={i} className="td" />;
              const v = t.sums[sumIdx.indexOf(i)];
              return (
                <td key={i} className="td num font-semibold">
                  {v === null ? '' : formatMoney(v, t.currency)}
                </td>
              );
            })}
          </tr>
        );
      })}
    </tfoot>
  );
}

// ---- Confirmaciones (reemplazan confirm() del navegador) ----
export interface ConfirmOptions {
  title?: string;
  /** Texto (los saltos de línea se respetan) o contenido. */
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger: acción destructiva (botón rojo, el foco queda en "Volver"). */
  tone?: 'danger' | 'primary';
}

type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void };
let openConfirm: ((o: ConfirmOptions) => Promise<boolean>) | null = null;

/**
 * Diálogo de confirmación con el estilo de la app, centrado en pantalla.
 * Uso: `if (!(await confirmDialog({ title, message, tone: 'danger' }))) return;`
 * Funciona también encima de otro popup abierto.
 */
export function confirmDialog(o: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof o === 'string' ? { message: o } : o;
  return openConfirm ? openConfirm(opts) : Promise.resolve(false);
}

function ConfirmHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    openConfirm = (o) =>
      new Promise<boolean>((resolve) => {
        pendingRef.current?.resolve(false); // uno a la vez
        setPending({ ...o, resolve });
      });
    return () => {
      openConfirm = null;
    };
  }, []);

  const close = useCallback((ok: boolean) => {
    pendingRef.current?.resolve(ok);
    setPending(null);
  }, []);

  useEffect(() => {
    if (!pending) return;
    // En captura sobre document: Escape cierra solo este diálogo, no el popup que esté debajo
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(false);
    };
    document.addEventListener('keydown', h, true);
    return () => document.removeEventListener('keydown', h, true);
  }, [pending, close]);

  if (!pending || typeof document === 'undefined') return null;
  const danger = pending.tone !== 'primary';
  const Icon = danger ? AlertTriangle : HelpCircle;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" onMouseDown={() => close(false)}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cf-confirm-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="animate-fade-in w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex gap-3 px-5 pb-4 pt-5">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
              danger ? 'bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400' : 'bg-brand-50 text-brand-600 dark:bg-brand-900/40 dark:text-brand-300',
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="cf-confirm-title" className="text-base font-semibold">
              {pending.title ?? '¿Confirmar?'}
            </h2>
            <div className="mt-1.5 whitespace-pre-line text-sm text-slate-600 dark:text-slate-300">{pending.message}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
          <Button onClick={() => close(false)} autoFocus={danger}>
            {pending.cancelLabel ?? 'Volver'}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus={!danger}>
            {pending.confirmLabel ?? 'Confirmar'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
