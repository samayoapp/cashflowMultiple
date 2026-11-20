'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Inbox, X } from 'lucide-react';
import { useApp } from '@/components/AppContext';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Loading, Modal, TableTotals, Tabs, useToast } from '@/components/ui';
import { CategorySelect } from '@/components/CategorySelect';
import { EntityDot } from '@/components/AppShell';
import { centsInput, parseMoneyInput } from '@/components/forms';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { formatMoney } from '@/lib/money';
import { formatShortDate } from '@/lib/dates';
import { convertPair, rate4 } from '@/lib/projection/fx';
import { INSTALLMENT_OPTIONS } from '@/components/cards';
import type { AccountDto } from '@/lib/server/dto';

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
  currency: 'HNL' | 'USD' | null;
  cardHint: string | null;
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
  const [form, setForm] = useState({ direction: 'IN', description: '', amount: '', dueDate: '', expectedDate: '', counterpartyName: '', categoryId: '' });
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'obligation' | 'card'>('obligation');
  const [cardForm, setCardForm] = useState({ cardAccountId: '', installments: 1, categoryId: '', purchaseDate: '', currency: '', amount: '' });
  const reviewEntity = review ? app.entityById.get(review.entityId) : undefined;
  const accounts = useApi<AccountDto[]>(review ? `/api/accounts?ctx=${review.entityId}` : null);
  const cards = useMemo(() => (accounts.data ?? []).filter((a) => a.type === 'CREDIT_CARD' && !a.archived), [accounts.data]);
  const selectedCard = cards.find((c) => c.id === cardForm.cardAccountId);

  // Preselecciona la tarjeta que coincide con la pista recibida (o la primera)
  useEffect(() => {
    if (!review || !cards.length || cardForm.cardAccountId) return;
    const hint = review.cardHint?.toLowerCase();
    const match = hint ? cards.find((c) => c.name.toLowerCase().includes(hint) || hint.includes(c.name.toLowerCase())) : undefined;
    setCardForm((f) => ({ ...f, cardAccountId: (match ?? cards[0]).id }));
    if (match) setMode('card');
  }, [review, cards, cardForm.cardAccountId]);

  /** Monto convertido a la moneda de la entidad si llegó en otra (a la tasa vigente). */
  function toEntityCurrency(row: StagingRow): { amount: string; note: string | null } {
    const entCur = app.entityById.get(row.entityId)?.currency ?? 'HNL';
    if (!row.amount) return { amount: '', note: null };
    if (!row.currency || row.currency === entCur) return { amount: centsInput(row.amount), note: null };
    const r = app.fx?.effectiveSellRate;
    if (!r || !['HNL', 'USD'].includes(entCur)) return { amount: '', note: `Llegó en ${row.currency}: ingresa el equivalente en ${entCur}` };
    const conv = convertPair(row.amount, row.currency, entCur, rate4(r));
    return { amount: centsInput(conv), note: `Convertido de ${formatMoney(row.amount, row.currency)} @ ${r}` };
  }

  function open(row: StagingRow) {
    setReview(row);
    setMode('obligation');
    setCardForm({
      cardAccountId: '',
      installments: 1,
      categoryId: '',
      purchaseDate: row.dueDate ?? app.today,
      currency: row.currency ?? '',
      amount: row.amount ? centsInput(row.amount) : '',
    });
    setForm({
      direction: row.direction ?? 'IN',
      description: row.description ?? '',
      amount: toEntityCurrency(row).amount,
      dueDate: row.dueDate ?? app.today,
      expectedDate: row.expectedDate ?? row.dueDate ?? app.today,
      counterpartyName: row.counterparty ?? '',
      categoryId: '',
    });
  }

  async function decide(row: StagingRow, action: 'approve' | 'reject') {
    setSaving(true);
    try {
      if (action === 'approve' && mode === 'card') {
        const amount = parseMoneyInput(cardForm.amount);
        if (!amount) throw new Error('Monto inválido');
        if (!cardForm.cardAccountId) throw new Error('Selecciona la tarjeta');
        await api(`/api/staging/${row.id}`, {
          body: {
            action: 'approve_card',
            cardAccountId: cardForm.cardAccountId,
            installments: cardForm.installments,
            categoryId: cardForm.categoryId || null,
            purchaseDate: cardForm.purchaseDate || undefined,
            description: form.description || undefined,
            counterpartyName: form.counterpartyName || undefined,
            amount,
            currency: cardForm.currency || undefined,
          },
        });
      } else if (action === 'approve') {
        const amount = parseMoneyInput(form.amount);
        if (!amount) throw new Error('Monto inválido');
        await api(`/api/staging/${row.id}`, {
          body: { action, ...form, amount, counterpartyName: form.counterpartyName || undefined, categoryId: form.categoryId || null },
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
          <EmptyState title="La bandeja está vacía">Genera un webhook por unidad de negocio en Ajustes → Datos e integración.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <th className="th">Recibido</th>
                  <th className="th">Unidad de negocio</th>
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
                      <td className="td num font-semibold">
                        {s.amount ? formatMoney(s.amount, s.currency ?? e?.currency ?? 'HNL') : '—'}
                        {s.currency && s.currency !== e?.currency && (
                          <div>
                            <Badge tone="blue">{s.currency}</Badge>
                          </div>
                        )}
                        {s.cardHint && <div className="text-[11px] font-normal text-slate-500">Tarjeta: {s.cardHint}</div>}
                      </td>
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
              <TableTotals
                rows={data}
                section={(s) => (s.direction === 'IN' ? 'Por cobrar' : s.direction === 'OUT' ? 'Por pagar' : 'Sin tipo')}
                columns={[
                  null,
                  null,
                  null,
                  null,
                  null,
                  (s) => (s.amount ? { amount: s.amount, currency: s.currency ?? app.entityById.get(s.entityId)?.currency ?? 'HNL' } : null),
                  null,
                ]}
              />
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
              {mode === 'card' ? 'Aprobar como consumo con tarjeta' : 'Aprobar e integrar al flujo'}
            </Button>
          </>
        }
      >
        {review && (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <Tabs<'obligation' | 'card'>
                tabs={[
                  { id: 'obligation', label: 'CxC / CxP' },
                  { id: 'card', label: 'Consumo con tarjeta' },
                ]}
                value={mode}
                onChange={setMode}
              />
              {mode === 'obligation' && (
                <Field label="Tipo">
                  <select className="input" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value, categoryId: '' })}>
                    <option value="IN">Cuenta por cobrar</option>
                    <option value="OUT">Cuenta por pagar</option>
                  </select>
                </Field>
              )}
              <Field label="Descripción">
                <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
              <Field label="Contraparte">
                <input className="input" value={form.counterpartyName} onChange={(e) => setForm({ ...form, counterpartyName: e.target.value })} />
              </Field>
              {mode === 'card' ? (
                <CardApprovalFields
                  cards={cards}
                  loaded={Boolean(accounts.data)}
                  entityCurrency={reviewEntity?.currency ?? 'HNL'}
                  selectedCard={selectedCard}
                  entityId={review.entityId}
                  value={cardForm}
                  onChange={setCardForm}
                />
              ) : (
                <>
                  <Field label={`Monto (${app.entityById.get(review.entityId)?.currency ?? ''})`} hint={toEntityCurrency(review).note ?? undefined}>
                    <input className="input text-right" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                  </Field>
                  <CategorySelect
                    entityId={review.entityId}
                    direction={form.direction === 'OUT' ? 'OUT' : 'IN'}
                    value={form.categoryId}
                    onChange={(categoryId) => setForm({ ...form, categoryId })}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Vencimiento">
                      <input className="input" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
                    </Field>
                    <Field label="Fecha esperada">
                      <input className="input" type="date" value={form.expectedDate} onChange={(e) => setForm({ ...form, expectedDate: e.target.value })} />
                    </Field>
                  </div>
                </>
              )}
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

type CardForm = { cardAccountId: string; installments: number; categoryId: string; purchaseDate: string; currency: string; amount: string };

/** Campos para aprobar un elemento de la bandeja como consumo con tarjeta (en su moneda original). */
function CardApprovalFields({
  cards,
  loaded,
  entityCurrency,
  selectedCard,
  entityId,
  value,
  onChange,
}: {
  cards: AccountDto[];
  loaded: boolean;
  entityCurrency: string;
  selectedCard: AccountDto | undefined;
  entityId: string;
  value: CardForm;
  onChange: (v: CardForm) => void;
}) {
  if (loaded && cards.length === 0) return <ErrorBox message="La unidad de negocio no tiene tarjetas de crédito." />;
  return (
    <>
      <Field label="Tarjeta">
        <select className="input" value={value.cardAccountId} onChange={(e) => onChange({ ...value, cardAccountId: e.target.value })}>
          {cards.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.foreignCurrency ? ' (bimoneda)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Monto">
          <div className="flex gap-1">
            <select className="input w-20 shrink-0 px-2" value={value.currency || entityCurrency} onChange={(e) => onChange({ ...value, currency: e.target.value })}>
              <option value={entityCurrency}>{entityCurrency}</option>
              {selectedCard?.foreignCurrency && <option value={selectedCard.foreignCurrency}>{selectedCard.foreignCurrency}</option>}
            </select>
            <input className="input min-w-0 text-right" inputMode="decimal" value={value.amount} onChange={(e) => onChange({ ...value, amount: e.target.value })} />
          </div>
        </Field>
        <Field label="Cuotas">
          <select className="input" value={value.installments} onChange={(e) => onChange({ ...value, installments: Number(e.target.value) })}>
            {INSTALLMENT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 1 ? 'Contado (1)' : `${n} cuotas`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <CategorySelect entityId={entityId} direction="OUT" value={value.categoryId} onChange={(categoryId) => onChange({ ...value, categoryId })} label="Categoría" />
        <Field label="Fecha de compra">
          <input className="input" type="date" value={value.purchaseDate} onChange={(e) => onChange({ ...value, purchaseDate: e.target.value })} />
        </Field>
      </div>
    </>
  );
}
