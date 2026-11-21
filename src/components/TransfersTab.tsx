'use client';

/** Transferencias entre unidades y entre cuentas de una misma unidad (Caja y Bancos). */
import { useState } from 'react';
import { ArrowLeftRight, Ban, CalendarClock, CheckCircle2, Coins, Plus, Send, Trash2 } from 'lucide-react';
import { useApp } from './AppContext';
import { Badge, Button, Card, cn, confirmDialog, EmptyState, ErrorBox, Loading, TableTotals, useToast } from './ui';
import { EntityDot } from './AppShell';
import { ExecuteTransferModal, InternalTransferModal, LoanRepaymentModal, TransferFormModal } from './forms';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import type { TransferDto } from '@/lib/server/dto';
import { formatMoney } from '@/lib/money';
import { formatDateYear } from '@/lib/dates';

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

export function TransfersTab() {
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
    if (
      !(await confirmDialog({
        title: t.repaymentOfId || t.isReimbursement ? 'Cancelar saldo pendiente' : 'Cancelar transferencia',
        message: msg,
        confirmLabel: t.repaymentOfId || t.isReimbursement ? 'Cancelar saldo' : 'Cancelar transferencia',
        tone: 'danger',
      }))
    )
      return;
    try {
      await api(`/api/transfers/${t.id}`, { body: { action: 'cancel' } });
      toast('Transferencia cancelada');
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  async function remove(t: TransferRow) {
    const from = app.entityById.get(t.fromEntityId);
    const to = app.entityById.get(t.toEntityId);
    const label = t.repaymentOfId ? 'Devolución de préstamo' : t.isReimbursement ? 'Reembolso' : KIND[t.kind];
    const moved = t.paidFrom > 0 || t.paidTo > 0;
    const lines = [`¿Eliminar definitivamente "${label}${t.description ? `: ${t.description}` : ''}" (${from?.name} → ${to?.name})?`];
    const title = moved ? 'Eliminar y revertir transferencia' : 'Eliminar transferencia';
    if (moved) {
      lines.push(
        '',
        'Ya movió caja; se REVIERTEN sus movimientos:',
        `• ${from?.name} recupera ${formatMoney(t.paidFrom, from?.currency ?? 'HNL')}`,
        `• A ${to?.name} se le restan ${formatMoney(t.paidTo, to?.currency ?? 'HNL')}`,
        'Los saldos reales de ambas unidades cambian.',
      );
    }
    if (t.kind === 'LOAN' && !t.repaymentOfId && t.repayment) lines.push('', 'También se elimina su devolución programada.');
    lines.push('', 'No se puede deshacer.');
    if (!(await confirmDialog({ title, message: lines.join('\n'), confirmLabel: moved ? 'Eliminar y revertir' : 'Eliminar', tone: 'danger' }))) return;
    try {
      await api(`/api/transfers/${t.id}`, { method: 'DELETE' });
      toast(moved ? 'Transferencia eliminada y caja revertida' : 'Transferencia eliminada');
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  }

  async function voidInternal(t: InternalTransferRow) {
    if (
      !(await confirmDialog({
        title: 'Anular transferencia',
        message: `¿Anular la transferencia ${t.fromAccountName} → ${t.toAccountName}? Se revierten los saldos de ambas cuentas.`,
        confirmLabel: 'Anular',
        tone: 'danger',
      }))
    )
      return;
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
              <TableTotals
                rows={internalRows.data}
                note={internalRows.data.some((t) => t.status === 'CANCELLED') ? 'sin anuladas' : undefined}
                noun={['transferencia', 'transferencias']}
                section={(t) => (t.status === 'CANCELLED' ? false : null)}
                columns={[null, null, null, (t) => ({ amount: t.amount, currency: app.entityById.get(t.entityId)?.currency ?? 'HNL' }), null, null]}
              />
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
                    <td className="td">
                      {formatDateYear(t.executedDate ?? t.expectedDate, app.today)}
                      {t.expenseDate && <div className="text-[11px] text-slate-500">Gasto del {formatDateYear(t.expenseDate, app.today)}</div>}
                    </td>
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
                        {!t.chargeLinked && (
                          <Button size="sm" variant="ghost" onClick={() => remove(t)} title={t.paidFrom > 0 || t.paidTo > 0 ? 'Eliminar y revertir (registrada por error)' : 'Eliminar (registrada por error)'}>
                            <Trash2 className="h-4 w-4 text-rose-500" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <TableTotals
              rows={data}
              note={data.some((t) => t.status === 'CANCELLED') ? 'sin canceladas' : undefined}
              noun={['transferencia', 'transferencias']}
              section={(t) => (t.status === 'CANCELLED' ? false : null)}
              columns={[
                null,
                null,
                null,
                (t) => ({ amount: t.amountFrom, currency: app.entityById.get(t.fromEntityId)?.currency ?? 'HNL' }),
                (t) => ({ amount: t.amountTo, currency: app.entityById.get(t.toEntityId)?.currency ?? 'HNL' }),
                null,
                null,
              ]}
            />
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
