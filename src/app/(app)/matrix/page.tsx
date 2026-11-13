'use client';

import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, FlaskConical, Plus, RotateCcw } from 'lucide-react';
import { useApp } from '@/components/AppContext';
import { Badge, Button, Card, cn, ErrorBox, Loading, Tabs, useToast } from '@/components/ui';
import { EntityDot } from '@/components/AppShell';
import { ObligationFormModal, parseMoneyInput } from '@/components/forms';
import { useProjection, type ProjectionPayload } from '@/lib/client/useProjection';
import { api, emitDataChanged } from '@/lib/client/api';
import { project } from '@/lib/projection/engine';
import type { ProjectedItem, ProjectionInput } from '@/lib/projection/types';
import { addDays, addMonths, diffDays, formatShortDate, toUTCDate, type ISODate } from '@/lib/dates';
import { centsToDecimalString, formatMoney, toCents, type Cents } from '@/lib/money';
import type { ObligationDto } from '@/lib/server/dto';

type View = 'weeks' | 'months';
interface Column {
  key: string;
  label: string;
  sub: string;
  start: ISODate;
  end: ISODate;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function buildColumns(view: View, payload: ProjectionPayload): Column[] {
  const { weeks } = payload.result;
  if (view === 'weeks') {
    return weeks.map((w, i) => ({
      key: w.start,
      label: i === 0 ? 'Esta semana' : `Sem ${i + 1}`,
      sub: formatShortDate(w.start),
      start: w.start,
      end: w.end,
    }));
  }
  const first = weeks[0].start.slice(0, 7) + '-01';
  const last = weeks[weeks.length - 1].end;
  const cols: Column[] = [];
  for (let m = first; m <= last; m = addMonths(m, 1, 1)) {
    const end = addDays(addMonths(m, 1, 1), -1);
    const d = toUTCDate(m);
    cols.push({ key: m, label: MONTHS[d.getUTCMonth()], sub: String(d.getUTCFullYear()), start: m, end });
  }
  return cols;
}

/** Aplica un cambio optimista sobre el input del motor y recalcula al instante. */
function applyLocal(
  payload: ProjectionPayload,
  change:
    | { kind: 'override'; obligationId: string; patch: { amount?: Cents | null; expectedDate?: ISODate | null; excluded?: boolean } }
    | { kind: 'obligation'; obligationId: string; patch: { amount?: Cents; expectedDate?: ISODate } },
): ProjectionPayload {
  const input: ProjectionInput = { ...payload.input };
  if (change.kind === 'override') {
    const existing = input.overrides.find((o) => o.obligationId === change.obligationId);
    const merged = {
      obligationId: change.obligationId,
      expectedDate: existing?.expectedDate ?? null,
      amount: existing?.amount ?? null,
      excluded: existing?.excluded ?? false,
      ...change.patch,
    };
    input.overrides = [...input.overrides.filter((o) => o.obligationId !== change.obligationId), merged];
  } else {
    input.obligations = input.obligations.map((o) => (o.id === change.obligationId ? { ...o, ...change.patch } : o));
  }
  return { ...payload, input, result: project(input) };
}

export default function MatrixPage() {
  const app = useApp();
  const toast = useToast();
  const { data, error, loading, setData } = useProjection();
  const [view, setView] = useState<View>('weeks');
  const [open, setOpen] = useState<{ IN: boolean; OUT: boolean }>({ IN: true, OUT: true });
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [creating, setCreating] = useState<'IN' | 'OUT' | null>(null);

  const columns = useMemo(() => (data ? buildColumns(view, data) : []), [view, data]);

  const grid = useMemo(() => {
    if (!data) return null;
    const { result } = data;
    const colOf = (date: ISODate) => columns.findIndex((c) => date >= c.start && date <= c.end);
    const inflows = columns.map(() => 0);
    const outflows = columns.map(() => 0);
    const rows: { item: ProjectedItem; col: number }[] = [];
    for (const item of result.items) {
      const col = colOf(item.date);
      if (col < 0) continue;
      rows.push({ item, col });
      if (item.direction === 'IN') inflows[col] += item.amount;
      else outflows[col] += item.amount;
    }
    // Saldo de apertura de la primera columna = caja real hoy (no hay partidas antes de hoy)
    const opening: number[] = [];
    const closing: number[] = [];
    let running = result.kpis.cashToday;
    columns.forEach((_, i) => {
      opening.push(running);
      running += inflows[i] - outflows[i];
      closing.push(running);
    });
    return {
      rows,
      inflows,
      outflows,
      opening,
      closing,
      inRows: rows.filter((r) => r.item.direction === 'IN'),
      outRows: rows.filter((r) => r.item.direction === 'OUT'),
    };
  }, [data, columns]);

  if (error) return <ErrorBox message={error} />;
  if (loading || !data || !grid) return <Loading />;

  const { result, input } = data;
  const currency = result.currency;
  const threshold = result.kpis.threshold;
  const whatIf = result.whatIf;
  const obligationsById = new Map(input.obligations.map((o) => [o.id, o]));
  const excluded = input.overrides.filter((o) => o.excluded && obligationsById.has(o.obligationId));

  /** Devuelve el id de la obligación real (materializa recurrencias virtuales). */
  async function resolveId(item: ProjectedItem): Promise<string> {
    if (item.obligationId) return item.obligationId;
    const ob = await api<ObligationDto>(`/api/recurrences/${item.ruleId}/materialize`, { body: { date: item.date } });
    return ob.id;
  }

  async function persist(fn: () => Promise<unknown>, okMsg: string) {
    try {
      await fn();
      toast(okMsg);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      emitDataChanged();
    }
  }

  async function commitAmount(item: ProjectedItem, raw: string) {
    setEditing(null);
    const parsed = parseMoneyInput(raw);
    if (parsed === null || Number(parsed) < 0) return toast('Monto inválido', 'error');
    const newRemaining = toCents(parsed);
    if (newRemaining === item.amountNative) return;
    const simulate = whatIf && !item.isHypothetical;
    const ob = item.obligationId ? obligationsById.get(item.obligationId) : null;

    if (ob) {
      setData(
        simulate
          ? applyLocal(data!, { kind: 'override', obligationId: ob.id, patch: { amount: newRemaining } })
          : applyLocal(data!, { kind: 'obligation', obligationId: ob.id, patch: { amount: ob.paid + newRemaining } }),
      );
    }
    if (!simulate && newRemaining === 0) return toast('Para anular una partida real, cancélala en CxC / CxP', 'error');
    await persist(async () => {
      const id = await resolveId(item);
      const paid = ob?.paid ?? 0;
      if (simulate) {
        await api('/api/scenario/overrides', { method: 'PUT', body: { obligationId: id, amount: parsed } });
      } else {
        await api(`/api/obligations/${id}`, {
          method: 'PATCH',
          body: { amount: centsToDecimalString(paid + newRemaining) },
        });
      }
    }, simulate ? 'Monto simulado' : 'Monto actualizado');
  }

  async function moveTo(item: ProjectedItem, targetCol: number) {
    const current = columns.findIndex((c) => item.date >= c.start && item.date <= c.end);
    if (current === targetCol || current < 0) return;
    let newDate =
      view === 'weeks'
        ? addDays(item.date, 7 * (targetCol - current))
        : addMonths(item.date, targetCol - current, toUTCDate(item.date).getUTCDate());
    if (newDate < result.today) newDate = result.today;
    if (item.transferId && whatIf) return toast('Las transferencias se reprograman fuera de la simulación', 'error');
    const simulate = whatIf && !item.isHypothetical;
    if (item.obligationId) {
      setData(
        simulate
          ? applyLocal(data!, { kind: 'override', obligationId: item.obligationId, patch: { expectedDate: newDate } })
          : applyLocal(data!, { kind: 'obligation', obligationId: item.obligationId, patch: { expectedDate: newDate } }),
      );
    }
    await persist(async () => {
      const id = await resolveId(item);
      if (simulate) await api('/api/scenario/overrides', { method: 'PUT', body: { obligationId: id, expectedDate: newDate } });
      else await api(`/api/obligations/${id}`, { method: 'PATCH', body: { expectedDate: newDate } });
    }, `Movido al ${formatShortDate(newDate)}${simulate ? ' (simulación)' : ''}`);
  }

  async function setExcluded(obligationId: string | null, item: ProjectedItem | null, value: boolean) {
    if (obligationId) setData(applyLocal(data!, { kind: 'override', obligationId, patch: { excluded: value } }));
    await persist(async () => {
      const id = obligationId ?? (item ? await resolveId(item) : null);
      if (!id) return;
      await api('/api/scenario/overrides', { method: 'PUT', body: { obligationId: id, excluded: value } });
    }, value ? 'Partida apagada en la simulación' : 'Partida incluida de nuevo');
  }

  async function resetScenario() {
    if (!confirm('¿Quitar todos los ajustes de la simulación? Las partidas hipotéticas se conservan.')) return;
    await persist(() => api('/api/scenario/overrides', { method: 'DELETE' }), 'Simulación reiniciada');
  }

  const consolidated = result.consolidated;
  const stickyCell = 'sticky left-0 z-10 bg-white dark:bg-slate-900';

  const renderItemRows = (rows: { item: ProjectedItem; col: number }[]) =>
    rows.map(({ item, col }) => {
      const e = app.entityById.get(item.entityId);
      const editKey = item.key;
      return (
        <tr key={item.key} className="group border-t border-slate-100 hover:bg-slate-50/70 dark:border-slate-800/70 dark:hover:bg-slate-800/30">
          <td className={cn(stickyCell, 'max-w-[18rem] py-1.5 pl-8 pr-3 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/60')}>
            <div className="flex items-center gap-2">
              {consolidated && e && <EntityDot color={e.color} />}
              <span className="truncate text-sm" title={item.description}>
                {item.description}
              </span>
              {whatIf && (
                <button
                  onClick={() => setExcluded(item.obligationId, item, true)}
                  className="ml-auto shrink-0 rounded p-0.5 text-slate-400 opacity-0 hover:text-violet-600 group-hover:opacity-100"
                  title="Apagar en la simulación"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1 pt-0.5">
              {item.overdue && <Badge tone="red">Vencida · requiere gestión</Badge>}
              {item.isHypothetical && <Badge tone="violet">Hipotética</Badge>}
              {item.simulated && <Badge tone="violet">Simulada</Badge>}
              {item.ruleId && <Badge tone="blue">Recurrente</Badge>}
              {item.transferId && <Badge>Transferencia</Badge>}
              {item.direction === 'OUT' && item.priority === 'FIXED' && <Badge tone="amber">Inamovible</Badge>}
            </div>
          </td>
          {columns.map((c, i) => (
            <td key={c.key} className="px-1 py-1 text-right">
              {i === col ? (
                editing?.key === editKey ? (
                  <input
                    autoFocus
                    className="input w-28 px-2 py-1 text-right text-sm"
                    inputMode="decimal"
                    value={editing.value}
                    onChange={(ev) => setEditing({ key: editKey, value: ev.target.value })}
                    onBlur={() => commitAmount(item, editing.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
                      if (ev.key === 'Escape') setEditing(null);
                    }}
                    title={`Monto pendiente en ${item.nativeCurrency}`}
                  />
                ) : (
                  <button
                    disabled={Boolean(item.transferId)}
                    onClick={() => setEditing({ key: editKey, value: centsToDecimalString(item.amountNative) })}
                    className={cn(
                      'rounded px-2 py-1 text-sm font-medium tabular-nums hover:bg-slate-200/70 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-slate-700',
                      item.direction === 'IN' ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400',
                      item.simulated && 'ring-1 ring-violet-400',
                    )}
                    title={item.nativeCurrency !== currency ? `${formatMoney(item.amountNative, item.nativeCurrency)} (clic para editar)` : 'Clic para editar'}
                  >
                    {formatMoney(item.amount, currency).replace(currency, '').trim()}
                  </button>
                )
              ) : (
                <button
                  onClick={() => moveTo(item, i)}
                  className="h-7 w-full rounded text-[10px] text-transparent hover:bg-sky-50 hover:text-sky-600 dark:hover:bg-sky-500/10"
                  title={`Mover fecha esperada a ${c.label}`}
                >
                  mover aquí
                </button>
              )}
            </td>
          ))}
        </tr>
      );
    });

  const amountRow = (label: string, values: number[], opts: { bold?: boolean; tone?: 'in' | 'out'; balance?: boolean }) => (
    <tr className={cn('border-t border-slate-200 dark:border-slate-800', opts.balance && 'bg-slate-50/80 dark:bg-slate-800/40')}>
      <td className={cn(stickyCell, 'px-3 py-2 text-sm', opts.bold && 'font-semibold', opts.balance && 'bg-slate-50 dark:bg-slate-800')}>{label}</td>
      {values.map((v, i) => (
        <td
          key={columns[i].key}
          className={cn(
            'px-3 py-2 text-right text-sm tabular-nums',
            opts.bold && 'font-semibold',
            opts.tone === 'in' && 'text-emerald-700 dark:text-emerald-400',
            opts.tone === 'out' && 'text-rose-700 dark:text-rose-400',
            opts.balance && v < 0 && 'bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300',
            opts.balance && v >= 0 && v < threshold && 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
          )}
        >
          {formatMoney(v, currency).replace(currency, '').trim()}
        </td>
      ))}
    </tr>
  );

  const groupHeader = (dir: 'IN' | 'OUT', values: number[], count: number) => (
    <tr className="border-t border-slate-200 dark:border-slate-800">
      <td className={cn(stickyCell, 'px-3 py-2')}>
        <div className="flex items-center gap-1">
          <button onClick={() => setOpen((o) => ({ ...o, [dir]: !o[dir] }))} className="flex items-center gap-1 text-sm font-semibold">
            {open[dir] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {dir === 'IN' ? 'Entradas (CxC)' : 'Salidas (CxP)'}
            <span className="text-xs font-normal text-slate-500">({count})</span>
          </button>
          <button
            onClick={() => setCreating(dir)}
            className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
            title={whatIf ? 'Agregar partida hipotética' : 'Agregar partida'}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </td>
      {values.map((v, i) => (
        <td
          key={columns[i].key}
          className={cn('px-3 py-2 text-right text-sm font-semibold tabular-nums', dir === 'IN' ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400')}
        >
          {v === 0 ? '—' : formatMoney(v, currency).replace(currency, '').trim()}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Matriz de flujo</h1>
          <p className="text-sm text-slate-500">
            Montos en {currency}. Clic en un monto para editarlo; clic en otra columna para mover la fecha esperada.
            {whatIf ? ' Los cambios se guardan como simulación.' : ' Los cambios modifican los registros reales.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {whatIf && (
            <Button size="sm" onClick={resetScenario}>
              <RotateCcw className="h-3.5 w-3.5" /> Reiniciar simulación
            </Button>
          )}
          <Tabs<View>
            tabs={[
              { id: 'weeks', label: 'Semanas' },
              { id: 'months', label: 'Meses' },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>

      <Card className="overflow-hidden p-0 sm:p-0">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/60">
                <th className={cn('th sticky left-0 z-20 min-w-[16rem] bg-slate-50 dark:bg-slate-800')}>Concepto</th>
                {columns.map((c) => (
                  <th key={c.key} className="th min-w-[7.5rem] text-right">
                    <div>{c.label}</div>
                    <div className="font-normal normal-case text-slate-400">{c.sub}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {amountRow('Saldo inicial', grid.opening, { bold: true, balance: true })}
              {groupHeader('IN', grid.inflows, grid.inRows.length)}
              {open.IN && renderItemRows(grid.inRows)}
              {groupHeader('OUT', grid.outflows, grid.outRows.length)}
              {open.OUT && renderItemRows(grid.outRows)}
              {amountRow(
                'Flujo neto',
                grid.inflows.map((v, i) => v - grid.outflows[i]),
                {},
              )}
              {amountRow('Saldo de cierre', grid.closing, { bold: true, balance: true })}
            </tbody>
          </table>
        </div>
      </Card>

      {whatIf && excluded.length > 0 && (
        <Card>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <FlaskConical className="h-4 w-4 text-violet-600" /> Partidas apagadas en la simulación
          </h2>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {excluded.map((o) => {
              const ob = obligationsById.get(o.obligationId)!;
              return (
                <Fragment key={o.obligationId}>
                  <li className="flex items-center gap-3 py-2 text-sm">
                    <span className={ob.direction === 'IN' ? 'text-emerald-600' : 'text-rose-600'}>{ob.direction === 'IN' ? '+' : '−'}</span>
                    <span className="flex-1 truncate">{ob.description}</span>
                    <span className="text-xs text-slate-500">esperado {formatShortDate(ob.expectedDate)}</span>
                    <Button size="sm" onClick={() => setExcluded(o.obligationId, null, false)}>
                      <Eye className="h-3.5 w-3.5" /> Incluir
                    </Button>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </Card>
      )}

      <p className="text-xs text-slate-500">
        Las partidas vencidas se muestran en la semana actual. Días hasta la última columna:{' '}
        {diffDays(columns[columns.length - 1].end, result.today)}.
      </p>

      <ObligationFormModal
        open={creating !== null}
        onClose={() => setCreating(null)}
        direction={creating ?? 'IN'}
        hypothetical={whatIf}
      />
    </div>
  );
}
