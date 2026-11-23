'use client';

import { Fragment, useMemo, useState } from 'react';
import { Ban, Building2, CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Coins, CreditCard, Pencil, Plus, Repeat, Search, SkipForward, Trash2, X } from 'lucide-react';
import { useApp } from '@/components/AppContext';
import { Badge, Button, Card, cn, confirmDialog, EmptyState, ErrorBox, Loading, TableTotals, Tabs, Toggle, useToast } from '@/components/ui';
import { EntityDot } from '@/components/AppShell';
import { CategoryTag } from '@/components/CategorySelect';
import {
  ExecuteTransferModal,
  InterUnitEditModal,
  ObligationFormModal,
  confirmDeleteRecurrence,
  recurrenceDeletedMsg,
  PaymentModal,
  RecurrenceFormModal,
  RescheduleModal,
} from '@/components/forms';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { AssignChargeModal, CardChargeModal, CardPaymentModal, CardPaymentsHistory, cardStatusBadge, type AssignChargeTarget, type CardPaymentTarget } from '@/components/cards';
import type { CardSummaryDto } from '@/lib/server/cards';
import { formatMoney } from '@/lib/money';
import { addDays, addMonths, diffDays, endOfMonth, formatDateYear, formatShortDate } from '@/lib/dates';
import type { ObligationDto, RuleDto, UpcomingOccurrenceDto } from '@/lib/server/dto';

type Tab = 'IN' | 'OUT' | 'cards' | 'rules';

export default function OperationsPage() {
  const [tab, setTab] = useState<Tab>('IN');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Gestión operativa</h1>
          <p className="text-sm text-slate-500">Cuentas por cobrar y por pagar (puntuales y recurrentes), tarjetas de crédito y plantillas recurrentes.</p>
        </div>
        <Tabs<Tab>
          tabs={[
            { id: 'IN', label: 'Por cobrar' },
            { id: 'OUT', label: 'Por pagar' },
            { id: 'cards', label: 'Tarjetas' },
            { id: 'rules', label: 'Plantillas recurrentes' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {(tab === 'IN' || tab === 'OUT') && <ObligationsTab key={tab} direction={tab} />}
      {tab === 'cards' && <CardsTab />}
      {tab === 'rules' && <RulesTab />}
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
  /** '' = todas, 'none' = sin categoría, o el id. */
  const [category, setCategory] = useState('');
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
  if (category) params.set('category', category);
  const { data, error, loading } = useApi<ObligationDto[]>(`/api/obligations?${params}`);
  const catalog = useApi<{ categories: { id: string; entityId: string; name: string; direction: 'IN' | 'OUT' }[] }>(
    `/api/catalog?ctx=${encodeURIComponent(app.ctx)}`,
  );
  const categoryOptions = (catalog.data?.categories ?? []).filter((c) => c.direction === direction);
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
  const curOf = (entityId: string) => app.entityById.get(entityId)?.currency ?? 'HNL';

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
              (app.whatIf || !u.isHypothetical) &&
              (priority === 'ALL' || u.priority === priority) &&
              (!category || (category === 'none' ? !u.category : u.category?.id === category)) &&
              (!range.from || u.date >= range.from) &&
              (!range.to || u.date <= range.to),
          )
          .map((up) => ({ kind: 'up', date: up.date, up }))
      : [];
    // Orden estable: a igual fecha, la partida real antes que la proyectada
    const dir = order === 'asc' ? 1 : -1;
    return [...obs, ...ups].sort((a, b) => (a.date < b.date ? -dir : a.date > b.date ? dir : 0));
  }, [data, upcoming.data, showUpcoming, priority, origin, category, app.whatIf, range.from, range.to, order]);

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
      !(await confirmDialog({
        title: 'Omitir fecha',
        message: `¿Omitir la ocurrencia del ${formatShortDate(u.date)} de "${u.description}"? Las demás fechas de la recurrencia no cambian.`,
        confirmLabel: 'Omitir',
        tone: 'danger',
      }))
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
    if (
      !(await confirmDialog({
        title: o.recurrenceId ? 'Omitir fecha' : 'Cancelar partida',
        message: msg,
        confirmLabel: o.recurrenceId ? 'Omitir' : 'Cancelar partida',
        tone: 'danger',
      }))
    )
      return;
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
    if (
      !(await confirmDialog({
        title: 'Cancelar saldo pendiente',
        message: `¿Cancelar el saldo pendiente de "${o.description}"? Se cancela en ambas unidades; los abonos ya hechos se conservan.`,
        confirmLabel: 'Cancelar saldo',
        tone: 'danger',
      }))
    )
      return;
    try {
      await api(`/api/transfers/${o.interUnit.transferId}`, { body: { action: 'cancel' } });
      toast(o.interUnit?.kind === 'REIMBURSEMENT' ? 'Saldo del reembolso cancelado' : 'Saldo del préstamo cancelado');
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  async function remove(o: ObligationDto) {
    if (
      !(await confirmDialog({
        title: 'Eliminar partida',
        message: `¿Eliminar definitivamente "${o.description}"? No queda en el historial y no se puede deshacer.`,
        confirmLabel: 'Eliminar',
        tone: 'danger',
      }))
    )
      return;
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
        <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)} title="Categoría">
          <option value="">Toda categoría</option>
          <option value="none">Sin categoría</option>
          {categoryOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {app.ctx === 'all' ? ` · ${app.entityById.get(c.entityId)?.name ?? ''}` : ''}
            </option>
          ))}
        </select>
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
                          <CategoryTag category={u.category} />
                          <Badge tone="blue">Recurrente · {FREQ[u.frequency]}</Badge>
                          {u.isHypothetical && <Badge tone="violet">Hipotética</Badge>}
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
                          {!u.isHypothetical && (
                            <>
                              <Button size="sm" variant="ghost" disabled={dis} title={isIn ? 'Marcar cobrado' : 'Marcar pagado'} onClick={() => onUpcoming(u, 'pay')}>
                                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                              </Button>
                              <Button size="sm" variant="ghost" disabled={dis} title="Abono parcial" onClick={() => onUpcoming(u, 'partial')}>
                                <Coins className="h-4 w-4" />
                              </Button>
                            </>
                          )}
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
                        <CategoryTag category={o.category} />
                        {o.expenseDate && <Badge>Gasto del {formatDateYear(o.expenseDate, app.today)}</Badge>}
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
                          {o.status === 'SETTLED' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Editar, deshacer abonos (cuenta equivocada) o eliminar"
                              onClick={() => setInterEdit(o.interUnit!.transferId)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
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
            <TableTotals
              rows={rows}
              note={rows.some((r) => r.kind === 'ob' && r.ob.status === 'CANCELLED') ? 'sin canceladas' : undefined}
              section={(r) => (r.kind === 'ob' && r.ob.status === 'CANCELLED' ? false : null)}
              columns={[
                null,
                null,
                null,
                (r) => (r.kind === 'up' ? { amount: r.up.amount, currency: curOf(r.up.entityId) } : { amount: r.ob.amount, currency: curOf(r.ob.entityId) }),
                (r) => (r.kind === 'up' ? null : { amount: r.ob.paid, currency: curOf(r.ob.entityId) }),
                (r) => (r.kind === 'up' ? { amount: r.up.amount, currency: curOf(r.up.entityId) } : { amount: r.ob.remaining, currency: curOf(r.ob.entityId) }),
                null,
                null,
              ]}
            />
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

const FREQ: Record<string, string> = { DAILY: 'Diaria', WEEKLY: 'Semanal', BIWEEKLY: 'Quincenal', MONTHLY: 'Mensual', YEARLY: 'Anual' };

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
                        {r.isHypothetical && <Badge tone="violet">Hipotética</Badge>}
                      </div>
                      <div className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
                        {r.counterparty?.name ?? ''}
                        <CategoryTag category={r.category} />
                      </div>
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
            <TableTotals
              rows={data}
              note={[
                data.some((r) => !r.active) && 'solo activas',
                !app.whatIf && data.some((r) => r.isHypothetical) && 'sin hipotéticas',
                'por ocurrencia',
              ]
                .filter(Boolean)
                .join(', ')}
              noun={['recurrencia', 'recurrencias']}
              section={(r) => (!r.active || (r.isHypothetical && !app.whatIf) ? false : r.direction === 'IN' ? 'Ingresos' : 'Gastos')}
              columns={[null, null, null, null, null, (r) => ({ amount: r.amount, currency: app.entityById.get(r.entityId)?.currency ?? 'HNL' }), null, null]}
            />
          </table>
        </div>
      )}
      <RecurrenceFormModal open={form.open} rule={form.rule} onClose={() => setForm({ open: false, rule: null })} />
    </Card>
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

/** Días que faltan para el pago a partir de los cuales una tarjeta se abre sola y se marca en ámbar. */
const CARD_DUE_SOON_DAYS = 5;
const CARDS_OPEN_KEY = 'cf.cards.open';

type CardDto = CardSummaryDto;

/** Estado del próximo pago de una tarjeta (lo ya facturado pendiente). */
function cardDue(c: CardDto, today: string) {
  const cut = c.debtByCut;
  const pending = cut.billed.base + cut.billed.foreign > 0;
  const days = pending && cut.billedDueDate ? diffDays(cut.billedDueDate, today) : null;
  const tone: 'red' | 'amber' | 'ok' | 'none' = !pending ? 'none' : days !== null && days < 0 ? 'red' : days !== null && days <= CARD_DUE_SOON_DAYS ? 'amber' : 'ok';
  return { pending, days, tone };
}

function readOpenState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(CARDS_OPEN_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function CardsTab() {
  const app = useApp();
  const { data, error, loading } = useApi<CardSummaryDto[]>(`/api/cards?ctx=${encodeURIComponent(app.ctx)}`);
  const [charge, setCharge] = useState<{ cardId: string; entityId: string } | null>(null);
  const [pay, setPay] = useState<CardPaymentTarget | null>(null);
  const [assign, setAssign] = useState<AssignChargeTarget | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  const [openState, setOpenState] = useState<Record<string, boolean>>(() => (typeof window === 'undefined' ? {} : readOpenState()));
  const saveOpen = (next: Record<string, boolean>) => {
    setOpenState(next);
    try {
      localStorage.setItem(CARDS_OPEN_KEY, JSON.stringify(next));
    } catch {
      /* sin almacenamiento: solo dura en esta visita */
    }
  };

  const cards = (data ?? []).filter((c) => !c.archived);
  const isOpen = (c: CardDto) => openState[c.id] ?? ['red', 'amber'].includes(cardDue(c, app.today).tone);
  const allOpen = cards.length > 0 && cards.every(isOpen);

  /** Totales de todas las tarjetas, por moneda de la unidad (consolidado a la tasa vigente). */
  const summary = useMemo(() => {
    const by = new Map<string, { billed: number; next: number; debt: number; dueDates: Set<string>; cutDates: Set<string>; incomplete: boolean }>();
    for (const c of cards) {
      const cur = c.currency;
      const t = by.get(cur) ?? { billed: 0, next: 0, debt: 0, dueDates: new Set(), cutDates: new Set(), incomplete: false };
      const cut = c.debtByCut;
      if (cut.billedTotalBase === null || cut.nextCutTotalBase === null || c.totalToPayBase === null) t.incomplete = true;
      t.billed += cut.billedTotalBase ?? cut.billed.base;
      t.next += cut.nextCutTotalBase ?? cut.nextCut.base;
      t.debt += c.totalToPayBase ?? c.debt;
      if (cut.billed.base + cut.billed.foreign > 0 && cut.billedDueDate) t.dueDates.add(cut.billedDueDate);
      if (cut.nextCut.base + cut.nextCut.foreign > 0 && cut.nextCutDate) t.cutDates.add(cut.nextCutDate);
      by.set(cur, t);
    }
    return Array.from(by.entries());
  }, [cards]);

  if (error) return <ErrorBox message={error} />;
  if (loading && !data) return <Loading />;
  if (cards.length === 0)
    return (
      <Card>
        <EmptyState title="Sin tarjetas de crédito">
          Crea una en Caja y Bancos → Cuentas con el tipo &quot;Tarjeta de crédito&quot;, su día de corte y su día límite de pago.
        </EmptyState>
      </Card>
    );

  const dates = (set: Set<string>) =>
    Array.from(set)
      .sort()
      .map((d) => formatShortDate(d))
      .join(', ');

  return (
    <div className="space-y-3">
      <Card className="p-0 sm:p-0">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          {summary.map(([cur, t]) => (
            <Fragment key={cur}>
              <SummaryFigure label={t.dueDates.size ? `A pagar ${dates(t.dueDates)}` : 'A pagar'} value={formatMoney(t.billed, cur)} strong />
              <SummaryFigure label={t.cutDates.size ? `Próximo corte ${dates(t.cutDates)}` : 'Próximo corte'} value={formatMoney(t.next, cur)} />
              <SummaryFigure label="Deuda total" value={formatMoney(t.debt, cur)} />
              {t.incomplete && <span className="text-xs text-amber-600">Falta tipo de cambio para consolidar</span>}
            </Fragment>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <Toggle checked={showPaid} onChange={setShowPaid} label={<span className="text-sm">Estados pagados</span>} />
            <Button size="sm" onClick={() => saveOpen(Object.fromEntries(cards.map((c) => [c.id, !allOpen])))}>
              {allOpen ? 'Contraer todo' : 'Expandir todo'}
            </Button>
          </div>
        </div>
        <p className="border-t border-slate-100 px-4 py-1.5 text-[11px] text-slate-500 dark:border-slate-800">
          Montos en dólares convertidos a la tasa vigente. Los consumos no restan caja el día de la compra: se pagan en la fecha límite de cada estado de cuenta.
        </p>
      </Card>

      {cards.map((c) => (
        <CardPanel
          key={c.id}
          card={c}
          open={isOpen(c)}
          onToggle={() => saveOpen({ ...openState, [c.id]: !isOpen(c) })}
          showPaid={showPaid}
          onCharge={() => setCharge({ cardId: c.id, entityId: c.entityId })}
          onPay={() => setPay({ cardId: c.id, entityId: c.entityId, suggested: c.nextPayment?.pending })}
          onAssign={setAssign}
        />
      ))}
      <CardChargeModal open={Boolean(charge)} onClose={() => setCharge(null)} entityId={charge?.entityId} cardId={charge?.cardId} />
      <CardPaymentModal open={Boolean(pay)} onClose={() => setPay(null)} target={pay} />
      <AssignChargeModal open={Boolean(assign)} onClose={() => setAssign(null)} target={assign} />
    </div>
  );
}

function SummaryFigure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cn('tabular-nums', strong ? 'text-lg font-semibold' : 'font-semibold text-slate-700 dark:text-slate-300')}>{value}</p>
    </div>
  );
}

const DUE_TONE = {
  red: 'border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-500/10',
  amber: 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-500/10',
  ok: 'border-slate-200 dark:border-slate-700',
  none: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-500/10',
} as const;

function CardPanel({
  card: c,
  open,
  onToggle,
  showPaid,
  onCharge,
  onPay,
  onAssign,
}: {
  card: CardDto;
  open: boolean;
  onToggle: () => void;
  showPaid: boolean;
  onCharge: () => void;
  onPay: () => void;
  onAssign: (t: AssignChargeTarget) => void;
}) {
  const app = useApp();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const e = app.entityById.get(c.entityId);
  const cur = c.currency ?? e?.currency ?? 'HNL';
  const fc = c.foreignCurrency;
  const cut = c.debtByCut;
  const due = cardDue(c, app.today);
  const statements = c.statements.filter((s) => showPaid || s.status !== 'PAID');
  /** "L. x + $ y" según las monedas que tenga el monto */
  const both = (m: { base: number; foreign: number }) =>
    fc && m.foreign ? `${m.base ? `${formatMoney(m.base, cur)} + ` : ''}${formatMoney(m.foreign, fc)}` : formatMoney(m.base, cur);
  const billedValue = cut.billedTotalBase ?? cut.billed.base;
  const nextValue = cut.nextCutTotalBase ?? cut.nextCut.base;
  const debtValue = c.totalToPayBase ?? c.debt;
  const usage = c.creditLimit ? Math.min(100, Math.round((c.debt / c.creditLimit) * 100)) : null;
  const dueText =
    !due.pending || due.days === null
      ? 'Al día: nada facturado pendiente'
      : due.days < 0
        ? `Vencido hace ${-due.days} día${due.days === -1 ? '' : 's'}`
        : due.days === 0
          ? 'Vence hoy'
          : `Faltan ${due.days} día${due.days === 1 ? '' : 's'}`;
  const canPay = c.debt > 0 || c.debtForeign > 0;

  return (
    <Card className="p-0 sm:p-0">
      {/* Encabezado del acordeón */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onToggle();
          }
        }}
        className="flex cursor-pointer flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/30"
      >
        <div className="flex min-w-[220px] flex-1 items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
          {app.ctx === 'all' && e && <EntityDot color={e.color} />}
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{c.name}</h3>
            <p className="truncate text-xs text-slate-500">
              {[c.institution, `corte ${c.statementDay} / pago ${c.paymentDueDay}`, fc ? `${cur}/${fc}` : null].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        {!open && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <div>
              <span className="text-xs text-slate-500">Al pago {cut.billedDueDate && due.pending ? formatShortDate(cut.billedDueDate) : ''} </span>
              <span
                className={cn(
                  'font-semibold tabular-nums',
                  due.tone === 'red' && 'text-rose-600',
                  due.tone === 'amber' && 'text-amber-600',
                  due.tone === 'none' && 'text-emerald-600',
                )}
              >
                {due.pending ? formatMoney(billedValue, cur) : 'Al día'}
              </span>
              {due.pending && cut.billedPartial && (
                <Badge tone="amber" className="ml-1">
                  Parcial
                </Badge>
              )}
            </div>
            <div>
              <span className="text-xs text-slate-500">Próx. corte {cut.nextCutDate ? formatShortDate(cut.nextCutDate) : ''} </span>
              <span className="font-semibold tabular-nums">{formatMoney(nextValue, cur)}</span>
            </div>
            <div>
              <span className="text-xs text-slate-500">Deuda </span>
              <span className="font-semibold tabular-nums text-rose-700 dark:text-rose-400">{formatMoney(debtValue, cur)}</span>
            </div>
          </div>
        )}
        <div className="flex gap-2" onClick={(ev) => ev.stopPropagation()}>
          {open && (
            <Button onClick={onCharge}>
              <Plus className="h-4 w-4" /> Nuevo consumo
            </Button>
          )}
          <Button variant="primary" size={open ? undefined : 'sm'} disabled={!canPay} onClick={onPay}>
            <CreditCard className="h-4 w-4" /> Registrar pago
          </Button>
        </div>
      </div>

      {open && (
        <>
          <div className="grid gap-3 border-t border-slate-200 p-4 dark:border-slate-800 lg:grid-cols-3">
            {/* 1. Lo que se paga en la próxima fecha */}
            <div className={cn('rounded-xl border p-3', DUE_TONE[due.tone])}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                {due.pending && cut.billedDueDate ? `A pagar el ${formatShortDate(cut.billedDueDate)}` : 'Próximo pago'}
              </p>
              <p
                className={cn(
                  'mt-1 text-2xl font-semibold tabular-nums',
                  due.tone === 'red' && 'text-rose-700 dark:text-rose-400',
                  due.tone === 'amber' && 'text-amber-700 dark:text-amber-400',
                  due.tone === 'none' && 'text-emerald-700 dark:text-emerald-400',
                )}
              >
                {due.pending ? formatMoney(billedValue, cur) : formatMoney(0, cur)}
              </p>
              {due.pending && fc && cut.billed.foreign > 0 && <p className="text-xs text-slate-500">{both(cut.billed)}</p>}
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
                {due.pending && cut.billedPartial && <Badge tone="amber">Pago parcial</Badge>}
                {dueText}
              </p>
            </div>

            {/* 2. Ciclo en curso */}
            <CycleBlock card={c} value={nextValue} detail={fc && cut.nextCut.foreign ? both(cut.nextCut) : null} />

            {/* 3. Deuda total */}
            <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Deuda total</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-rose-700 dark:text-rose-400">{formatMoney(debtValue, cur)}</p>
              {fc && (
                <p className="text-xs text-slate-500">
                  {formatMoney(c.debt, cur)} + {formatMoney(c.debtForeign, fc)}
                  {c.sellRate ? ` @ ${c.sellRate}${c.customSellRate ? ' (propia)' : ''}` : ' · sin tipo de cambio'}
                </p>
              )}
              {cut.later.base + cut.later.foreign > 0 && <p className="text-xs text-slate-500">Incluye cuotas futuras: {both(cut.later)}</p>}
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                Disponible: {c.availableTotalBase === null ? 'sin límite' : formatMoney(c.availableTotalBase, cur)}
                {usage !== null && ` · ${usage}% usado`}
              </p>
              {usage !== null && (
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                  <div className={cn('h-full rounded-full', usage >= 90 ? 'bg-rose-500' : usage >= 70 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${usage}%` }} />
                </div>
              )}
            </div>
          </div>

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
                    const rowOpen = expanded.has(key);
                    const st = cardStatusBadge[s.status];
                    const items = s.items as StatementItem[];
                    return (
                      <Fragment key={key}>
                        <tr className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40" onClick={() => toggle(key)}>
                          <td className="td font-medium">
                            <span className="inline-flex items-center gap-1">
                              {rowOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              Pago {formatShortDate(s.dueDate)}
                              <span className="text-xs font-normal text-slate-500">({items.length})</span>
                            </span>
                          </td>
                          <td className="td text-slate-500">{formatShortDate(s.statementDate)}</td>
                          <td className="td num">{both(s.total)}</td>
                          <td className="td num font-semibold">
                            {s.pending.base + s.pending.foreign === 0 ? '—' : both(s.pending)}
                            {fc && s.pending.foreign > 0 && s.pendingTotalBase !== null && (
                              <div className="text-[11px] font-normal text-slate-500">≈ {formatMoney(s.pendingTotalBase, cur)}</div>
                            )}
                          </td>
                          <td className="td">
                            <Badge tone={st.tone}>{st.label}</Badge>
                          </td>
                        </tr>
                        {rowOpen &&
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
                                      onAssign({
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
          <CardPaymentsHistory cardId={c.id} entityId={c.entityId} currency={cur} payments={c.payments} />
        </>
      )}
    </Card>
  );
}

/** Ciclo de facturación en curso: lo que va al próximo corte, avance del ciclo, ritmo y presupuesto. */
function CycleBlock({ card: c, value, detail }: { card: CardDto; value: number; detail: string | null }) {
  const cur = c.currency;
  const cycle = c.cycle;
  const cutDate = c.debtByCut.nextCutDate;
  if (!cycle) {
    return (
      <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Próximo corte {cutDate ? formatShortDate(cutDate) : ''}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{formatMoney(value, cur)}</p>
        {detail && <p className="text-xs text-slate-500">{detail}</p>}
        <p className="mt-1 text-xs text-slate-500">Configura el día de corte y de pago para ver el avance del ciclo.</p>
      </div>
    );
  }
  const dayPct = Math.min(100, Math.round((cycle.daysElapsed / Math.max(cycle.daysTotal, 1)) * 100));
  const over = cycle.budgetLeft !== null && cycle.budgetLeft < 0;
  const projPct = cycle.budget ? Math.round((cycle.projectedAtClose / cycle.budget) * 100) : null;
  const willExceed = !over && projPct !== null && projPct > 100;
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        Ciclo en curso → corte {formatShortDate(cycle.close)}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{formatMoney(value, cur)}</p>
      {detail && <p className="text-xs text-slate-500">{detail}</p>}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" title={`Día ${cycle.daysElapsed} de ${cycle.daysTotal}`}>
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${dayPct}%` }} />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Día {cycle.daysElapsed} de {cycle.daysTotal} · {cycle.daysLeft === 0 ? 'corta hoy' : `faltan ${cycle.daysLeft} día${cycle.daysLeft === 1 ? '' : 's'}`} · se paga el{' '}
        {formatShortDate(cycle.dueDate)}
      </p>
      <p className={cn('text-xs', willExceed || over ? 'font-medium text-rose-600' : 'text-slate-600 dark:text-slate-400')}>
        Al ritmo actual: {formatMoney(cycle.projectedAtClose, cur)}
        {cycle.daysElapsed < 5 ? ' (estimado poco confiable)' : ''}
      </p>
      <p className={cn('text-xs', over ? 'font-medium text-rose-600' : 'text-slate-600 dark:text-slate-400')}>
        {cycle.budget === null
          ? 'Presupuesto: sin definir'
          : over
            ? `Presupuesto ${formatMoney(cycle.budget, cur)}: excedido ${formatMoney(-cycle.budgetLeft!, cur)}`
            : `Presupuesto ${formatMoney(cycle.budget, cur)}: quedan ${formatMoney(cycle.budgetLeft!, cur)} (${formatMoney(cycle.dailyAllowance!, cur)}/día)`}
      </p>
    </div>
  );
}
