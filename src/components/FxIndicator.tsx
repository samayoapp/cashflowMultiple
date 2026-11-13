'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, DollarSign, Pencil, RefreshCw } from 'lucide-react';
import { api, emitDataChanged } from '@/lib/client/api';
import { formatShortDate } from '@/lib/dates';
import { useApp } from './AppContext';
import { Button, cn, ErrorBox, Field, Modal, useToast } from './ui';

const SOURCE: Record<string, string> = { API: 'en línea', MANUAL: 'manual', BCH: 'BCH' };

/** Indicador global del tipo de cambio USD→HNL (venta efectiva) con refresco y edición (ADMIN). */
export function FxIndicator() {
  const app = useApp();
  const toast = useToast();
  const fx = app.fx;
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState(false);

  async function sync() {
    setSyncing(true);
    try {
      const r = await api<{ updated: boolean; reason?: string }>('/api/exchange-rates/sync', { body: {} });
      toast(r.updated ? 'Tipo de cambio actualizado' : (r.reason ?? 'Sin cambios'), r.updated ? 'ok' : 'error');
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setSyncing(false);
    }
  }

  const title = fx
    ? `Venta efectiva ${fx.effectiveSellRate} = oficial ${fx.officialSellRate} + spread ${fx.bankSpread}\n` +
      `Fuente: ${SOURCE[fx.source] ?? fx.source} · ${fx.date}${fx.stale ? ' (no es la tasa de hoy)' : ''}` +
      (fx.lastSyncError ? `\nÚltimo error de sincronización: ${fx.lastSyncError}` : '')
    : 'Sin tipo de cambio registrado';

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-1 rounded-xl border px-2 py-1 text-sm',
          fx?.stale || !fx ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-500/10' : 'border-slate-200 dark:border-slate-800',
        )}
        title={title}
      >
        {fx?.stale || !fx ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> : <DollarSign className="h-3.5 w-3.5 text-slate-400" />}
        <span className="whitespace-nowrap tabular-nums">
          {fx ? (
            <>
              1 USD = <strong>L. {fx.effectiveSellRate}</strong>
              <span className="ml-1 hidden text-xs text-slate-500 xl:inline">
                ({SOURCE[fx.source] ?? fx.source}
                {fx.stale ? ` · ${formatShortDate(fx.date)}` : ''})
              </span>
            </>
          ) : (
            'Sin tipo de cambio'
          )}
        </span>
        <button onClick={sync} disabled={syncing} className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="Sincronizar en línea">
          <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
        </button>
        {app.isAdmin && (
          <button onClick={() => setEditing(true)} className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="Editar tasa o spread">
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {app.isAdmin && <FxEditModal open={editing} onClose={() => setEditing(false)} />}
    </>
  );
}

function FxEditModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const fx = app.fx;
  const [official, setOfficial] = useState('');
  const [spread, setSpread] = useState('');
  const [effective, setEffective] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setOfficial(fx?.officialSellRate ?? '');
    setSpread(fx?.bankSpread ?? '0.1800');
    setEffective('');
  }, [open, fx]);

  const preview = (() => {
    if (effective.trim()) return effective.trim();
    const o = Number(official);
    const s = Number(spread);
    return Number.isFinite(o) && Number.isFinite(s) && o > 0 ? (o + s).toFixed(4) : '—';
  })();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      if (official.trim() && official.trim() !== fx?.officialSellRate) body.officialSellRate = official.trim();
      if (spread.trim() && spread.trim() !== fx?.bankSpread) body.bankSpread = spread.trim();
      if (effective.trim()) body.effectiveSellRate = effective.trim();
      if (Object.keys(body).length === 0) return onClose();
      await api('/api/exchange-rates/override', { body });
      toast('Tipo de cambio guardado');
      emitDataChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Tipo de cambio USD → HNL">
      <form onSubmit={save} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <p className="text-sm text-slate-500">
          La venta efectiva (oficial + spread bancario) se usa para proyectar los pagos de tarjetas con saldo en dólares. Cambiar la
          tasa oficial o fijar una efectiva la marca como <strong>manual</strong> para hoy; la sincronización automática no la reemplaza.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tasa oficial de venta">
            <input className="input text-right" inputMode="decimal" value={official} onChange={(e) => setOfficial(e.target.value)} />
          </Field>
          <Field label="Spread bancario (global)" hint="Por defecto L. 0.18">
            <input className="input text-right" inputMode="decimal" value={spread} onChange={(e) => setSpread(e.target.value)} />
          </Field>
        </div>
        <Field label="Venta efectiva manual (opcional)" hint="Si la llenas, reemplaza oficial + spread">
          <input className="input text-right" inputMode="decimal" value={effective} onChange={(e) => setEffective(e.target.value)} placeholder="27.1800" />
        </Field>
        <p className="text-sm">
          Venta efectiva resultante: <strong className="tabular-nums">L. {preview}</strong>
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
