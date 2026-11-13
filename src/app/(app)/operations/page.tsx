'use client';

import { useMemo, useState } from 'react';
import { Ban, CalendarClock, CheckCircle2, Coins, Pencil, Plus, Search, Send, Trash2, X } from 'lucide-react';
import { useApp } from '@/components/AppContext';
import { Badge, Button, Card, cn, EmptyState, ErrorBox, Loading, Tabs, Toggle, useToast } from '@/components/ui';
import { EntityDot } from '@/components/AppShell';
import {
  ExecuteTransferModal,
  ObligationFormModal,
  PaymentModal,
  RecurrenceFormModal,
  RescheduleModal,
  TransferFormModal,
} from '@/components/forms';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { formatMoney } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { ObligationDto, RuleDto } from '@/lib/server/dto';

type Tab = 'IN' | 'OUT' | 'rules' | 'transfers';

export default function OperationsPage() {
  const [tab, setTab] = useState<Tab>('IN');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Gestión operativa</h1>
          <p className="text-sm text-slate-500">Cuentas por cobrar, por pagar, recurrencias y transferencias entre entidades.</p>
        </div>
        <Tabs<Tab>
          tabs={[
            { id: 'IN', label: 'Por cobrar' },
            { id: 'OUT', label: 'Por pagar' },
            { id: 'rules', label: 'Recurrentes' },
            { id: 'transfers', label: 'Transferencias' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {(tab === 'IN' || tab === 'OUT') && <ObligationsTab key={tab} direction={tab} />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'transfers' && <TransfersTab />}
    </div>
  );
}

const STATUS_LABEL: Record<string, { label: string; tone: 'slate' | 'green' | 'amber' | 'red' }> = {
  OPEN: { label: 'Pendiente', tone: 'slate' },
  PARTIAL: { label: 'Abono parcial', tone: 'amber' },
  SETTLED: { label: 'Liquidada', tone: 'green' },
  CANCELLED: { label: 'Cancelada', tone: 'red' },
};

function ObligationsTab({ direction }: { direction: 'IN' | 'OUT' }) {
  const app = useApp();
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'closed' | 'all'>('open');
  const [priority, setPriority] = useState<'ALL' | 'FIXED' | 'FLEXIBLE'>('ALL');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const url = `/api/obligations?ctx=${encodeURIComponent(app.ctx)}&direction=${direction}&status=${status}&transfers=exclude${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  const { data, error, loading } = useApi<ObligationDto[]>(url);

  const [form, setForm] = useState<{ open: boolean; ob: ObligationDto | null }>({ open: false, ob: null });
  const [pay, setPay] = useState<{ ob: ObligationDto; full: boolean } | null>(null);
  const [move, setMove] = useState<ObligationDto | null>(null);

  const rows = useMemo(
    () =>
      (data ?? []).filter(
        (o) => (priority === 'ALL' || o.priority === priority) && (app.whatIf || !o.isHypothetical),
      ),
    [data, priority, app.whatIf],
  );

  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of rows) {
      if (o.isHypothetical) continue;
      const cur = app.entityById.get(o.entityId)?.currency ?? '—';
      m.set(cur, (m.get(cur) ?? 0) + o.remaining);
    }
    return Array.from(m.entries());
  }, [rows, app.entityById]);

  async function cancel(o: ObligationDto) {
    const hypo = o.isHypothetical;
    if (!confirm(hypo ? `¿Eliminar la partida hipotética "${o.description}"?` : `¿Cancelar "${o.description}"? Dejará de proyectarse.`)) return;
    try {
      if (hypo) await api(`/api/obligations/${o.id}`, { method: 'DELETE' });
      else await api(`/api/obligations/${o.id}`, { method: 'PATCH', body: { status: 'CANCELLED' } });
      toast(hypo ? 'Partida eliminada' : 'Partida cancelada');
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  const isIn = direction === 'IN';

  return (
    <Card className="p-0 sm:p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
          className="relative"
        >
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className="input w-60 pl-8" placeholder="Buscar descripción o contraparte" value={q} onChange={(e) => setQ(e.target.value)} />
          {query && (
            <button
              type="button"
              className="absolute right-2 top-2.5 text-slate-400"
              onClick={() => {
                setQ('');
                setQuery('');
              }}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </form>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="open">Pendientes</option>
          <option value="closed">Liquidadas / canceladas</option>
          <option value="all">Todas</option>
        </select>
        {!isIn && (
          <select className="input w-auto" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            <option value="ALL">Toda prioridad</option>
            <option value="FIXED">Inamovibles</option>
            <option value="FLEXIBLE">Flexibles / negociables</option>
          </select>
        )}
        <div className="ml-auto flex items-center gap-3">
          {totals.map(([cur, v]) => (
            <span key={cur} className="text-sm text-slate-500">
              Pendiente: <strong className="tabular-nums text-slate-900 dark:text-white">{formatMoney(v, cur)}</strong>
            </span>
          ))}
          <Button variant="primary" onClick={() => setForm({ open: true, ob: null })}>
            <Plus className="h-4 w-4" /> {isIn ? 'Nueva CxC' : 'Nueva CxP'}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="p-4">
          <ErrorBox message={error} />
        </div>
      ) : loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title={isIn ? 'No hay cuentas por cobrar' : 'No hay cuentas por pagar'}>Crea una con el botón de arriba.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <th className="th">Descripción</th>
                <th className="th">Vencimiento</th>
                <th className="th">Esperada</th>
                <th className="th text-right">Monto</th>
                <th className="th text-right">Abonado</th>
                <th className="th text-right">Pendiente</th>
                <th className="th">Estado</th>
                <th className="th text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const e = app.entityById.get(o.entityId);
                const cur = e?.currency ?? 'HNL';
                const overdue = (o.status === 'OPEN' || o.status === 'PARTIAL') && o.expectedDate < app.today;
                const closed = o.status === 'SETTLED' || o.status === 'CANCELLED';
                const st = STATUS_LABEL[o.status];
                return (
                  <tr key={o.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="td max-w-xs">
                      <div className="flex items-center gap-2">
                        {app.ctx === 'all' && e && <EntityDot color={e.color} />}
                        <span className="truncate font-medium">{o.description}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
                        {o.counterparty?.name ?? 'Sin contraparte'}
                        {o.isHypothetical && <Badge tone="violet">Hipotética</Badge>}
                        {o.recurrenceId && <Badge tone="blue">Recurrente</Badge>}
                        {!isIn && <Badge tone={o.priority === 'FIXED' ? 'amber' : 'slate'}>{o.priority === 'FIXED' ? 'Inamovible' : 'Flexible'}</Badge>}
                      </div>
                    </td>
                    <td className="td text-slate-500">{formatShortDate(o.dueDate)}</td>
                    <td className={cn('td', overdue && 'font-semibold text-rose-600')}>
                      {formatShortDate(o.expectedDate)}
                      {overdue && <div className="text-[11px]">Vencida</div>}
                    </td>
                    <td className="td num">{formatMoney(o.amount, cur)}</td>
                    <td className="td num text-slate-500">{o.paid ? formatMoney(o.paid, cur) : '—'}</td>
                    <td className={cn('td num font-semibold', isIn ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400')}>
                      {formatMoney(o.remaining, cur)}
                    </td>
                    <td className="td">
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                    <td className="td">
                      <div className="flex justify-end gap-0.5">
                        {!closed && !o.isHypothetical && (
                          <>
                            <Button size="sm" variant="ghost" title={isIn ? 'Marcar cobrado' : 'Marcar pagado'} onClick={() => setPay({ ob: o, full: true })}>
                              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                            </Button>
                            <Button size="sm" variant="ghost" title="Abono parcial" onClick={() => setPay({ ob: o, full: false })}>
                              <Coins className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        {!closed && (
                          <Button size="sm" variant="ghost" title="Reprogramar" onClick={() => setMove(o)}>
                            <CalendarClock className="h-4 w-4" />
                          </Button>
                        )}
                        {o.status !== 'CANCELLED' && (
                          <Button size="sm" variant="ghost" title="Editar" onClick={() => setForm({ open: true, ob: o })}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {!closed && (
                          <Button size="sm" variant="ghost" title={o.isHypothetical ? 'Eliminar' : 'Cancelar'} onClick={() => cancel(o)}>
                            {o.isHypothetical ? <Trash2 className="h-4 w-4 text-rose-500" /> : <Ban className="h-4 w-4 text-rose-500" />}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ObligationFormModal open={form.open} onClose={() => setForm({ open: false, ob: null })} direction={direction} obligation={form.ob} hypothetical={app.whatIf} />
      <PaymentModal open={Boolean(pay)} onClose={() => setPay(null)} target={pay?.ob ?? null} full={pay?.full} />
      <RescheduleModal open={Boolean(move)} onClose={() => setMove(null)} target={move} />
    </Card>
  );
}

const FREQ: Record<string, string> = { WEEKLY: 'Semanal', BIWEEKLY: 'Quincenal', MONTHLY: 'Mensual', YEARLY: 'Anual' };

function RulesTab() {
  const app = useApp();
  const toast = useToast();
  const { data, error, loading } = useApi<RuleDto[]>(`/api/recurrences?ctx=${encodeURIComponent(app.ctx)}`);
  const [creating, setCreating] = useState(false);

  async function toggle(r: RuleDto, active: boolean) {
    try {
      await api(`/api/recurrences/${r.id}`, { method: 'PATCH', body: { active } });
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  return (
    <Card className="p-0 sm:p-0">
      <div className="flex items-center justify-between border-b border-slate-200 p-3 dark:border-slate-800">
        <p className="text-sm text-slate-500">Las ocurrencias futuras se proyectan automáticamente desde hoy.</p>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Nueva recurrencia
        </Button>
      </div>
      {error ? (
        <div className="p-4">
          <ErrorBox message={error} />
        </div>
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <EmptyState title="Sin recurrencias">Ej.: planilla quincenal, alquiler mensual, iguala de clientes.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <th className="th">Descripción</th>
                <th className="th">Tipo</th>
                <th className="th">Frecuencia</th>
                <th className="th">Desde</th>
                <th className="th">Hasta</th>
                <th className="th text-right">Monto</th>
                <th className="th">Activa</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => {
                const e = app.entityById.get(r.entityId);
                return (
                  <tr key={r.id} className={cn('border-t border-slate-100 dark:border-slate-800', !r.active && 'opacity-50')}>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        {app.ctx === 'all' && e && <EntityDot color={e.color} />}
                        <span className="font-medium">{r.description}</span>
                        {r.direction === 'OUT' && r.priority === 'FIXED' && <Badge tone="amber">Inamovible</Badge>}
                      </div>
                      <div className="text-xs text-slate-500">{r.counterparty?.name ?? ''}</div>
                    </td>
                    <td className="td">{r.direction === 'IN' ? <Badge tone="green">Ingreso</Badge> : <Badge tone="red">Gasto</Badge>}</td>
                    <td className="td">{FREQ[r.frequency]}</td>
                    <td className="td">{formatShortDate(r.startDate)}</td>
                    <td className="td">{r.endDate ? formatShortDate(r.endDate) : 'Indefinido'}</td>
                    <td className="td num font-semibold">{formatMoney(r.amount, e?.currency ?? 'HNL')}</td>
                    <td className="td">
                      <Toggle checked={r.active} onChange={(v) => toggle(r, v)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <RecurrenceFormModal open={creating} onClose={() => setCreating(false)} />
    </Card>
  );
}

interface TransferRow {
  id: string;
  kind: 'LOAN' | 'CONTRIBUTION' | 'TRANSFER';
  status: 'PLANNED' | 'EXECUTED' | 'CANCELLED';
  fromEntityId: string;
  toEntityId: string;
  amountFrom: number;
  amountTo: number;
  expectedDate: string;
  executedDate: string | null;
  description: string | null;
}

const KIND: Record<string, string> = { LOAN: 'Préstamo', CONTRIBUTION: 'Aporte', TRANSFER: 'Transferencia' };

function TransfersTab() {
  const app = useApp();
  const toast = useToast();
  const { data, error, loading } = useApi<TransferRow[]>(`/api/transfers?ctx=${encodeURIComponent(app.ctx)}`);
  const [creating, setCreating] = useState(false);
  const [executing, setExecuting] = useState<TransferRow | null>(null);

  async function cancel(t: TransferRow) {
    if (!confirm('¿Cancelar esta transferencia planificada?')) return;
    try {
      await api(`/api/transfers/${t.id}`, { body: { action: 'cancel' } });
      toast('Transferencia cancelada');
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  const canTransfer = app.activeEntities.length >= 2;

  return (
    <Card className="p-0 sm:p-0">
      <div className="flex items-center justify-between border-b border-slate-200 p-3 dark:border-slate-800">
        <p className="text-sm text-slate-500">En la vista consolidada estos movimientos se netean y no inflan ingresos ni gastos.</p>
        <Button variant="primary" onClick={() => setCreating(true)} disabled={!canTransfer} title={canTransfer ? '' : 'Necesitas al menos dos entidades'}>
          <Plus className="h-4 w-4" /> Nueva transferencia
        </Button>
      </div>
      {error ? (
        <div className="p-4">
          <ErrorBox message={error} />
        </div>
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <EmptyState title="Sin transferencias entre entidades" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <th className="th">Tipo</th>
                <th className="th">Origen → destino</th>
                <th className="th">Fecha</th>
                <th className="th text-right">Sale</th>
                <th className="th text-right">Entra</th>
                <th className="th">Estado</th>
                <th className="th text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {data.map((t) => {
                const from = app.entityById.get(t.fromEntityId);
                const to = app.entityById.get(t.toEntityId);
                return (
                  <tr key={t.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="td">
                      <div className="font-medium">{KIND[t.kind]}</div>
                      <div className="text-xs text-slate-500">{t.description}</div>
                    </td>
                    <td className="td">
                      <span className="inline-flex items-center gap-1.5">
                        {from && <EntityDot color={from.color} />} {from?.name ?? '—'} → {to && <EntityDot color={to.color} />} {to?.name ?? '—'}
                      </span>
                    </td>
                    <td className="td">{formatShortDate(t.executedDate ?? t.expectedDate)}</td>
                    <td className="td num">{formatMoney(t.amountFrom, from?.currency ?? 'HNL')}</td>
                    <td className="td num">{formatMoney(t.amountTo, to?.currency ?? 'HNL')}</td>
                    <td className="td">
                      <Badge tone={t.status === 'EXECUTED' ? 'green' : t.status === 'CANCELLED' ? 'red' : 'slate'}>
                        {t.status === 'EXECUTED' ? 'Ejecutada' : t.status === 'CANCELLED' ? 'Cancelada' : 'Planificada'}
                      </Badge>
                    </td>
                    <td className="td">
                      {t.status === 'PLANNED' && (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" onClick={() => setExecuting(t)}>
                            <Send className="h-3.5 w-3.5" /> Ejecutar
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => cancel(t)} title="Cancelar">
                            <Ban className="h-4 w-4 text-rose-500" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <TransferFormModal open={creating} onClose={() => setCreating(false)} />
      <ExecuteTransferModal open={Boolean(executing)} onClose={() => setExecuting(null)} transfer={executing} />
    </Card>
  );
}
