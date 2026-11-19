'use client';

import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ProjectionResult } from '@/lib/projection/types';
import type { HistoryResult } from '@/lib/projection/history';
import type { EntityDto } from '@/lib/server/dto';
import { formatShortDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

const IN_SINGLE = '#10b981';
const OUT_SINGLE = '#f43f5e';

type Row = Record<string, number | string | boolean | undefined>;

/**
 * Gráfica combinada 13 semanas: barras apiladas por entidad (entradas arriba,
 * salidas abajo), línea de saldo proyectado y umbral mínimo punteado.
 * Con `history`, antepone las semanas reales (barras tenues + línea de saldo real)
 * y marca "Hoy" donde empieza la proyección.
 */
export function ProjectionChart({
  result,
  entities,
  history,
}: {
  result: ProjectionResult;
  entities: EntityDto[];
  history?: HistoryResult | null;
}) {
  const consolidated = result.consolidated && entities.length > 1;
  const currency = result.currency;
  const threshold = result.kpis.threshold / 100;

  const past: Row[] = (history?.weeks ?? []).map((w, i, all) => {
    const row: Row = {
      label: formatShortDate(w.start),
      range: `${formatShortDate(w.start)} – ${formatShortDate(w.end)} · real`,
      real: w.hasData ? w.closing / 100 : undefined,
      past: true,
    };
    // La línea proyectada arranca desde el último saldo real
    if (i === all.length - 1 && w.hasData) row.closing = w.closing / 100;
    for (const e of entities) {
      const f = w.byEntity[e.id];
      row[`in_${e.id}`] = (f?.inflows ?? 0) / 100;
      row[`out_${e.id}`] = -(f?.outflows ?? 0) / 100;
    }
    return row;
  });

  const future: Row[] = result.weeks.map((w) => {
    const row: Row = {
      label: formatShortDate(w.start),
      range: `${formatShortDate(w.start)} – ${formatShortDate(w.end)}`,
      closing: w.closing / 100,
    };
    for (const e of entities) {
      const f = w.byEntity[e.id];
      row[`in_${e.id}`] = (f?.inflows ?? 0) / 100;
      row[`out_${e.id}`] = -(f?.outflows ?? 0) / 100;
    }
    return row;
  });

  const data = [...past, ...future];
  const todayLabel = past.length ? (future[0]?.label as string | undefined) : undefined;

  const fmt = (v: number) => formatMoney(Math.round(v * 100), currency, { compact: true });
  const nameOf = (key: string) => {
    const [kind, id] = key.split('_');
    const e = entities.find((x) => x.id === id);
    return `${kind === 'in' ? 'Entradas' : 'Salidas'}${consolidated && e ? ` · ${e.name}` : ''}`;
  };

  return (
    <div className="h-[340px] w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} stackOffset="sign" margin={{ top: 10, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-slate-200 dark:text-slate-800" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="currentColor" className="text-slate-500" tickLine={false} />
          <YAxis yAxisId="flow" tickFormatter={fmt} tick={{ fontSize: 11 }} width={70} stroke="currentColor" className="text-slate-500" />
          <YAxis
            yAxisId="bal"
            orientation="right"
            tickFormatter={fmt}
            tick={{ fontSize: 11 }}
            width={70}
            stroke="currentColor"
            className="text-slate-500"
          />
          <Tooltip
            cursor={{ fill: 'rgba(148,163,184,0.12)' }}
            contentStyle={{ borderRadius: 12, fontSize: 12, border: '1px solid rgba(148,163,184,.3)' }}
            labelFormatter={(_l, payload) => (payload?.[0]?.payload as { range?: string })?.range ?? ''}
            formatter={(value: number, key: string) => [
              formatMoney(Math.round(Math.abs(value) * 100), currency),
              key === 'closing' ? 'Saldo proyectado' : key === 'real' ? 'Saldo real' : nameOf(key),
            ]}
          />
          <ReferenceLine yAxisId="flow" y={0} stroke="#94a3b8" />
          {entities.map((e) => (
            <Bar
              key={`in_${e.id}`}
              yAxisId="flow"
              dataKey={`in_${e.id}`}
              stackId="flow"
              fill={consolidated ? e.color : IN_SINGLE}
              radius={[3, 3, 0, 0]}
              maxBarSize={38}
            >
              {data.map((r, i) => (
                <Cell key={i} fillOpacity={r.past ? 0.4 : 1} />
              ))}
            </Bar>
          ))}
          {entities.map((e) => (
            <Bar
              key={`out_${e.id}`}
              yAxisId="flow"
              dataKey={`out_${e.id}`}
              stackId="flow"
              fill={consolidated ? e.color : OUT_SINGLE}
              radius={[0, 0, 3, 3]}
              maxBarSize={38}
            >
              {data.map((r, i) => (
                <Cell key={i} fillOpacity={(consolidated ? 0.45 : 0.85) * (r.past ? 0.45 : 1)} />
              ))}
            </Bar>
          ))}
          <Line
            yAxisId="bal"
            type="monotone"
            dataKey="closing"
            stroke="#0ea5e9"
            strokeWidth={2.5}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
          {history && (
            <Line
              yAxisId="bal"
              type="monotone"
              dataKey="real"
              stroke="#64748b"
              strokeWidth={2.5}
              dot={{ r: 2.5 }}
              activeDot={{ r: 5 }}
              connectNulls={false}
            />
          )}
          {todayLabel && (
            <ReferenceLine
              yAxisId="flow"
              x={todayLabel}
              stroke="#0ea5e9"
              strokeDasharray="3 3"
              label={{ value: 'Hoy', position: 'insideTopRight', fontSize: 11, fill: '#0ea5e9' }}
            />
          )}
          <ReferenceLine
            yAxisId="bal"
            y={threshold}
            stroke="#f59e0b"
            strokeDasharray="6 4"
            label={{ value: `Umbral ${fmt(threshold)}`, position: 'insideTopLeft', fontSize: 11, fill: '#f59e0b' }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
