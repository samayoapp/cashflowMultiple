'use client';

import { AlertTriangle, CalendarClock, Gauge, Landmark, TrendingDown, TrendingUp, Wind } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from '@/components/AppContext';
import { Badge, Card, cn, EmptyState, ErrorBox, Loading } from '@/components/ui';
import { ProjectionChart } from '@/components/ProjectionChart';
import { EntityDot } from '@/components/AppShell';
import { ItemActionButtons, useItemActions } from '@/components/ItemActions';
import { useProjection } from '@/lib/client/useProjection';
import { formatMoney } from '@/lib/money';
import { addDays, formatLongDate, formatShortDate } from '@/lib/dates';
import type { ProjectedItem } from '@/lib/projection/types';
import { netFlowWithin } from '@/lib/projection/engine';

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

export default function DashboardPage() {
  const app = useApp();
  const { data, error, loading } = useProjection();
  const actions = useItemActions();
  const [period, setPeriod] = useNetFlowPeriod();

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
          <h2 className="text-sm font-semibold">Proyección 13 semanas</h2>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
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
        <ProjectionChart result={result} entities={entities} />
      </Card>

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
