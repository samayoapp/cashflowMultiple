'use client';

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CreditCard } from 'lucide-react';
import type { AccountDto } from '@/lib/server/dto';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { formatMoney, toCents, type Cents } from '@/lib/money';
import { formatLongDate, formatShortDate } from '@/lib/dates';
import { buildSchedule, paymentDateForPurchase } from '@/lib/projection/card-cycle';
import { useApp } from './AppContext';
import { Badge, Button, ErrorBox, Field, Modal, Tabs, useToast } from './ui';
import { centsInput, parseMoneyInput } from './forms';

export const INSTALLMENT_OPTIONS = [1, 2, 3, 4, 5, 6, 9, 10, 12, 15, 18, 24, 36];

export const isCard = (a: Pick<AccountDto, 'type'>) => a.type === 'CREDIT_CARD';
export const liquidAccounts = <T extends Pick<AccountDto, 'type' | 'archived'>>(list: T[] | null | undefined) =>
  (list ?? []).filter((a) => !a.archived && a.type !== 'CREDIT_CARD');

function useSubmit() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  async function run(fn: () => Promise<void>, okMsg: string) {
    setLoading(true);
    setError(null);
    try {
      await fn();
      toast(okMsg);
      emitDataChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
      return false;
    } finally {
      setLoading(false);
    }
  }
  return { loading, error, setError, run };
}

/** Badge + calendario de cuotas de un consumo con tarjeta (calculado en el cliente). */
export function CardImpactPreview({
  card,
  purchaseDate,
  amount,
  installments,
  currency,
}: {
  card: Pick<AccountDto, 'statementDay' | 'paymentDueDay'> | null | undefined;
  purchaseDate: string;
  amount: Cents | null;
  installments: number;
  currency: string;
}) {
  if (!card?.statementDay || !card.paymentDueDay || !purchaseDate) return null;
  const cycle = { statementDay: card.statementDay, paymentDueDay: card.paymentDueDay };
  const first = paymentDateForPurchase(purchaseDate, cycle);
  const schedule = amount && amount > 0 && installments > 1 ? buildSchedule(purchaseDate, amount, installments, cycle) : null;
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-4 w-4 shrink-0" />
        <span>
          Este consumo impactará tu flujo de efectivo el <strong>{formatLongDate(first)}</strong>
          {schedule && <> (cuota 1 de {installments})</>}.
        </span>
      </div>
      {schedule && (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-3">
          {schedule.map((s) => (
            <span key={s.number} className="tabular-nums">
              {s.number}/{s.count} · {formatShortDate(s.dueDate)} · {formatMoney(s.amount, currency)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Consumo con tarjeta / pagado por tercero
type Mode = 'card' | 'third';

export function CardChargeModal({
  open,
  onClose,
  entityId: fixedEntityId,
  cardId: fixedCardId,
}: {
  open: boolean;
  onClose: () => void;
  entityId?: string;
  cardId?: string;
}) {
  const app = useApp();
  const defaultEntity = fixedEntityId ?? app.currentEntity?.id ?? app.activeEntities[0]?.id ?? '';
  const { loading, error, run, setError } = useSubmit();
  const [mode, setMode] = useState<Mode>('card');
  const [entityId, setEntityId] = useState(defaultEntity);
  const [cardId, setCardId] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(app.today);
  const [description, setDescription] = useState('');
  const [supplier, setSupplier] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [installments, setInstallments] = useState(1);
  // tercero
  const [ownerKind, setOwnerKind] = useState<'PERSON' | 'ENTITY'>('PERSON');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEntityId, setOwnerEntityId] = useState('');
  const [ownerCardId, setOwnerCardId] = useState('');
  const [amountTo, setAmountTo] = useState('');
  const [reimburseDate, setReimburseDate] = useState(app.today);

  const accounts = useApi<AccountDto[]>(open && entityId ? `/api/accounts?ctx=${entityId}` : null);
  const ownerAccounts = useApi<AccountDto[]>(open && mode === 'third' && ownerKind === 'ENTITY' && ownerEntityId ? `/api/accounts?ctx=${ownerEntityId}` : null);
  const catalog = useApi<{
    counterparties: { id: string; name: string }[];
    categories: { id: string; name: string; direction: 'IN' | 'OUT' }[];
  }>(open && entityId ? `/api/catalog?ctx=${entityId}` : null);

  const cards = useMemo(() => (accounts.data ?? []).filter((a) => isCard(a) && !a.archived), [accounts.data]);
  const ownerCards = useMemo(() => (ownerAccounts.data ?? []).filter((a) => isCard(a) && !a.archived), [ownerAccounts.data]);
  const card = cards.find((c) => c.id === cardId);
  const currency = app.entityById.get(entityId)?.currency ?? 'HNL';
  const ownerEntity = app.entityById.get(ownerEntityId);
  const sameCurrency = !ownerEntity || ownerEntity.currency === currency;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setMode('card');
    setEntityId(fixedEntityId ?? defaultEntity);
    setCardId(fixedCardId ?? '');
    setPurchaseDate(app.today);
    setReimburseDate(app.today);
    setDescription('');
    setSupplier('');
    setCategoryId('');
    setAmount('');
    setInstallments(1);
    setOwnerKind('PERSON');
    setOwnerName('');
    setOwnerEntityId('');
    setOwnerCardId('');
    setAmountTo('');
  }, [open, fixedEntityId, fixedCardId, defaultEntity, app.today, setError]);

  useEffect(() => {
    if (cards.length && !cards.some((c) => c.id === cardId)) setCardId(cards[0].id);
  }, [cards, cardId]);

  const parsed = parseMoneyInput(amount);
  const cents = parsed && Number(parsed) > 0 ? toCents(parsed) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!parsed || Number(parsed) <= 0) return setError('Monto inválido');
    const common = {
      purchaseDate,
      description,
      amount: parsed,
      categoryId: categoryId || null,
      counterpartyName: supplier.trim() || null,
    };
    if (mode === 'card') {
      if (!cardId) return setError('Selecciona la tarjeta');
      const ok = await run(
        () => api(`/api/cards/${cardId}/charges`, { body: { ...common, installments } }),
        installments > 1 ? `Consumo registrado en ${installments} cuotas` : 'Consumo registrado',
      );
      if (ok) onClose();
      return;
    }
    let owner: Record<string, unknown>;
    if (ownerKind === 'PERSON') {
      if (!ownerName.trim()) return setError('Indica la persona dueña de la tarjeta');
      owner = { kind: 'PERSON', name: ownerName.trim() };
    } else {
      if (!ownerEntityId) return setError('Selecciona la entidad dueña de la tarjeta');
      const at = sameCurrency ? parsed : parseMoneyInput(amountTo);
      if (!at || Number(at) <= 0) return setError(`Indica el monto en ${ownerEntity?.currency}`);
      owner = { kind: 'ENTITY', entityId: ownerEntityId, amountTo: at, cardAccountId: ownerCardId || null };
    }
    const ok = await run(
      () => api('/api/reimbursements', { body: { ...common, entityId, reimburseDate, owner } }),
      'Gasto registrado con reembolso pendiente',
    );
    if (ok) onClose();
  }

  const outCategories = (catalog.data?.categories ?? []).filter((c) => c.direction === 'OUT');

  return (
    <Modal open={open} onClose={onClose} title="Gasto con tarjeta de crédito" wide>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Tabs<Mode>
          tabs={[
            { id: 'card', label: 'Tarjeta de la entidad' },
            { id: 'third', label: 'Pagado por tercero / otra entidad' },
          ]}
          value={mode}
          onChange={setMode}
        />
        <div className="grid grid-cols-2 gap-3">
          {!fixedEntityId && (
            <Field label="Entidad que registra el gasto">
              <select className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)} required>
                {app.activeEntities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.currency})
                  </option>
                ))}
              </select>
            </Field>
          )}
          {mode === 'card' && (
            <Field label="Tarjeta">
              {accounts.data && cards.length === 0 ? (
                <p className="text-sm text-rose-600">Esta entidad no tiene tarjetas. Créala en Configuración → Cuentas.</p>
              ) : (
                <select className="input" value={cardId} onChange={(e) => setCardId(e.target.value)} required disabled={Boolean(fixedCardId)}>
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · corte {c.statementDay} / pago {c.paymentDueDay}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
        </div>
        <Field label="Descripción">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={200} placeholder="Licencia Adobe, combustible, insumos…" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Proveedor (opcional)">
            <input className="input" list="cf-card-suppliers" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            <datalist id="cf-card-suppliers">
              {catalog.data?.counterparties.map((c) => <option key={c.id} value={c.name} />)}
            </datalist>
          </Field>
          <Field label="Categoría del gasto">
            <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Sin categoría</option>
              {outCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={`Monto total (${currency})`}>
            <input className="input text-right" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Fecha de compra">
            <input className="input" type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} required />
          </Field>
          {mode === 'card' ? (
            <Field label="Cuotas">
              <select className="input" value={installments} onChange={(e) => setInstallments(Number(e.target.value))}>
                {INSTALLMENT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? 'Contado (1)' : `${n} cuotas`}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Fecha de reembolso">
              <input className="input" type="date" value={reimburseDate} onChange={(e) => setReimburseDate(e.target.value)} required />
            </Field>
          )}
        </div>

        {mode === 'card' && <CardImpactPreview card={card} purchaseDate={purchaseDate} amount={cents} installments={installments} currency={currency} />}

        {mode === 'third' && (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <p className="text-xs text-slate-500">
              El gasto queda clasificado en esta entidad y se crea una CxP de reembolso a favor del dueño de la tarjeta.
            </p>
            <Tabs<'PERSON' | 'ENTITY'>
              tabs={[
                { id: 'PERSON', label: 'Persona' },
                { id: 'ENTITY', label: 'Otra entidad' },
              ]}
              value={ownerKind}
              onChange={setOwnerKind}
            />
            {ownerKind === 'PERSON' ? (
              <Field label="Dueño de la tarjeta">
                <input className="input" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Nombre de la persona" />
              </Field>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Entidad dueña">
                    <select className="input" value={ownerEntityId} onChange={(e) => setOwnerEntityId(e.target.value)}>
                      <option value="">Selecciona…</option>
                      {app.activeEntities
                        .filter((e) => e.id !== entityId)
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name} ({e.currency})
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Tarjeta usada (opcional)" hint="Proyecta el pago en esa tarjeta">
                    <select className="input" value={ownerCardId} onChange={(e) => setOwnerCardId(e.target.value)} disabled={!ownerEntityId}>
                      <option value="">No registrar en tarjeta</option>
                      {ownerCards.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {!sameCurrency && (
                  <Field label={`Monto en ${ownerEntity?.currency}`}>
                    <input className="input text-right" inputMode="decimal" value={amountTo} onChange={(e) => setAmountTo(e.target.value)} />
                  </Field>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading} disabled={mode === 'card' && !cardId}>
            Registrar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Pago de tarjeta
export interface CardPaymentTarget {
  cardId: string;
  entityId: string;
  /** Monto sugerido (p. ej. el estado de cuenta próximo). */
  suggested?: Cents;
}

export function CardPaymentModal({ open, onClose, target }: { open: boolean; onClose: () => void; target: CardPaymentTarget | null }) {
  const app = useApp();
  const { loading, error, run, setError } = useSubmit();
  const accounts = useApi<AccountDto[]>(open && target ? `/api/accounts?ctx=${target.entityId}` : null);
  const summary = useApi<{ id: string; debt: Cents; nextPayment: { dueDate: string; pending: Cents } | null }[]>(
    open && target ? `/api/cards?ctx=${target.entityId}` : null,
  );
  const sources = useMemo(() => liquidAccounts(accounts.data), [accounts.data]);
  const card = accounts.data?.find((a) => a.id === target?.cardId);
  const info = summary.data?.find((c) => c.id === target?.cardId);
  const [fromAccountId, setFrom] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(app.today);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDate(app.today);
    setAmount(target?.suggested ? centsInput(target.suggested) : '');
  }, [open, target, app.today, setError]);

  useEffect(() => {
    if (!amount && info?.nextPayment) setAmount(centsInput(info.nextPayment.pending));
  }, [info, amount]);

  useEffect(() => {
    if (!sources.length) return;
    if (sources.some((a) => a.id === fromAccountId)) return;
    const preferred = sources.find((a) => a.id === card?.defaultPaymentAccountId);
    setFrom((preferred ?? sources[0]).id);
  }, [sources, fromAccountId, card]);

  if (!target) return null;
  const currency = app.entityById.get(target.entityId)?.currency ?? 'HNL';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = parseMoneyInput(amount);
    if (a === null || Number(a) <= 0) return setError('Monto inválido');
    const ok = await run(() => api(`/api/cards/${target!.cardId}/payments`, { body: { fromAccountId, amount: a, date } }), 'Pago de tarjeta registrado');
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={`Pagar tarjeta${card ? `: ${card.name}` : ''}`}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge tone="red">Deuda total: {formatMoney(info?.debt ?? 0, currency)}</Badge>
          {info?.nextPayment && (
            <Badge tone="amber">
              Próximo pago {formatShortDate(info.nextPayment.dueDate)}: {formatMoney(info.nextPayment.pending, currency)}
            </Badge>
          )}
        </div>
        {accounts.data && sources.length === 0 ? (
          <ErrorBox message="La entidad no tiene cuentas líquidas activas para pagar la tarjeta." />
        ) : (
          <Field label="Cuenta de origen">
            <select className="input" value={fromAccountId} onChange={(e) => setFrom(e.target.value)} required>
              {sources.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {formatMoney(a.balance, currency)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Monto (${currency})`}>
            <input className="input text-right" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            <div className="mt-1 flex gap-2 text-xs">
              {info?.nextPayment && (
                <button type="button" className="text-brand-600 hover:underline" onClick={() => setAmount(centsInput(info.nextPayment!.pending))}>
                  Estado próximo
                </button>
              )}
              {info && info.debt > 0 && (
                <button type="button" className="text-brand-600 hover:underline" onClick={() => setAmount(centsInput(info.debt))}>
                  Deuda total
                </button>
              )}
            </div>
          </Field>
          <Field label="Fecha efectiva">
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        <p className="text-xs text-slate-500">
          Reduce el saldo del banco y la deuda de la tarjeta, y liquida las cuotas más antiguas primero. No registra un gasto nuevo.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading} disabled={!fromAccountId}>
            <CreditCard className="h-4 w-4" /> Registrar pago
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export const cardStatusBadge: Record<string, { label: string; tone: 'slate' | 'green' | 'amber' | 'red' }> = {
  OPEN: { label: 'Pendiente', tone: 'slate' },
  PARTIAL: { label: 'Pago parcial', tone: 'amber' },
  PAID: { label: 'Pagado', tone: 'green' },
  OVERDUE: { label: 'Vencido', tone: 'red' },
};
