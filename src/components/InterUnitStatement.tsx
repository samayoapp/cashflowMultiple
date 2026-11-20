'use client';

import { useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, Coins } from 'lucide-react';
import { useApp } from './AppContext';
import { EntityDot } from './AppShell';
import { Badge, Button, Card, cn, EmptyState, ErrorBox, Loading, Toggle, useToast } from './ui';
import { ExecuteTransferModal, LoanRepaymentModal } from './forms';
import { api, useApi } from '@/lib/client/api';
import { formatMoney } from '@/lib/money';
import { formatDateYear } from '@/lib/dates';
import type { InterUnitItem, InterUnitPair } from '@/lib/projection/interunit';
import type { TransferDto } from '@/lib/server/dto';

const KIND_LABEL: Record<InterUnitItem['kind'], string> = {
  REIMBURSEMENT: 'Reembolso',
  REPAYMENT: 'Devolución de préstamo',
  LOAN: 'Préstamo entregado',
};

const STATE: Record<InterUnitItem['state'], { label: string; tone: 'slate' | 'green' | 'amber' | 'red' | 'violet' }> = {
  OPEN: { label: 'Pendiente', tone: 'slate' },
  PARTIAL: { label: 'Con abonos', tone: 'amber' },
  SETTLED: { label: 'Saldado', tone: 'green' },
  CANCELLED: { label: 'Cancelado', tone: 'red' },
  NO_PLAN: { label: 'Sin devolución programada', tone: 'violet' },
};

const isPending = (i: InterUnitItem) => i.state === 'OPEN' || i.state === 'PARTIAL' || i.state === 'NO_PLAN';

/** Estado de cuenta entre unidades: quién le debe a quién (reembolsos, préstamos y devoluciones). */
export function InterUnitStatement() {
  const app = useApp();
  const toast = useToast();
  const { data, error, loading } = useApi<InterUnitPair[]>(`/api/inter-unit?ctx=${encodeURIComponent(app.ctx)}`);
  const [onlyPending, setOnlyPending] = useState(true);
  const [paying, setPaying] = useState<{ id: string; partial: boolean } | null>(null);
  const [programming, setProgramming] = useState<TransferDto | null>(null);

  const pairs = useMemo(
    () =>
      (data ?? [])
        .map((p) => ({ ...p, items: onlyPending ? p.items.filter(isPending) : p.items }))
        .filter((p) => p.items.length > 0),
    [data, onlyPending],
  );

  async function program(transferId: string) {
    try {
      setProgramming(await api<TransferDto>(`/api/transfers/${transferId}`));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  const name = (id: string) => app.entityById.get(id)?.name ?? '—';
  const cur = (id: string) => app.entityById.get(id)?.currency ?? 'HNL';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          Reembolsos (gastos pagados con la tarjeta de otra unidad), préstamos y sus devoluciones. Las transferencias y aportes simples no generan deuda.
        </p>
        <Toggle checked={onlyPending} onChange={setOnlyPending} label={<span className="text-xs text-slate-500">Solo pendientes</span>} />
      </div>

      {error ? (
        <ErrorBox message={error} />
      ) : loading && !data ? (
        <Loading />
      ) : pairs.length === 0 ? (
        <Card>
          <EmptyState title={onlyPending ? 'Nadie le debe a nadie' : 'Sin movimientos entre unidades'}>
            Para registrar un gasto del negocio pagado con una tarjeta familiar: Tarjetas → consumo → botón de unidad, o “Nuevo consumo → Pagado por otra
            unidad de negocio”.
          </EmptyState>
        </Card>
      ) : (
        pairs.map((p) => {
          const a = app.entityById.get(p.a);
          const b = app.entityById.get(p.b);
          const same = cur(p.a) === cur(p.b);
          const net = p.bOwesA - p.aOwesB; // > 0: B le debe a A (moneda común)
          return (
            <Card key={`${p.a}|${p.b}`} className="p-0 sm:p-0">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-3 dark:border-slate-800">
                <div className="flex items-center gap-2 font-medium">
                  {a && <EntityDot color={a.color} />} {name(p.a)} <span className="text-slate-400">↔</span> {b && <EntityDot color={b.color} />} {name(p.b)}
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                  {p.aOwesB === 0 && p.bOwesA === 0 ? (
                    <span className="text-slate-500">Sin saldo pendiente</span>
                  ) : same && p.aOwesB > 0 && p.bOwesA > 0 ? (
                    <>
                      <span className="text-slate-500">
                        {name(p.a)} debe {formatMoney(p.aOwesB, cur(p.b))} · {name(p.b)} debe {formatMoney(p.bOwesA, cur(p.a))}
                      </span>
                      <span>
                        Neto: <strong>{net > 0 ? name(p.b) : name(p.a)}</strong> le debe a <strong>{net > 0 ? name(p.a) : name(p.b)}</strong>{' '}
                        <strong className="tabular-nums text-amber-700 dark:text-amber-400">{formatMoney(Math.abs(net), cur(p.a))}</strong>
                      </span>
                    </>
                  ) : (
                    <>
                      {p.aOwesB > 0 && (
                        <span>
                          <strong>{name(p.a)}</strong> le debe a <strong>{name(p.b)}</strong>{' '}
                          <strong className="tabular-nums text-amber-700 dark:text-amber-400">{formatMoney(p.aOwesB, cur(p.b))}</strong>
                        </span>
                      )}
                      {p.bOwesA > 0 && (
                        <span>
                          <strong>{name(p.b)}</strong> le debe a <strong>{name(p.a)}</strong>{' '}
                          <strong className="tabular-nums text-amber-700 dark:text-amber-400">{formatMoney(p.bOwesA, cur(p.a))}</strong>
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 dark:bg-slate-800/50">
                    <tr>
                      <th className="th">Concepto</th>
                      <th className="th">Debe → cobra</th>
                      <th className="th">Fecha</th>
                      <th className="th text-right">Monto</th>
                      <th className="th text-right">Abonado</th>
                      <th className="th text-right">Pendiente</th>
                      <th className="th">Estado</th>
                      <th className="th text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.items.map((i) => {
                      const c = cur(i.creditorId);
                      const st = STATE[i.state];
                      const payable = (i.kind === 'REIMBURSEMENT' || i.kind === 'REPAYMENT') && (i.state === 'OPEN' || i.state === 'PARTIAL');
                      return (
                        <tr key={i.transferId} className={cn('border-t border-slate-100 dark:border-slate-800', !isPending(i) && 'text-slate-500')}>
                          <td className="td max-w-xs">
                            <div className="font-medium">{KIND_LABEL[i.kind]}</div>
                            {i.description && <div className="truncate text-xs text-slate-500">{i.description.replace(/^Reembolso: /, '')}</div>}
                            {i.interest > 0 && <div className="text-xs text-slate-500">Incluye interés {formatMoney(i.interest, c)}</div>}
                          </td>
                          <td className="td whitespace-nowrap text-sm">
                            {name(i.debtorId)} → {name(i.creditorId)}
                          </td>
                          <td className="td whitespace-nowrap">{formatDateYear(i.date, app.today)}</td>
                          <td className="td num">{formatMoney(i.original, c)}</td>
                          <td className="td num text-slate-500">{i.paid ? formatMoney(i.paid, c) : '—'}</td>
                          <td className="td num font-semibold">{i.pending ? formatMoney(i.pending, c) : '—'}</td>
                          <td className="td">
                            <Badge tone={st.tone}>{st.label}</Badge>
                          </td>
                          <td className="td">
                            <div className="flex justify-end gap-0.5">
                              {payable && (
                                <>
                                  <Button size="sm" variant="ghost" title="Registrar abono" onClick={() => setPaying({ id: i.transferId, partial: true })}>
                                    <Coins className="h-4 w-4" />
                                  </Button>
                                  <Button size="sm" variant="ghost" title="Saldar todo lo pendiente" onClick={() => setPaying({ id: i.transferId, partial: false })}>
                                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                  </Button>
                                </>
                              )}
                              {i.state === 'NO_PLAN' && (
                                <Button size="sm" onClick={() => program(i.transferId)} title="Crear la CxC/CxP de la devolución">
                                  <CalendarClock className="h-3.5 w-3.5" /> Programar devolución
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
            </Card>
          );
        })
      )}
      <ExecuteTransferModal open={Boolean(paying)} onClose={() => setPaying(null)} transfer={paying} partial={paying?.partial} />
      <LoanRepaymentModal open={Boolean(programming)} onClose={() => setProgramming(null)} loan={programming} />
    </div>
  );
}
