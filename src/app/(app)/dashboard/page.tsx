'use client';

import { AlertTriangle, CalendarClock, Gauge, History, Landmark, TrendingDown, TrendingUp, Wind } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from '@/components/AppContext';
import { Badge, Card, cn, EmptyState, ErrorBox, Loading, Toggle } from '@/components/ui';
import { ProjectionChart } from '@/components/ProjectionChart';
import { EntityDot } from '@/components/AppShell';
import { ItemActionButtons, useItemActions } from '@/components/ItemActions';
import { useProjection } from '@/lib/client/useProjection';
import { formatMoney } from '@/lib/money';
import { addDays, formatLongDate, formatShortDate } from '@/lib/dates';
import type { ProjectedItem } from '@/lib/projection/types';
import { netFlowWithin } from '@/lib/projection/engine';
import type { HistoryResult } from '@/lib/projection/history';
import type { ProjectionResult } from '@/lib/projection/types';
import { useApi } from '@/lib/client/api';
import { formatDateYear } from '@/lib/dates';

function Kpi({
  title,
  value,
  sub,
  icon,
  tone = 'default',
  action,
}: {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: ReactNode;
  tone?: 'default' | 'danger' | 'warning' | 'good';
  /** Control opcional junto al título (p. ej. selector de período). */
  action?: ReactNode;
}) {
  return (
    <Card
      className={cn(
        tone === 'danger' && 'border-rose-300 bg-rose-50/80 dark:border-rose-900 dark:bg-rose-950/30',
        tone === 'warning' && 'border-amber-300 bg-amber-50/80 dark:border-amber-900 dark:bg-amber-950/30',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</p>
        <span className="flex items-center gap-2 text-slate-400">
          {action}
          {icon}
        </span>
      </div>
      <p
        className={cn(
          'mt-2 text-2xl font-semibold tabular-nums',
          tone === 'danger' && 'text-rose-700 dark:text-rose-400',
          tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

const PERIODS = [30, 60, 90] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_KEY = 'dashboard.netFlowDays';

/** Período del flujo neto; se recuerda por navegador (si el almacenamiento falla, 30 días). */
function useNetFlowPeriod(): [Period, (p: Period) => void] {
  const [p, setP] = useState<Period>(30);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(PERIOD_KEY));
      if ((PERIODS as readonly number[]).includes(v)) setP(v as Period);
    } catch {
      /* sin almacenamiento */
    }
  }, []);
  return [
    p,
    (next) => {
      setP(next);
      try {
        localStorage.setItem(PERIOD_KEY, String(next));
      } catch {
        /* sin almacenamiento */
      }
    },
  ];
}

function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <span className="inline-flex overflow-hidden rounded-lg border border-slate-200 text-[11px] font-medium dark:border-slate-700">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            'px-1.5 py-0.5 tabular-nums',
            p === value ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
          )}
        >
          {p}d
        </button>
      ))}
    </span>
  );
}

const SHOW_HISTORY_KEY = 'dashboard.showHistory';

/** Mostrar las 13 semanas reales en la gráfica; se recuerda por navegador (por defecto, no). */
function useShowHistory(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(false);
  useEffect(() => {
    try {
      setV(localStorage.getItem(SHOW_HISTORY_KEY) === '1');
    } catch {
      /* sin almacenamiento */
    }
  }, []);
  return [
    v,
    (next) => {
      setV(next);
      try {
        localStorage.setItem(SHOW_HISTORY_KEY, next ? '1' : '0');
      } catch {
        /* sin almacenamiento */
      }
    },
  ];
}

export default function DashboardPage() {
  const app = useApp();
  const { data, error, loading } = useProjection();
  const history = useApi<HistoryResult>(`/api/history?ctx=${encodeURIComponent(app.ctx)}`);
  const actions = useItemActions();
  const [period, setPeriod] = useNetFlowPeriod();
  const [showHistory, setShowHistory] = useShowHistory();

  if (error) return <ErrorBox message={error} />;
  if (loading || !data) return <Loading />;

  const { result, entities } = data;
  const { kpis, currency } = result;
  const money = (c: number) => formatMoney(c, currency);
  const consolidated = result.consolidated;
  const in7 = addDays(result.today, 7);

  const overdueReceivables = result.items.filter((i) => i.direction === 'IN' && i.overdue);
  const fixedPayables = result.items.filter((i) => i.direction === 'OUT' && i.priority === 'FIXED' && i.date <= in7);
  const lowTone = kpis.lowPointBelowZero ? 'danger' : kpis.lowPointBelowThreshold ? 'warning' : 'default';

  const flow = netFlowWithin(result.items, result.today, period);

  const totalCash = result.byEntity.reduce((s, e) => s + Math.max(e.cash, 0), 0);
  const totalIn = result.byEntity.reduce((s, e) => s + e.inflows13w, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Radar de liquidez</h1>
          <p className="text-sm text-slate-500">
            {consolidated ? 'Vista consolidada' : app.currentEntity?.name} · {formatLongDate(result.today)} · montos en {currency}
          </p>
        </div>
        {result.whatIf && <Badge tone="violet">Escenario simulado</Badge>}
      </div>

      {result.missingRates.length > 0 && (
        <ErrorBox
          message={`Faltan tasas de cambio para: ${result.missingRates.join(', ')}. Esos montos no se incluyen en el consolidado. Configúralas en Configuración → Tasas de cambio.`}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          title="Caja real hoy"
          value={money(kpis.cashToday)}
          sub={
            kpis.cardDebt > 0 ? (
              <>
                Bancos, efectivo y billeteras · <span className="text-rose-600 dark:text-rose-400">Deuda flotante en tarjetas: {money(kpis.cardDebt)}</span>
              </>
            ) : (
              'Bancos, efectivo y billeteras'
            )
          }
          icon={<Landmark className="h-5 w-5" />}
        />
        <Kpi
          title={`Flujo neto ${period} días`}
          value={money(flow.net)}
          tone={flow.net < 0 ? 'danger' : 'good'}
          sub={`Entradas ${formatMoney(flow.inflows, currency, { compact: true })} · Salidas ${formatMoney(flow.outflows, currency, { compact: true })} · hasta ${formatShortDate(flow.end)}`}
          icon={flow.net < 0 ? <TrendingDown className="h-5 w-5" /> : <TrendingUp className="h-5 w-5" />}
          action={<PeriodPicker value={period} onChange={setPeriod} />}
        />
        <Kpi
          title="Runway / oxígeno"
          value={kpis.runwayDays === null ? 'Sin salidas' : `${kpis.runwayDays} días`}
          tone={kpis.runwayDays !== null && kpis.runwayDays < 30 ? 'warning' : 'default'}
          sub="Caja actual ÷ salidas diarias promedio (90 días)"
          icon={<Wind className="h-5 w-5" />}
        />
        <Kpi
          title="Punto más bajo (90 días)"
          value={money(kpis.lowPoint.balance)}
          tone={lowTone}
          sub={
            <>
              {formatLongDate(kpis.lowPoint.date)}
              {kpis.lowPointBelowZero ? ' · ¡Caja negativa!' : kpis.lowPointBelowThreshold ? ` · Bajo el umbral (${money(kpis.threshold)})` : ''}
            </>
          }
          icon={lowTone === 'default' ? <Gauge className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
        />
      </div>

      <Card className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold">{showHistory ? '13 semanas reales + 13 proyectadas' : 'Proyección 13 semanas'}</h2>
            <Toggle checked={showHistory} onChange={setShowHistory} label={<span className="text-xs text-slate-500">Ver 13 semanas atrás</span>} />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
            {showHistory && (
              <span className="flex items-center gap-1">
                <span className="h-0.5 w-4 bg-slate-500" /> Saldo real
              </span>
            )}
            <span className="flex items-center gap-1">
              <span className="h-0.5 w-4 bg-sky-500" /> Saldo proyectado
            </span>
            <span className="flex items-center gap-1">
              <span className="h-0 w-4 border-t-2 border-dashed border-amber-500" /> Umbral mínimo
            </span>
            {consolidated &&
              entities.map((e) => (
                <span key={e.id} className="flex items-center gap-1">
                  <EntityDot color={e.color} /> {e.name}
                </span>
              ))}
          </div>
        </div>
        <ProjectionChart result={result} entities={entities} history={showHistory ? (history.data ?? null) : null} />
        {showHistory && history.data && !history.data.dataStart && (
          <p className="mt-2 text-xs text-slate-500">
            Aún no hay movimientos reales anteriores a esta semana. Para ver historia, lleva la apertura de las cuentas hacia atrás y registra las
            partidas pasadas como cobradas/pagadas.
          </p>
        )}
      </Card>

      {history.error ? <ErrorBox message={history.error} /> : history.data && <HistoryCard history={history.data} projection={result} />}

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="min-w-0 lg:col-span-3">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="h-4 w-4" /> Radar de acción inmediata
          </h2>
          <RadarList
            title="CxC vencidas: cobrar hoy"
            items={overdueReceivables}
            empty="Sin cobros vencidos"
            currency={currency}
            consolidated={consolidated}
            actions={actions}
          />
          <div className="my-4 border-t border-slate-200 dark:border-slate-800" />
          <RadarList
            title="CxP inamovibles: próximos 7 días"
            items={fixedPayables}
            empty="Sin pagos inamovibles esta semana"
            currency={currency}
            consolidated={consolidated}
            actions={actions}
          />
        </Card>

        <Card className="min-w-0 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold">{consolidated ? 'Desglose por origen' : 'Resumen de la unidad de negocio'}</h2>
          <div className="space-y-4">
            {result.byEntity.map((b) => {
              const e = entities.find((x) => x.id === b.entityId);
              if (!e) return null;
              const cashPct = totalCash > 0 ? (Math.max(b.cash, 0) / totalCash) * 100 : 0;
              const inPct = totalIn > 0 ? (b.inflows13w / totalIn) * 100 : 0;
              return (
                <div key={b.entityId}>
                  <div className="mb-1 flex items-center gap-2 text-sm">
                    <EntityDot color={e.color} />
                    <span className="font-medium">{e.name}</span>
                    <span className="ml-auto tabular-nums">{money(b.cash)}</span>
                  </div>
                  {consolidated && (
                    <>
                      <Bar pct={cashPct} color={e.color} label={`${cashPct.toFixed(0)}% de la caja`} />
                      <Bar pct={inPct} color={e.color} label={`${inPct.toFixed(0)}% de las entradas (13 sem.)`} faded />
                    </>
                  )}
                  <p className="mt-1 text-xs text-slate-500">
                    13 sem.: +{formatMoney(b.inflows13w, currency, { compact: true })} / −
                    {formatMoney(b.outflows13w, currency, { compact: true })}
                    {b.cardDebt > 0 && (
                      <span className="text-rose-600 dark:text-rose-400"> · tarjetas: {formatMoney(b.cardDebt, currency, { compact: true })}</span>
                    )}
                  </p>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      {actions.modals}
    </div>
  );
}

function Bar({ pct, color, label, faded }: { pct: number; color: string; label: string; faded?: boolean }) {
  return (
    <div className="mt-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color, opacity: faded ? 0.5 : 1 }} />
      </div>
      <p className="mt-0.5 text-[11px] text-slate-500">{label}</p>
    </div>
  );
}

function RadarList({
  title,
  items,
  empty,
  currency,
  consolidated,
  actions,
}: {
  title: string;
  items: ProjectedItem[];
  empty: string;
  currency: string;
  consolidated: boolean;
  actions: ReturnType<typeof useItemActions>;
}) {
  const app = useApp();
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title} {items.length > 0 && <Badge tone="amber">{items.length}</Badge>}
      </p>
      {items.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {items.slice(0, 8).map((i) => {
            const e = app.entityById.get(i.entityId);
            return (
              <li key={i.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                {consolidated && e && <EntityDot color={e.color} />}
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-sm font-medium">{i.description}</p>
                  <p className="truncate text-xs text-slate-500">
                    {i.cardDetails ? `${i.cardDetails.length} consumo(s) · fecha límite` : (i.counterpartyName ?? '—')} · esperado {formatShortDate(i.expectedDate)}
                    {i.overdue && <span className="ml-1 font-medium text-rose-600">· vencido</span>}
                  </p>
                </div>
                <span className={cn('text-sm font-semibold tabular-nums', i.direction === 'IN' ? 'text-emerald-600' : 'text-rose-600')}>
                  {formatMoney(i.amount, currency)}
                </span>
                <ItemActionButtons item={i} actions={actions} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Resumen de las últimas 13 semanas reales comparado contra las 13 proyectadas. */
function HistoryCard({ history, projection }: { history: HistoryResult; projection: ProjectionResult }) {
  const app = useApp();
  const cur = history.currency;
  const money = (c: number) => formatMoney(c, cur);
  const compact = (c: number) => formatMoney(c, cur, { compact: true });
  const t = history.totals;
  const n = projection.weeks.length || 1;
  const projIn = Math.round(projection.weeks.reduce((s, w) => s + w.inflows, 0) / n);
  const projOut = Math.round(projection.weeks.reduce((s, w) => s + w.outflows, 0) / n);
  const ins = history.byCategory.filter((c) => c.direction === 'IN').slice(0, 6);
  const outs = history.byCategory.filter((c) => c.direction === 'OUT').slice(0, 6);
  const partial = history.dataStart && t.weeksWithData < history.weeks.length;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <History className="h-4 w-4" /> Últimas {history.weeks.length} semanas (real)
        </h2>
        <p className="text-xs text-slate-500">
          {formatDateYear(history.start, app.today)} – {formatDateYear(history.end, app.today)}
          {partial && ` · historia desde ${formatDateYear(history.dataStart!, app.today)}`}
        </p>
      </div>
      {!history.dataStart || (t.inflows === 0 && t.outflows === 0) ? (
        <EmptyState title="Sin movimientos reales en este período">
          Cuando registres cobros y pagos con fecha pasada aparecerán aquí tus entradas y salidas reales.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Cobrado" value={money(t.inflows)} tone="good" />
            <Stat label="Pagado" value={money(t.outflows)} tone="bad" />
            <Stat
              label="Flujo neto real"
              value={money(t.net)}
              tone={t.net < 0 ? 'bad' : 'good'}
              sub={t.adjustments !== 0 ? `Ajustes de conciliación: ${money(t.adjustments)}` : undefined}
            />
            <Stat label="Semanas con datos" value={`${t.weeksWithData} de ${history.weeks.length}`} />
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Compare label="Entradas por semana" real={t.avgWeeklyIn} projected={projIn} fmt={compact} higherIsGood />
            <Compare label="Salidas por semana" real={t.avgWeeklyOut} projected={projOut} fmt={compact} higherIsGood={false} />
          </div>

          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <CategoryBars title="¿De dónde entró el dinero?" rows={ins} total={t.inflows} color="bg-emerald-500" fmt={compact} />
            <CategoryBars title="¿En qué se fue?" rows={outs} total={t.outflows} color="bg-rose-500" fmt={compact} />
          </div>
        </>
      )}
    </Card>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums',
          tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
          tone === 'bad' && 'text-rose-700 dark:text-rose-400',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

/** Promedio semanal real vs proyectado: ayuda a detectar proyecciones optimistas. */
function Compare({
  label,
  real,
  projected,
  fmt,
  higherIsGood,
}: {
  label: string;
  real: number;
  projected: number;
  fmt: (c: number) => string;
  higherIsGood: boolean;
}) {
  const diff = real > 0 ? Math.round(((projected - real) / real) * 100) : null;
  const good = diff === null || diff === 0 ? null : higherIsGood ? diff > 0 : diff < 0;
  return (
    <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/40">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span>
          Real <strong className="tabular-nums">{fmt(real)}</strong>
        </span>
        <span>
          Proyectado <strong className="tabular-nums">{fmt(projected)}</strong>
        </span>
        {diff !== null && diff !== 0 && (
          <span className={cn('text-xs font-medium', good ? 'text-emerald-600' : 'text-amber-600')}>
            {diff > 0 ? '+' : ''}
            {diff}% vs. lo real
          </span>
        )}
      </div>
    </div>
  );
}

function CategoryBars({
  title,
  rows,
  total,
  color,
  fmt,
}: {
  title: string;
  rows: { name: string; amount: number }[];
  total: number;
  color: string;
  fmt: (c: number) => string;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">Sin movimientos</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const pct = total > 0 ? (r.amount / total) * 100 : 0;
            return (
              <li key={r.name}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate">{r.name}</span>
                  <span className="shrink-0 tabular-nums text-slate-600 dark:text-slate-300">
                    {fmt(r.amount)} <span className="text-xs text-slate-400">· {pct.toFixed(0)}%</span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
