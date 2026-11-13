'use client';

import { Fragment, useMemo, useState } from 'react';
import { Ban, CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Coins, CreditCard, Pencil, Plus, Search, Send, Trash2, X } from 'lucide-react';
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
import { CardChargeModal, CardPaymentModal, cardStatusBadge, type CardPaymentTarget } from '@/components/cards';
import type { CardSummaryDto } from '@/lib/server/cards';
import { formatMoney } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import type { ObligationDto, RuleDto } from '@/lib/server/dto';

type Tab = 'IN' | 'OUT' | 'cards' | 'rules' | 'transfers';

export default function OperationsPage() {
  const [tab, setTab] = useState<Tab>('IN');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Gestión operativa</h1>
          <p className="text-sm text-slate-500">Cuentas por cobrar, por pagar, tarjetas de crédito, recurrencias y transferencias entre entidades.</p>
        </div>
        <Tabs<Tab>
          tabs={[
            { id: 'IN', label: 'Por cobrar' },
            { id: 'OUT', label: 'Por pagar' },
            { id: 'cards', label: 'Tarjetas' },
            { id: 'rules', label: 'Recurrentes' },
            { id: 'transfers', label: 'Transferencias' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {(tab === 'IN' || tab === 'OUT') && <ObligationsTab key={tab} direction={tab} />}
      {tab === 'cards' && <CardsTab />}
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
  const [charging, setCharging] = useState(false);

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
          {!isIn && (
            <Button onClick={() => setCharging(true)}>
              <CreditCard className="h-4 w-4" /> Gasto con tarjeta
            </Button>
          )}
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
      {!isIn && <CardChargeModal open={charging} onClose={() => setCharging(false)} />}
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

// ---------------------------------------------------------------- Tarjetas de crédito
interface StatementItem {
  installmentId: string;
  currency: string;
  rateAtTx: string | null;
  description: string;
  categoryName: string | null;
  counterpartyName: string | null;
  purchaseDate: string;
  chargeAmount: number;
  isOpening: boolean;
  openingKind: 'STATEMENT' | 'UNBILLED' | null;
  fromObligation: boolean;
  number: number;
  count: number;
  amount: number;
  pending: number;
}

function CardsTab() {
  const app = useApp();
  const { data, error, loading } = useApi<CardSummaryDto[]>(`/api/cards?ctx=${encodeURIComponent(app.ctx)}`);
  const [charge, setCharge] = useState<{ cardId: string; entityId: string } | null>(null);
  const [pay, setPay] = useState<CardPaymentTarget | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const cards = (data ?? []).filter((c) => !c.archived);

  if (error) return <ErrorBox message={error} />;
  if (loading && !data) return <Loading />;
  if (cards.length === 0)
    return (
      <Card>
        <EmptyState title="Sin tarjetas de crédito">
          Crea una en Configuración → Cuentas con el tipo &quot;Tarjeta de crédito&quot;, su día de corte y su día límite de pago.
        </EmptyState>
      </Card>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          Los consumos no restan caja el día de la compra: se proyectan como un solo pago en la fecha límite de cada estado de cuenta.
        </p>
        <Toggle checked={showPaid} onChange={setShowPaid} label={<span className="text-sm">Mostrar estados pagados</span>} />
      </div>
      {cards.map((c) => {
        const e = app.entityById.get(c.entityId);
        const cur = c.currency ?? e?.currency ?? 'HNL';
        const fc = c.foreignCurrency;
        const usage = c.creditLimit ? Math.min(100, Math.round((c.debt / c.creditLimit) * 100)) : null;
        const usageF = fc && c.creditLimitForeign ? Math.min(100, Math.round((c.debtForeign / c.creditLimitForeign) * 100)) : null;
        const statements = c.statements.filter((s) => showPaid || s.status !== 'PAID');
        /** "L. x + $ y" según las monedas que tenga el monto */
        const both = (m: { base: number; foreign: number }) =>
          fc && m.foreign ? `${m.base ? `${formatMoney(m.base, cur)} + ` : ''}${formatMoney(m.foreign, fc)}` : formatMoney(m.base, cur);
        const first = c.payments[0];
        const lastGroup = !first ? [] : first.groupId ? c.payments.filter((p) => p.groupId === first.groupId) : [first];
        return (
          <Card key={c.id} className="p-0 sm:p-0">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-4 dark:border-slate-800">
              <div>
                <div className="flex items-center gap-2">
                  {app.ctx === 'all' && e && <EntityDot color={e.color} />}
                  <CreditCard className="h-4 w-4 text-slate-400" />
                  <h3 className="font-semibold">{c.name}</h3>
                  {c.institution && <span className="text-sm text-slate-500">{c.institution}</span>}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  Corte día {c.statementDay} · pago día {c.paymentDueDay}
                  {fc && (
                    <>
                      {' '}
                      · <Badge tone="blue">Bimoneda {cur}/{fc}</Badge> · tasa {c.sellRate ?? '—'}
                      {c.customSellRate ? ' (propia)' : ''}
                    </>
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => setCharge({ cardId: c.id, entityId: c.entityId })}>
                  <Plus className="h-4 w-4" /> Nuevo consumo
                </Button>
                <Button
                  variant="primary"
                  disabled={c.debt <= 0 && c.debtForeign <= 0}
                  onClick={() => setPay({ cardId: c.id, entityId: c.entityId, suggested: c.nextPayment?.pending })}
                >
                  <CreditCard className="h-4 w-4" /> Registrar pago
                </Button>
              </div>
            </div>
            {fc ? (
              <div className="grid grid-cols-2 gap-4 p-4 lg:grid-cols-5">
                <Stat label={`Saldo en ${cur}`} value={formatMoney(c.debt, cur)} tone="red" />
                <Stat
                  label={`Saldo en ${fc}`}
                  value={formatMoney(c.debtForeign, fc)}
                  tone="red"
                  sub={c.debtForeignInBase === null ? 'Sin tipo de cambio' : `≈ ${formatMoney(c.debtForeignInBase, cur)} @ ${c.sellRate}`}
                />
                <Stat
                  label={`Total consolidado a pagar (${cur})`}
                  value={c.totalToPayBase === null ? '—' : formatMoney(c.totalToPayBase, cur)}
                  tone="red"
                  sub={c.nextPayment ? `Incluye el ciclo en curso y cuotas futuras` : undefined}
                />
                <Stat
                  label="Próxima fecha de pago"
                  value={c.nextPayment ? formatShortDate(c.nextPayment.dueDate) : '—'}
                  sub={
                    c.nextPayment
                      ? `${both({ base: c.nextPayment.pending, foreign: c.nextPayment.pendingForeign })}${c.nextPayment.totalBase !== null && c.nextPayment.pendingForeign ? ` ≈ ${formatMoney(c.nextPayment.totalBase, cur)}` : ''}`
                      : 'Sin pagos pendientes'
                  }
                  tone={c.nextPayment && c.nextPayment.dueDate < app.today ? 'red' : undefined}
                />
                <Stat
                  label="Disponible"
                  value={c.availableTotalBase === null ? 'Sin límite' : formatMoney(c.availableTotalBase, cur)}
                  sub={[
                    c.available !== null ? `${formatMoney(c.available, cur)}${usage !== null ? ` (${usage}% usado)` : ''}` : null,
                    c.availableForeign !== null ? `${formatMoney(c.availableForeign, fc)}${usageF !== null ? ` (${usageF}% usado)` : ''}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined}
                  bar={Math.max(usage ?? 0, usageF ?? 0) || (usage === null && usageF === null ? null : 0)}
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 p-4 lg:grid-cols-3">
                <Stat
                  label={c.nextPayment ? `A pagar el ${formatShortDate(c.nextPayment.dueDate)}` : 'Próximo pago'}
                  value={c.nextPayment ? formatMoney(c.nextPayment.pending, cur) : '—'}
                  sub={c.nextPayment ? (c.nextPayment.dueDate < app.today ? 'Vencido' : 'Estado de cuenta ya cortado') : 'Sin pagos pendientes'}
                  tone="red"
                />
                <Stat
                  label="Saldo total adeudado"
                  value={formatMoney(c.debt, cur)}
                  tone="red"
                  sub={c.pendingInstallments.base !== c.debt ? `Cuotas por pagar: ${formatMoney(c.pendingInstallments.base, cur)}` : 'Incluye el ciclo en curso y cuotas futuras'}
                />
                <Stat
                  label="Disponible"
                  value={c.available === null ? 'Sin límite' : formatMoney(c.available, cur)}
                  sub={usage === null ? undefined : `${usage}% usado de ${formatMoney(c.creditLimit!, cur)}`}
                  bar={usage}
                />
              </div>
            )}
            {c.cycle && <CycleBar cycle={c.cycle} cur={cur} detail={fc && c.currentCycle.foreign ? both(c.currentCycle) : null} />}
            {statements.length > 0 && (
              <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
                <table className="w-full">
                  <thead className="bg-slate-50 dark:bg-slate-800/50">
                    <tr>
                      <th className="th">Estado de cuenta</th>
                      <th className="th">Corte</th>
                      <th className="th text-right">Total</th>
                      <th className="th text-right">Pendiente</th>
                      <th className="th">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statements.map((s) => {
                      const key = `${c.id}:${s.dueDate}`;
                      const open = expanded.has(key);
                      const st = cardStatusBadge[s.status];
                      const items = s.items as StatementItem[];
                      return (
                        <Fragment key={key}>
                          <tr className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40" onClick={() => toggle(key)}>
                            <td className="td font-medium">
                              <span className="inline-flex items-center gap-1">
                                {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                Pago {formatShortDate(s.dueDate)}
                                <span className="text-xs font-normal text-slate-500">({items.length})</span>
                              </span>
                            </td>
                            <td className="td text-slate-500">{formatShortDate(s.statementDate)}</td>
                            <td className="td num">{both(s.total)}</td>
                            <td
                              className="td num font-semibold text-rose-700 dark:text-rose-400"
                              title={fc && s.pending.foreign && s.pendingTotalBase !== null ? `≈ ${formatMoney(s.pendingTotalBase, cur)} @ ${c.sellRate}` : undefined}
                            >
                              {s.pending.base + s.pending.foreign === 0 ? '—' : both(s.pending)}
                              {fc && s.pending.foreign > 0 && s.pendingTotalBase !== null && (
                                <div className="text-[11px] font-normal text-slate-500">≈ {formatMoney(s.pendingTotalBase, cur)}</div>
                              )}
                            </td>
                            <td className="td">
                              <Badge tone={st.tone}>{st.label}</Badge>
                            </td>
                          </tr>
                          {open &&
                            items.map((i) => (
                              <tr key={i.installmentId} className="border-t border-dashed border-slate-100 bg-slate-50/50 text-sm dark:border-slate-800 dark:bg-slate-800/20">
                                <td className="td pl-10" colSpan={2}>
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span>{i.description}</span>
                                    {i.count > 1 && <Badge tone="blue">Cuota {i.number}/{i.count}</Badge>}
                                    {i.openingKind === 'STATEMENT' && <Badge>Saldo inicial al corte</Badge>}
                                    {i.openingKind === 'UNBILLED' && <Badge>Consumos iniciales desde el corte</Badge>}
                                    {i.fromObligation && <Badge>Desde CxP</Badge>}
                                  </div>
                                  <div className="text-xs text-slate-500">
                                    {formatShortDate(i.purchaseDate)}
                                    {i.categoryName && ` · ${i.categoryName}`}
                                    {i.counterpartyName && ` · ${i.counterpartyName}`}
                                    {i.count > 1 && ` · compra total ${formatMoney(i.chargeAmount, i.currency)}`}
                                    {i.currency !== cur && i.rateAtTx && ` · tasa compra ${i.rateAtTx}`}
                                  </div>
                                </td>
                                <td className="td num text-slate-500">{formatMoney(i.amount, i.currency)}</td>
                                <td className="td num">{i.pending ? formatMoney(i.pending, i.currency) : '—'}</td>
                                <td className="td" />
                              </tr>
                            ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {lastGroup.length > 0 && (
              <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
                Último pago: {formatShortDate(lastGroup[0].date)} desde {lastGroup[0].fromAccountName} ·{' '}
                {lastGroup
                  .map((p) =>
                    p.currency !== cur
                      ? `${formatMoney(p.amount, p.currency)} @ ${p.fxRateApplied} = ${formatMoney(p.bankAmount, cur)}${p.fxDifference ? ` (diferencial cambiario ${p.fxDifference > 0 ? '+' : ''}${formatMoney(p.fxDifference, cur)})` : ''}`
                      : formatMoney(p.amount, cur),
                  )
                  .join(' + ')}
              </p>
            )}
          </Card>
        );
      })}
      <CardChargeModal open={Boolean(charge)} onClose={() => setCharge(null)} entityId={charge?.entityId} cardId={charge?.cardId} />
      <CardPaymentModal open={Boolean(pay)} onClose={() => setPay(null)} target={pay} />
    </div>
  );
}

/** Ciclo de facturación en curso: lo acumulado para el próximo corte, ritmo de gasto y presupuesto. */
function CycleBar({ cycle, cur, detail }: { cycle: NonNullable<CardSummaryDto['cycle']>; cur: string; detail: string | null }) {
  const pct = cycle.budget ? Math.round((cycle.accumulated / cycle.budget) * 100) : null;
  const projPct = cycle.budget ? Math.round((cycle.projectedAtClose / cycle.budget) * 100) : null;
  const over = cycle.budgetLeft !== null && cycle.budgetLeft < 0;
  const willExceed = !over && projPct !== null && projPct > 100;
  return (
    <div className="border-t border-slate-200 bg-slate-50/60 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/20">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          <CalendarClock className="mr-1 inline h-4 w-4 text-slate-400" />
          Ciclo en curso: {formatShortDate(cycle.start)} → corte {formatShortDate(cycle.close)}
          <span className="ml-2 text-xs font-normal text-slate-500">
            {cycle.daysLeft === 0 ? 'corta hoy' : `faltan ${cycle.daysLeft} día${cycle.daysLeft === 1 ? '' : 's'}`} · día {cycle.daysElapsed} de{' '}
            {cycle.daysTotal}
          </span>
        </p>
        <p className="text-xs text-slate-500">
          Se paga el <strong>{formatShortDate(cycle.dueDate)}</strong>
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Stat
          label="Acumulado para el próximo corte"
          value={formatMoney(cycle.accumulated, cur)}
          sub={detail ? `${detail} (convertido a la tasa vigente)` : 'Compras del ciclo + cuotas que caen en este corte'}
          bar={pct === null ? undefined : Math.min(pct, 100)}
        />
        <Stat
          label="Al ritmo actual cerrarías en"
          value={formatMoney(cycle.projectedAtClose, cur)}
          sub={cycle.daysElapsed < 5 ? 'Estimado poco confiable: el ciclo apenas empieza' : 'Si sigues gastando igual hasta el corte'}
          tone={willExceed || over ? 'red' : undefined}
        />
        {cycle.budget !== null ? (
          <Stat
            label={`Presupuesto del ciclo (${formatMoney(cycle.budget, cur)})`}
            value={over ? `Excedido ${formatMoney(-cycle.budgetLeft!, cur)}` : `Quedan ${formatMoney(cycle.budgetLeft!, cur)}`}
            sub={
              over
                ? 'Ya pasaste el tope de este ciclo'
                : `${formatMoney(cycle.dailyAllowance!, cur)} por día hasta el corte${willExceed ? ' · a este ritmo te pasarás' : ''}`
            }
            tone={over || willExceed ? 'red' : undefined}
          />
        ) : (
          <Stat label="Presupuesto del ciclo" value="Sin definir" sub="Defínelo en Configuración → Cuentas → Editar" />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone, bar }: { label: string; value: string; sub?: string; tone?: 'red'; bar?: number | null }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', tone === 'red' && 'text-rose-700 dark:text-rose-400')}>{value}</p>
      {bar !== undefined && bar !== null && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
          <div className={cn('h-full rounded-full', bar >= 90 ? 'bg-rose-500' : bar >= 70 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${bar}%` }} />
        </div>
      )}
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}
