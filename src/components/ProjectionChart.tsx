'use client';

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ProjectionResult } from '@/lib/projection/types';
import type { EntityDto } from '@/lib/server/dto';
import { formatShortDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

const IN_SINGLE = '#10b981';
const OUT_SINGLE = '#f43f5e';

/**
 * Gráfica combinada 13 semanas: barras apiladas por entidad (entradas arriba,
 * salidas abajo), línea de saldo proyectado y umbral mínimo punteado.
 */
export function ProjectionChart({ result, entities }: { result: ProjectionResult; entities: EntityDto[] }) {
  const consolidated = result.consolidated && entities.length > 1;
  const currency = result.currency;
  const threshold = result.kpis.threshold / 100;

  const data = result.weeks.map((w) => {
    const row: Record<string, number | string> = {
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
              key === 'closing' ? 'Saldo proyectado' : nameOf(key),
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
            />
          ))}
          {entities.map((e) => (
            <Bar
              key={`out_${e.id}`}
              yAxisId="flow"
              dataKey={`out_${e.id}`}
              stackId="flow"
              fill={consolidated ? e.color : OUT_SINGLE}
              fillOpacity={consolidated ? 0.45 : 0.85}
              radius={[0, 0, 3, 3]}
              maxBarSize={38}
            />
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
