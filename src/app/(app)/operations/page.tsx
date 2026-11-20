'use client';

import { Fragment, useMemo, useState } from 'react';
import { ArrowLeftRight, Ban, Building2, CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Coins, CreditCard, Pencil, Plus, Repeat, Search, Send, SkipForward, Trash2, X } from 'lucide-react';
import { useApp } from '@/components/AppContext';
import { Badge, Button, Card, cn, EmptyState, ErrorBox, Loading, Tabs, Toggle, useToast } from '@/components/ui';
import { EntityDot } from '@/components/AppShell';
import {
  ExecuteTransferModal,
  InterUnitEditModal,
  LoanRepaymentModal,
  InternalTransferModal,
  ObligationFormModal,
  confirmDeleteRecurrence,
  recurrenceDeletedMsg,
  PaymentModal,
  RecurrenceFormModal,
  RescheduleModal,
  TransferFormModal,
} from '@/components/forms';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { InterUnitStatement } from '@/components/InterUnitStatement';
import { AssignChargeModal, CardChargeModal, CardPaymentModal, cardStatusBadge, type AssignChargeTarget, type CardPaymentTarget } from '@/components/cards';
import type { CardSummaryDto } from '@/lib/server/cards';
import type { TransferDto } from '@/lib/server/dto';
import { formatMoney } from '@/lib/money';
import { addDays, addMonths, endOfMonth, formatDateYear, formatShortDate } from '@/lib/dates';
import type { ObligationDto, RuleDto, UpcomingOccurrenceDto } from '@/lib/server/dto';

type Tab = 'IN' | 'OUT' | 'cards' | 'rules' | 'transfers' | 'interunit';

export default function OperationsPage() {
  const [tab, setTab] = useState<Tab>('IN');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Gestión operativa</h1>
          <p className="text-sm text-slate-500">Cuentas por cobrar y por pagar (puntuales y recurrentes), tarjetas de crédito, plantillas recurrentes y transferencias.</p>
        </div>
        <Tabs<Tab>
          tabs={[
            { id: 'IN', label: 'Por cobrar' },
            { id: 'OUT', label: 'Por pagar' },
            { id: 'cards', label: 'Tarjetas' },
            { id: 'rules', label: 'Plantillas recurrentes' },
            { id: 'transfers', label: 'Transferencias' },
            { id: 'interunit', label: 'Entre unidades' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {(tab === 'IN' || tab === 'OUT') && <ObligationsTab key={tab} direction={tab} />}
      {tab === 'cards' && <CardsTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'transfers' && <TransfersTab />}
      {tab === 'interunit' && <InterUnitStatement />}
    </div>
  );
}

type PeriodKey = 'all' | 'month' | 'prev_month' | 'year' | 'prev_year' | 'custom';
const PERIOD_LABEL: Record<PeriodKey, string> = {
  all: 'Todo el período',
  month: 'Este mes',
  prev_month: 'Mes anterior',
  year: 'Este año',
  prev_year: 'Año anterior',
  custom: 'Rango personalizado…',
};
const LIST_LIMIT = 2000;

/** Rango de vencimiento [desde, hasta] de un período (null = sin límite). */
function periodRange(p: PeriodKey, today: string, custom: { from: string; to: string }): { from: string | null; to: string | null } {
  const month0 = `${today.slice(0, 7)}-01`;
  const year = Number(today.slice(0, 4));
  switch (p) {
    case 'month':
      return { from: month0, to: endOfMonth(month0) };
    case 'prev_month': {
      const prev = addMonths(month0, -1);
      return { from: prev, to: endOfMonth(prev) };
    }
    case 'year':
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'prev_year':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    case 'custom':
      return { from: custom.from || null, to: custom.to || null };
    default:
      return { from: null, to: null };
  }
}

const STATUS_LABEL: Record<string, { label: string; tone: 'slate' | 'green' | 'amber' | 'red' }> = {
  OPEN: { label: 'Pendiente', tone: 'slate' },
  PARTIAL: { label: 'Abono parcial', tone: 'amber' },
  SETTLED: { label: 'Liquidada', tone: 'green' },
  CANCELLED: { label: 'Cancelada', tone: 'red' },
};

/** Días hacia adelante en que se listan las ocurrencias recurrentes junto a las CxC/CxP. */
const UPCOMING_DAYS = 90;
/** Días hacia atrás en que se buscan fechas recurrentes nunca registradas (si el período no fija inicio). */
const PAST_LOOKBACK_DAYS = 365;

type Row = { kind: 'ob'; date: string; ob: ObligationDto } | { kind: 'up'; date: string; up: UpcomingOccurrenceDto };

function ObligationsTab({ direction }: { direction: 'IN' | 'OUT' }) {
  const app = useApp();
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'closed' | 'all'>('open');
  const [priority, setPriority] = useState<'ALL' | 'FIXED' | 'FLEXIBLE'>('ALL');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [origin, setOrigin] = useState<'all' | 'single' | 'recurring'>('all');
  const [period, setPeriod] = useState<PeriodKey>('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const range = periodRange(period, app.today, custom);
  // Pendientes: lo más urgente primero. Historial: lo más reciente primero.
  const order = status === 'open' ? 'asc' : 'desc';
  const qs = query ? `&q=${encodeURIComponent(query)}` : '';
  const params = new URLSearchParams({ ctx: app.ctx, direction, status, transfers: 'loans', order, limit: String(LIST_LIMIT) });
  if (query) params.set('q', query);
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const { data, error, loading } = useApi<ObligationDto[]>(`/api/obligations?${params}`);
  // Próximas ocurrencias de recurrencias que aún no existen como CxC/CxP
  // y también las fechas PASADAS que nunca se registraron (desde el inicio del período, o 1 año atrás)
  const showUpcoming = status !== 'closed' && origin !== 'single';
  const upcomingFrom = range.from ?? addDays(app.today, -PAST_LOOKBACK_DAYS);
  const upcoming = useApi<UpcomingOccurrenceDto[]>(
    showUpcoming
      ? `/api/recurrences/upcoming?ctx=${encodeURIComponent(app.ctx)}&direction=${direction}&days=${UPCOMING_DAYS}&from=${upcomingFrom}${qs}`
      : null,
  );
  const [ruleForm, setRuleForm] = useState<{ open: boolean; rule: RuleDto | null }>({ open: false, rule: null });
  const [busy, setBusy] = useState<string | null>(null);

  const [form, setForm] = useState<{ open: boolean; ob: ObligationDto | null }>({ open: false, ob: null });
  const [pay, setPay] = useState<{ ob: ObligationDto; full: boolean; date?: string } | null>(null);
  const [move, setMove] = useState<ObligationDto | null>(null);
  const [charging, setCharging] = useState(false);
  const [loanPay, setLoanPay] = useState<{ id: string; partial: boolean } | null>(null);
  const [interEdit, setInterEdit] = useState<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    const obs: Row[] = (data ?? [])
      .filter(
        (o) =>
          (priority === 'ALL' || o.priority === priority) &&
          (app.whatIf || !o.isHypothetical) &&
          (origin === 'all' || (origin === 'recurring') === Boolean(o.recurrenceId)),
      )
      .map((ob) => ({ kind: 'ob', date: ob.expectedDate, ob }));
    const ups: Row[] = showUpcoming
      ? (upcoming.data ?? [])
          .filter(
            (u) =>
              (priority === 'ALL' || u.priority === priority) &&
              (!range.from || u.date >= range.from) &&
              (!range.to || u.date <= range.to),
          )
          .map((up) => ({ kind: 'up', date: up.date, up }))
      : [];
    // Orden estable: a igual fecha, la partida real antes que la proyectada
    const dir = order === 'asc' ? 1 : -1;
    return [...obs, ...ups].sort((a, b) => (a.date < b.date ? -dir : a.date > b.date ? dir : 0));
  }, [data, upcoming.data, showUpcoming, priority, origin, app.whatIf, range.from, range.to, order]);

  /** Totales del período por moneda (sin hipotéticas ni canceladas). */
  const totals = useMemo(() => {
    const real = new Map<string, { amount: number; paid: number; remaining: number; count: number }>();
    const projected = new Map<string, number>();
    const unregistered = new Map<string, { amount: number; count: number }>();
    for (const r of rows) {
      if (r.kind === 'up') {
        const cur = app.entityById.get(r.up.entityId)?.currency ?? '—';
        if (r.up.past) {
          const t = unregistered.get(cur) ?? { amount: 0, count: 0 };
          t.amount += r.up.amount;
          t.count++;
          unregistered.set(cur, t);
        } else projected.set(cur, (projected.get(cur) ?? 0) + r.up.amount);
        continue;
      }
      const o = r.ob;
      if (o.isHypothetical || o.status === 'CANCELLED') continue;
      const cur = app.entityById.get(o.entityId)?.currency ?? '—';
      const t = real.get(cur) ?? { amount: 0, paid: 0, remaining: 0, count: 0 };
      t.amount += o.amount;
      t.paid += o.paid;
      t.remaining += o.remaining;
      t.count++;
      real.set(cur, t);
    }
    return { real: Array.from(real.entries()), projected: Array.from(projected.entries()), unregistered: Array.from(unregistered.entries()) };
  }, [rows, app.entityById]);

  /** Convierte la ocurrencia proyectada en una CxC/CxP real para poder operarla. */
  async function materialize(u: UpcomingOccurrenceDto): Promise<ObligationDto | null> {
    setBusy(u.key);
    try {
      return await api<ObligationDto>(`/api/recurrences/${u.ruleId}/materialize`, { body: { date: u.date } });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function onUpcoming(u: UpcomingOccurrenceDto, action: 'pay' | 'partial' | 'move' | 'edit' | 'skip') {
    if (
      action === 'skip' &&
      !confirm(`¿Omitir la ocurrencia del ${formatShortDate(u.date)} de "${u.description}"? Las demás fechas de la recurrencia no cambian.`)
    )
      return;
    const ob = await materialize(u);
    if (!ob) return;
    if (action === 'skip') {
      try {
        await api(`/api/obligations/${ob.id}`, { method: 'PATCH', body: { status: 'CANCELLED' } });
        toast('Ocurrencia omitida');
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Error', 'error');
      }
    } else if (action === 'pay' || action === 'partial') setPay({ ob, full: action === 'pay', date: u.past ? u.date : undefined });
    else if (action === 'move') setMove(ob);
    else setForm({ open: true, ob });
    emitDataChanged();
  }

  async function editRule(ruleId: string) {
    try {
      const list = await api<RuleDto[]>(`/api/recurrences?ctx=${encodeURIComponent(app.ctx)}`);
      const rule = list.find((r) => r.id === ruleId);
      if (!rule) throw new Error('Recurrencia no encontrada');
      setRuleForm({ open: true, rule });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  async function cancel(o: ObligationDto) {
    const msg = o.recurrenceId
      ? `¿Omitir la fecha ${o.expectedDate} de "${o.description}"? Las demás fechas de la recurrencia no cambian.`
      : `¿Cancelar "${o.description}"? Dejará de proyectarse y queda en el historial como cancelada.`;
    if (!confirm(msg)) return;
    try {
      await api(`/api/obligations/${o.id}`, { method: 'PATCH', body: { status: 'CANCELLED' } });
      toast(o.recurrenceId ? 'Fecha omitida' : 'Partida cancelada');
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  async function cancelLoan(o: ObligationDto) {
    if (!o.interUnit) return;
    if (!confirm(`¿Cancelar el saldo pendiente de "${o.description}"? Se cancela en ambas unidades; los abonos ya hechos se conservan.`)) return;
    try {
      await api(`/api/transfers/${o.interUnit.transferId}`, { body: { action: 'cancel' } });
      toast(o.interUnit?.kind === 'REIMBURSEMENT' ? 'Saldo del reembolso cancelado' : 'Saldo del préstamo cancelado');
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  async function remove(o: ObligationDto) {
    if (!confirm(`¿Eliminar definitivamente "${o.description}"? No queda en el historial y no se puede deshacer.`)) return;
    try {
      await api(`/api/obligations/${o.id}`, { method: 'DELETE' });
      toast('Partida eliminada');
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
        <select className="input w-auto" value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)}>
          <option value="all">Puntuales y recurrentes</option>
          <option value="single">Solo puntuales</option>
          <option value="recurring">Solo recurrentes</option>
        </select>
        <select className="input w-auto" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} title="Período por fecha de vencimiento">
          {(Object.keys(PERIOD_LABEL) as PeriodKey[]).map((k) => (
            <option key={k} value={k}>
              {PERIOD_LABEL[k]}
            </option>
          ))}
        </select>
        {period === 'custom' && (
          <span className="flex items-center gap-1 text-sm text-slate-500">
            <input className="input w-auto" type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} aria-label="Desde" />
            <span>a</span>
            <input className="input w-auto" type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} aria-label="Hasta" />
          </span>
        )}
        {!isIn && (
          <select className="input w-auto" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            <option value="ALL">Toda prioridad</option>
            <option value="FIXED">Inamovibles</option>
            <option value="FLEXIBLE">Flexibles / negociables</option>
          </select>
        )}
        <div className="ml-auto flex items-center gap-3">
          {!isIn && (
            <Button onClick={() => setCharging(true)}>
              <CreditCard className="h-4 w-4" /> Gasto con tarjeta
            </Button>
          )}
          <Button onClick={() => setRuleForm({ open: true, rule: null })} title={isIn ? 'Nuevo ingreso recurrente' : 'Nuevo gasto recurrente'}>
            <Repeat className="h-4 w-4" /> Recurrente
          </Button>
          <Button variant="primary" onClick={() => setForm({ open: true, ob: null })}>
            <Plus className="h-4 w-4" /> {isIn ? 'Nueva CxC' : 'Nueva CxP'}
          </Button>
        </div>
      </div>

      {(totals.real.length > 0 || totals.projected.length > 0) && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-slate-200 bg-slate-50/60 px-3 py-2 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-800/30">
          {totals.real.map(([cur, t]) => (
            <span key={cur} className="flex flex-wrap gap-x-4">
              <span>
                {t.count} partida{t.count === 1 ? '' : 's'}
                {range.from || range.to ? ` · ${PERIOD_LABEL[period].replace('…', '')}` : ''}
              </span>
              <span>
                Monto: <strong className="tabular-nums text-slate-900 dark:text-white">{formatMoney(t.amount, cur)}</strong>
              </span>
              <span>
                {isIn ? 'Cobrado' : 'Pagado'}: <strong className="tabular-nums text-slate-900 dark:text-white">{formatMoney(t.paid, cur)}</strong>
              </span>
              <span>
                Pendiente:{' '}
                <strong className={cn('tabular-nums', isIn ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400')}>
                  {formatMoney(t.remaining, cur)}
                </strong>
              </span>
            </span>
          ))}
          {totals.projected.map(([cur, v]) => (
            <span key={`p-${cur}`} title={`Ocurrencias recurrentes de los próximos ${UPCOMING_DAYS} días que aún no se han registrado`}>
              Recurrentes {UPCOMING_DAYS} d: <strong className="tabular-nums text-sky-700 dark:text-sky-400">{formatMoney(v, cur)}</strong>
            </span>
          ))}
          {totals.unregistered.map(([cur, t]) => (
            <span
              key={`u-${cur}`}
              title="Fechas pasadas de recurrencias que nunca se registraron como cobradas/pagadas ni se omitieron. No afectan la proyección."
            >
              Recurrentes sin registrar ({t.count}):{' '}
              <strong className="tabular-nums text-amber-700 dark:text-amber-400">{formatMoney(t.amount, cur)}</strong>
            </span>
          ))}
        </div>
      )}
      {data && data.length >= LIST_LIMIT && (
        <p className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          Se muestran las primeras {LIST_LIMIT} partidas. Acota el período para ver el resto.
        </p>
      )}

      {error || upcoming.error ? (
        <div className="p-4">
          <ErrorBox message={(error || upcoming.error)!} />
        </div>
      ) : (loading && !data) || (showUpcoming && upcoming.loading && !upcoming.data) ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title={isIn ? 'No hay cuentas por cobrar' : 'No hay cuentas por pagar'}>
          {range.from || range.to || status !== 'open' ? 'Nada en este período o filtro.' : 'Crea una con los botones de arriba.'}
        </EmptyState>
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
              {rows.map((row) => {
                if (row.kind === 'up') {
                  const u = row.up;
                  const ue = app.entityById.get(u.entityId);
                  const ucur = ue?.currency ?? 'HNL';
                  const dis = busy === u.key;
                  return (
                    <tr
                      key={`up:${u.key}`}
                      className={cn(
                        'border-t border-slate-100 dark:border-slate-800',
                        u.past ? 'bg-amber-50/50 dark:bg-amber-950/10' : 'bg-sky-50/40 dark:bg-sky-950/10',
                      )}
                    >
                      <td className="td max-w-xs">
                        <div className="flex items-center gap-2">
                          {app.ctx === 'all' && ue && <EntityDot color={ue.color} />}
                          <span className="truncate font-medium">{u.description}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
                          {u.counterparty?.name ?? 'Sin contraparte'}
                          <Badge tone="blue">Recurrente · {FREQ[u.frequency]}</Badge>
                          {!isIn && <Badge tone={u.priority === 'FIXED' ? 'amber' : 'slate'}>{u.priority === 'FIXED' ? 'Inamovible' : 'Flexible'}</Badge>}
                        </div>
                      </td>
                      <td className="td text-slate-500">{formatDateYear(u.date, app.today)}</td>
                      <td className="td">{formatDateYear(u.date, app.today)}</td>
                      <td className="td num">{formatMoney(u.amount, ucur)}</td>
                      <td className="td num text-slate-500">—</td>
                      <td className={cn('td num font-semibold', isIn ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400')}>
                        {formatMoney(u.amount, ucur)}
                      </td>
                      <td className="td">
                        {u.past ? (
                          <span title="Esta fecha ya pasó y no se registró: márcala como cobrada/pagada (con su fecha real) u omítela">
                            <Badge tone="amber">Sin registrar</Badge>
                          </span>
                        ) : (
                          <Badge tone="blue">Programada</Badge>
                        )}
                      </td>
                      <td className="td">
                        <div className="flex justify-end gap-0.5">
                          <Button size="sm" variant="ghost" disabled={dis} title={isIn ? 'Marcar cobrado' : 'Marcar pagado'} onClick={() => onUpcoming(u, 'pay')}>
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          </Button>
                          <Button size="sm" variant="ghost" disabled={dis} title="Abono parcial" onClick={() => onUpcoming(u, 'partial')}>
                            <Coins className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" disabled={dis} title="Reprogramar esta fecha" onClick={() => onUpcoming(u, 'move')}>
                            <CalendarClock className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" disabled={dis} title="Editar solo esta ocurrencia" onClick={() => onUpcoming(u, 'edit')}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" disabled={dis} title="Editar la recurrencia (todas las fechas futuras)" onClick={() => editRule(u.ruleId)}>
                            <Repeat className="h-4 w-4 text-sky-600" />
                          </Button>
                          <Button size="sm" variant="ghost" disabled={dis} title="Omitir esta ocurrencia" onClick={() => onUpcoming(u, 'skip')}>
                            <SkipForward className="h-4 w-4 text-rose-500" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                }
                const o = row.ob;
                const e = app.entityById.get(o.entityId);
                const cur = e?.currency ?? 'HNL';
                const overdue = (o.status === 'OPEN' || o.status === 'PARTIAL') && o.expectedDate < app.today;
                const closed = o.status === 'SETTLED' || o.status === 'CANCELLED';
                const st = STATUS_LABEL[o.status];
                const lastPay = o.payments[o.payments.length - 1];
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
                        {o.interUnit && (
                          <Badge tone="violet">{o.interUnit.kind === 'LOAN' ? 'Préstamo entre unidades' : 'Reembolso entre unidades'}</Badge>
                        )}
                        {!isIn && <Badge tone={o.priority === 'FIXED' ? 'amber' : 'slate'}>{o.priority === 'FIXED' ? 'Inamovible' : 'Flexible'}</Badge>}
                      </div>
                    </td>
                    <td className="td whitespace-nowrap text-slate-500">{formatDateYear(o.dueDate, app.today)}</td>
                    <td className={cn('td whitespace-nowrap', overdue && 'font-semibold text-rose-600')}>
                      {formatDateYear(o.expectedDate, app.today)}
                      {overdue && <div className="text-[11px]">Vencida</div>}
                    </td>
                    <td className="td num">{formatMoney(o.amount, cur)}</td>
                    <td className="td num text-slate-500">
                      {o.paid ? formatMoney(o.paid, cur) : '—'}
                      {lastPay && (
                        <div className="text-[11px] font-normal" title={`Último ${isIn ? 'cobro' : 'pago'} · ${lastPay.accountName}`}>
                          {formatDateYear(lastPay.date, app.today)} · {lastPay.accountName}
                        </div>
                      )}
                    </td>
                    <td className={cn('td num font-semibold', isIn ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400')}>
                      {formatMoney(o.remaining, cur)}
                    </td>
                    <td className="td">
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                    <td className="td">
                      {o.interUnit ? (
                        <div className="flex justify-end gap-0.5">
                          {!closed && (
                            <>
                              <Button size="sm" variant="ghost" title="Saldar todo lo pendiente" onClick={() => setLoanPay({ id: o.interUnit!.transferId, partial: false })}>
                                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                              </Button>
                              <Button size="sm" variant="ghost" title="Registrar abono" onClick={() => setLoanPay({ id: o.interUnit!.transferId, partial: true })}>
                                <Coins className="h-4 w-4" />
                              </Button>
                              <Button size="sm" variant="ghost" title="Reprogramar (ambas unidades)" onClick={() => setMove(o)}>
                                <CalendarClock className="h-4 w-4" />
                              </Button>
                              <Button size="sm" variant="ghost" title="Editar (ambas unidades)" onClick={() => setInterEdit(o.interUnit!.transferId)}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button size="sm" variant="ghost" title="Cancelar el saldo pendiente" onClick={() => cancelLoan(o)}>
                                <Ban className="h-4 w-4 text-rose-500" />
                              </Button>
                            </>
                          )}
                        </div>
                      ) : (
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
                          <Button size="sm" variant="ghost" title={o.recurrenceId ? 'Editar solo esta ocurrencia' : 'Editar'} onClick={() => setForm({ open: true, ob: o })}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {o.recurrenceId && (
                          <Button size="sm" variant="ghost" title="Editar la recurrencia (todas las fechas futuras)" onClick={() => editRule(o.recurrenceId!)}>
                            <Repeat className="h-4 w-4 text-sky-600" />
                          </Button>
                        )}
                        {!closed && !o.isHypothetical && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title={o.recurrenceId ? 'Omitir esta fecha' : 'Cancelar (se conserva en el historial)'}
                            onClick={() => cancel(o)}
                          >
                            {o.recurrenceId ? <SkipForward className="h-4 w-4 text-rose-500" /> : <Ban className="h-4 w-4 text-rose-500" />}
                          </Button>
                        )}
                        {(o.isHypothetical || (o.payments.length === 0 && !o.recurrenceId)) && (
                          <Button size="sm" variant="ghost" title="Eliminar definitivamente" onClick={() => remove(o)}>
                            <Trash2 className="h-4 w-4 text-rose-500" />
                          </Button>
                        )}
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

      <ObligationFormModal open={form.open} onClose={() => setForm({ open: false, ob: null })} direction={direction} obligation={form.ob} hypothetical={app.whatIf} />
      <RecurrenceFormModal
        open={ruleForm.open}
        rule={ruleForm.rule}
        defaultDirection={direction}
        onClose={() => setRuleForm({ open: false, rule: null })}
      />
      <PaymentModal open={Boolean(pay)} onClose={() => setPay(null)} target={pay?.ob ?? null} full={pay?.full} defaultDate={pay?.date} />
      <RescheduleModal open={Boolean(move)} onClose={() => setMove(null)} target={move} />
      <ExecuteTransferModal open={Boolean(loanPay)} onClose={() => setLoanPay(null)} transfer={loanPay} partial={loanPay?.partial} />
      <InterUnitEditModal open={Boolean(interEdit)} onClose={() => setInterEdit(null)} transferId={interEdit} />
      {!isIn && <CardChargeModal open={charging} onClose={() => setCharging(false)} />}
    </Card>
  );
}

const FREQ: Record<string, string> = { WEEKLY: 'Semanal', BIWEEKLY: 'Quincenal', MONTHLY: 'Mensual', YEARLY: 'Anual' };

function RulesTab() {
  const app = useApp();
  const toast = useToast();
  const { data, error, loading } = useApi<RuleDto[]>(`/api/recurrences?ctx=${encodeURIComponent(app.ctx)}`);
  const [form, setForm] = useState<{ open: boolean; rule: RuleDto | null }>({ open: false, rule: null });

  async function removeRule(r: RuleDto) {
    if (!(await confirmDeleteRecurrence(r.description))) return;
    try {
      const res = await api<{ deleted: number; kept: number }>(`/api/recurrences/${r.id}`, { method: 'DELETE' });
      toast(recurrenceDeletedMsg(res));
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

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
        <p className="text-sm text-slate-500">
          Plantillas de ingresos y gastos que se repiten. Sus próximas ocurrencias aparecen en Por cobrar / Por pagar con la etiqueta
          Recurrente.
        </p>
        <Button variant="primary" onClick={() => setForm({ open: true, rule: null })}>
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
                <th className="th" />
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
                    <td className="td">{formatDateYear(r.startDate, app.today)}</td>
                    <td className="td">{r.endDate ? formatDateYear(r.endDate, app.today) : 'Indefinido'}</td>
                    <td className="td num font-semibold">{formatMoney(r.amount, e?.currency ?? 'HNL')}</td>
                    <td className="td">
                      <Toggle checked={r.active} onChange={(v) => toggle(r, v)} />
                    </td>
                    <td className="td text-right">
                      <Button size="sm" variant="ghost" title="Editar" onClick={() => setForm({ open: true, rule: r })}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" title="Eliminar recurrencia" onClick={() => removeRule(r)}>
                        <Trash2 className="h-4 w-4 text-rose-500" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <RecurrenceFormModal open={form.open} rule={form.rule} onClose={() => setForm({ open: false, rule: null })} />
    </Card>
  );
}

type TransferRow = TransferDto;

interface InternalTransferRow {
  id: string;
  entityId: string;
  status: 'EXECUTED' | 'CANCELLED';
  fromAccountName: string;
  toAccountName: string;
  amount: number;
  date: string;
  description: string | null;
}

const KIND: Record<string, string> = { LOAN: 'Préstamo', CONTRIBUTION: 'Aporte', TRANSFER: 'Transferencia' };

function TransfersTab() {
  const app = useApp();
  const toast = useToast();
  const { data, error, loading } = useApi<TransferRow[]>(`/api/transfers?ctx=${encodeURIComponent(app.ctx)}`);
  const internalRows = useApi<InternalTransferRow[]>(`/api/transfers/internal?ctx=${encodeURIComponent(app.ctx)}`);
  const [creating, setCreating] = useState(false);
  const [creatingInternal, setCreatingInternal] = useState(false);
  const [executing, setExecuting] = useState<{ id: string; partial: boolean } | null>(null);
  const [programming, setProgramming] = useState<TransferRow | null>(null);

  async function cancel(t: TransferRow) {
    const msg = t.repaymentOfId || t.isReimbursement
      ? `¿Cancelar el saldo pendiente de ${t.isReimbursement ? 'este reembolso' : 'esta devolución'}? Los abonos ya hechos se conservan.`
      : t.kind === 'LOAN' && t.repayment
        ? '¿Cancelar este préstamo? Su devolución programada también se cancela.'
        : '¿Cancelar esta transferencia planificada?';
    if (!confirm(msg)) return;
    try {
      await api(`/api/transfers/${t.id}`, { body: { action: 'cancel' } });
      toast('Transferencia cancelada');
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  async function voidInternal(t: InternalTransferRow) {
    if (!confirm('¿Anular esta transferencia entre cuentas? Se revierten los saldos de ambas cuentas.')) return;
    try {
      await api(`/api/transfers/internal/${t.id}`, { body: { action: 'void' } });
      toast('Transferencia anulada');
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  const canTransfer = app.activeEntities.length >= 2;

  return (
    <div className="space-y-4">
      <Card className="p-0 sm:p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
          <div>
            <h2 className="font-medium">Entre cuentas de una unidad de negocio</h2>
            <p className="text-sm text-slate-500">Banco → caja chica, entre bancos, etc. Se registra al momento y no cambia la caja total de la unidad de negocio.</p>
          </div>
          <Button variant="primary" onClick={() => setCreatingInternal(true)}>
            <ArrowLeftRight className="h-4 w-4" /> Transferir entre cuentas
          </Button>
        </div>
        {internalRows.error ? (
          <div className="p-4">
            <ErrorBox message={internalRows.error} />
          </div>
        ) : internalRows.loading && !internalRows.data ? (
          <Loading />
        ) : !internalRows.data?.length ? (
          <EmptyState title="Sin transferencias entre cuentas" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <th className="th">Unidad de negocio</th>
                  <th className="th">Cuentas</th>
                  <th className="th">Fecha</th>
                  <th className="th text-right">Monto</th>
                  <th className="th">Estado</th>
                  <th className="th text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {internalRows.data.map((t) => {
                  const ent = app.entityById.get(t.entityId);
                  const voided = t.status === 'CANCELLED';
                  return (
                    <tr key={t.id} className={cn('border-t border-slate-100 dark:border-slate-800', voided && 'opacity-60')}>
                      <td className="td">
                        <span className="inline-flex items-center gap-1.5">
                          {ent && <EntityDot color={ent.color} />} {ent?.name ?? '—'}
                        </span>
                      </td>
                      <td className="td">
                        <div className="font-medium">
                          {t.fromAccountName} → {t.toAccountName}
                        </div>
                        {t.description && <div className="text-xs text-slate-500">{t.description}</div>}
                      </td>
                      <td className="td">{formatDateYear(t.date, app.today)}</td>
                      <td className="td num">{formatMoney(t.amount, ent?.currency ?? 'HNL')}</td>
                      <td className="td">
                        <Badge tone={voided ? 'red' : 'green'}>{voided ? 'Anulada' : 'Ejecutada'}</Badge>
                      </td>
                      <td className="td">
                        {!voided && (
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => voidInternal(t)} title="Anular">
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
      </Card>

      <Card className="p-0 sm:p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
          <div>
            <h2 className="font-medium">Entre unidades de negocio</h2>
            <p className="text-sm text-slate-500">En la vista consolidada estos movimientos se netean y no inflan ingresos ni gastos.</p>
          </div>
          <Button variant="primary" onClick={() => setCreating(true)} disabled={!canTransfer} title={canTransfer ? '' : 'Necesitas al menos dos unidades de negocio'}>
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
        <EmptyState title="Sin transferencias entre unidades de negocio" />
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
                      <div className="font-medium">{t.repaymentOfId ? 'Devolución de préstamo' : t.isReimbursement ? 'Reembolso' : KIND[t.kind]}</div>
                      <div className="text-xs text-slate-500">{t.description}</div>
                      {t.interest > 0 && <div className="text-xs text-slate-500">Incluye interés {formatMoney(t.interest, to?.currency ?? 'HNL')}</div>}
                    </td>
                    <td className="td">
                      <span className="inline-flex items-center gap-1.5">
                        {from && <EntityDot color={from.color} />} {from?.name ?? '—'} → {to && <EntityDot color={to.color} />} {to?.name ?? '—'}
                      </span>
                    </td>
                    <td className="td">{formatDateYear(t.executedDate ?? t.expectedDate, app.today)}</td>
                    <td className="td num">{formatMoney(t.amountFrom, from?.currency ?? 'HNL')}</td>
                    <td className="td num">
                      {formatMoney(t.amountTo, to?.currency ?? 'HNL')}
                      {(t.repaymentOfId || t.isReimbursement) && t.paidTo > 0 && (
                        <div className="text-[11px] font-normal text-slate-500">
                          Abonado {formatMoney(t.paidTo, to?.currency ?? 'HNL')} · resta {formatMoney(t.remainingTo, to?.currency ?? 'HNL')}
                        </div>
                      )}
                    </td>
                    <td className="td">
                      <Badge tone={t.status === 'EXECUTED' ? 'green' : t.status === 'CANCELLED' ? 'red' : t.paidTo > 0 ? 'amber' : 'slate'}>
                        {t.status === 'EXECUTED'
                          ? t.repaymentOfId || t.isReimbursement
                            ? 'Saldada'
                            : 'Ejecutada'
                          : t.status === 'CANCELLED'
                            ? 'Cancelada'
                            : t.paidTo > 0
                              ? 'Con abonos'
                              : 'Planificada'}
                      </Badge>
                      {t.kind === 'LOAN' && !t.repaymentOfId && t.repayment && (
                        <div className="mt-0.5 text-[11px] text-slate-500">Devolución programada</div>
                      )}
                    </td>
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        {t.status === 'PLANNED' && (t.repaymentOfId || t.isReimbursement) && (
                          <>
                            <Button size="sm" onClick={() => setExecuting({ id: t.id, partial: true })}>
                              <Coins className="h-3.5 w-3.5" /> Abonar
                            </Button>
                            <Button size="sm" variant="ghost" title="Saldar todo lo pendiente" onClick={() => setExecuting({ id: t.id, partial: false })}>
                              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                            </Button>
                          </>
                        )}
                        {t.status === 'PLANNED' && !t.repaymentOfId && !t.isReimbursement && (
                          <Button size="sm" onClick={() => setExecuting({ id: t.id, partial: false })}>
                            <Send className="h-3.5 w-3.5" /> Ejecutar
                          </Button>
                        )}
                        {t.kind === 'LOAN' && !t.repaymentOfId && !t.repayment && t.status !== 'CANCELLED' && (
                          <Button size="sm" onClick={() => setProgramming(t)} title="Crear la CxC/CxP de la devolución">
                            <CalendarClock className="h-3.5 w-3.5" /> Programar devolución
                          </Button>
                        )}
                        {t.status === 'PLANNED' && (
                          <Button size="sm" variant="ghost" onClick={() => cancel(t)} title={t.repaymentOfId || t.isReimbursement ? 'Cancelar saldo pendiente' : 'Cancelar'}>
                            <Ban className="h-4 w-4 text-rose-500" />
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
      </Card>
      <TransferFormModal open={creating} onClose={() => setCreating(false)} />
      <ExecuteTransferModal open={Boolean(executing)} onClose={() => setExecuting(null)} transfer={executing} partial={executing?.partial} />
      <LoanRepaymentModal open={Boolean(programming)} onClose={() => setProgramming(null)} loan={programming} />
      <InternalTransferModal open={creatingInternal} onClose={() => setCreatingInternal(false)} />
    </div>
  );
}

// ---------------------------------------------------------------- Tarjetas de crédito
interface StatementItem {
  installmentId: string;
  chargeId: string;
  chargeAmountBase: number;
  reimbursement: { transferId: string; entityId: string; status: string } | null;
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
  const [assign, setAssign] = useState<AssignChargeTarget | null>(null);
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
          Crea una en Ajustes → Cuentas y tarjetas con el tipo &quot;Tarjeta de crédito&quot;, su día de corte y su día límite de pago.
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
                                    {i.reimbursement && (
                                      <Badge tone="violet">
                                        Gasto de {app.entityById.get(i.reimbursement.entityId)?.name ?? 'otra unidad'} ·{' '}
                                        {i.reimbursement.status === 'EXECUTED' ? 'reembolsado' : 'por reembolsar'}
                                      </Badge>
                                    )}
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
                                <td className="td text-right">
                                  {!i.reimbursement && !i.isOpening && !i.fromObligation && i.number === 1 && app.activeEntities.length > 1 && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      title="Este consumo es de otra unidad: asignar el gasto y crear su reembolso"
                                      onClick={() =>
                                        setAssign({
                                          chargeId: i.chargeId,
                                          cardEntityId: c.entityId,
                                          description: i.description,
                                          purchaseDate: i.purchaseDate,
                                          amountBase: i.chargeAmountBase,
                                        })
                                      }
                                    >
                                      <Building2 className="h-4 w-4 text-violet-600" />
                                    </Button>
                                  )}
                                </td>
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
      <AssignChargeModal open={Boolean(assign)} onClose={() => setAssign(null)} target={assign} />
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
          <Stat label="Presupuesto del ciclo" value="Sin definir" sub="Defínelo en Ajustes → Cuentas y tarjetas → Editar" />
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
