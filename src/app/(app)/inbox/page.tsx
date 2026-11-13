'use client';

import { useState } from 'react';
import { Check, Inbox, X } from 'lucide-react';
import { useApp } from '@/components/AppContext';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Loading, Modal, Tabs, useToast } from '@/components/ui';
import { EntityDot } from '@/components/AppShell';
import { centsInput, parseMoneyInput } from '@/components/forms';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { formatMoney } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';

interface StagingRow {
  id: string;
  entityId: string;
  source: string | null;
  externalId: string | null;
  direction: 'IN' | 'OUT' | null;
  description: string | null;
  amount: number | null;
  dueDate: string | null;
  expectedDate: string | null;
  counterparty: string | null;
  payload: unknown;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  receivedAt: string;
}

type Status = 'PENDING' | 'APPROVED' | 'REJECTED';

export default function InboxPage() {
  const app = useApp();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('PENDING');
  const { data, error, loading } = useApi<StagingRow[]>(`/api/staging?status=${status}`);
  const [review, setReview] = useState<StagingRow | null>(null);
  const [form, setForm] = useState({ direction: 'IN', description: '', amount: '', dueDate: '', expectedDate: '', counterpartyName: '' });
  const [saving, setSaving] = useState(false);

  function open(row: StagingRow) {
    setReview(row);
    setForm({
      direction: row.direction ?? 'IN',
      description: row.description ?? '',
      amount: row.amount ? centsInput(row.amount) : '',
      dueDate: row.dueDate ?? app.today,
      expectedDate: row.expectedDate ?? row.dueDate ?? app.today,
      counterpartyName: row.counterparty ?? '',
    });
  }

  async function decide(row: StagingRow, action: 'approve' | 'reject') {
    setSaving(true);
    try {
      if (action === 'approve') {
        const amount = parseMoneyInput(form.amount);
        if (!amount) throw new Error('Monto inválido');
        await api(`/api/staging/${row.id}`, {
          body: { action, ...form, amount, counterpartyName: form.counterpartyName || undefined },
        });
      } else {
        await api(`/api/staging/${row.id}`, { body: { action } });
      }
      toast(action === 'approve' ? 'Aprobado: ya forma parte del flujo' : 'Rechazado');
      setReview(null);
      emitDataChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Inbox className="h-5 w-5" /> Bandeja de conciliación externa
          </h1>
          <p className="text-sm text-slate-500">Movimientos recibidos por webhook (CRM, n8n). Nada afecta el flujo hasta que lo apruebes.</p>
        </div>
        <Tabs<Status>
          tabs={[
            { id: 'PENDING', label: 'Pendientes' },
            { id: 'APPROVED', label: 'Aprobados' },
            { id: 'REJECTED', label: 'Rechazados' },
          ]}
          value={status}
          onChange={setStatus}
        />
      </div>

      <Card className="p-0 sm:p-0">
        {error ? (
          <div className="p-4">
            <ErrorBox message={error} />
          </div>
        ) : loading && !data ? (
          <Loading />
        ) : !data?.length ? (
          <EmptyState title="La bandeja está vacía">Genera un webhook por entidad en Configuración → Entidades e integraciones.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <th className="th">Recibido</th>
                  <th className="th">Entidad</th>
                  <th className="th">Descripción</th>
                  <th className="th">Tipo</th>
                  <th className="th">Vence</th>
                  <th className="th text-right">Monto</th>
                  <th className="th text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.map((s) => {
                  const e = app.entityById.get(s.entityId);
                  return (
                    <tr key={s.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="td text-xs text-slate-500">
                        {new Date(s.receivedAt).toLocaleString('es-HN')}
                        <div>{s.source}</div>
                      </td>
                      <td className="td">
                        <span className="inline-flex items-center gap-1.5">
                          {e && <EntityDot color={e.color} />} {e?.name}
                        </span>
                      </td>
                      <td className="td max-w-xs">
                        <div className="truncate font-medium">{s.description ?? <span className="text-slate-400">(sin descripción)</span>}</div>
                        <div className="text-xs text-slate-500">{s.counterparty}</div>
                      </td>
                      <td className="td">
                        {s.direction === 'IN' ? <Badge tone="green">Por cobrar</Badge> : s.direction === 'OUT' ? <Badge tone="red">Por pagar</Badge> : <Badge tone="amber">Sin tipo</Badge>}
                      </td>
                      <td className="td">{s.dueDate ? formatShortDate(s.dueDate) : '—'}</td>
                      <td className="td num font-semibold">{s.amount ? formatMoney(s.amount, e?.currency ?? 'HNL') : '—'}</td>
                      <td className="td">
                        {s.status === 'PENDING' && (
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="primary" onClick={() => open(s)}>
                              <Check className="h-3.5 w-3.5" /> Revisar
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => decide(s, 'reject')} title="Rechazar">
                              <X className="h-4 w-4 text-rose-500" />
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

      <Modal
        open={Boolean(review)}
        onClose={() => setReview(null)}
        title="Revisar y aprobar"
        wide
        footer={
          <>
            <Button onClick={() => review && decide(review, 'reject')} disabled={saving}>
              Rechazar
            </Button>
            <Button variant="primary" loading={saving} onClick={() => review && decide(review, 'approve')}>
              Aprobar e integrar al flujo
            </Button>
          </>
        }
      >
        {review && (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <Field label="Tipo">
                <select className="input" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                  <option value="IN">Cuenta por cobrar</option>
                  <option value="OUT">Cuenta por pagar</option>
                </select>
              </Field>
              <Field label="Descripción">
                <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
              <Field label="Contraparte">
                <input className="input" value={form.counterpartyName} onChange={(e) => setForm({ ...form, counterpartyName: e.target.value })} />
              </Field>
              <Field label={`Monto (${app.entityById.get(review.entityId)?.currency ?? ''})`}>
                <input className="input text-right" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Vencimiento">
                  <input className="input" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
                </Field>
                <Field label="Fecha esperada">
                  <input className="input" type="date" value={form.expectedDate} onChange={(e) => setForm({ ...form, expectedDate: e.target.value })} />
                </Field>
              </div>
            </div>
            <div>
              <span className="label">Datos recibidos</span>
              <pre className="max-h-80 overflow-auto rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-800">{JSON.stringify(review.payload, null, 2)}</pre>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
