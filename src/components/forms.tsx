'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AccountDto, EntityDto } from '@/lib/server/dto';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { centsToDecimalString, formatMoney, type Cents } from '@/lib/money';
import { addDays } from '@/lib/dates';
import { useApp } from './AppContext';
import { Button, ErrorBox, Field, Modal, Toggle, useToast } from './ui';
import { CardImpactPreview, INSTALLMENT_OPTIONS, isCard, liquidAccounts } from './cards';

const CURRENCIES = ['HNL', 'USD', 'EUR'];
const PALETTE = ['#10b981', '#6366f1', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899', '#84cc16'];

/** "1,234.50" -> "1234.50" ; devuelve null si no es un monto válido */
export function parseMoneyInput(s: string): string | null {
  const clean = s.replace(/[\s,]/g, '').replace(/^L\.?|^\$/i, '');
  return /^-?\d+(\.\d{1,2})?$/.test(clean) ? clean : null;
}

export const centsInput = (c: Cents) => centsToDecimalString(c);

function useSubmit() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  async function run(fn: () => Promise<void>, okMsg?: string) {
    setLoading(true);
    setError(null);
    try {
      await fn();
      if (okMsg) toast(okMsg);
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

function EntitySelect({ value, onChange, exclude }: { value: string; onChange: (v: string) => void; exclude?: string }) {
  const app = useApp();
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">Selecciona…</option>
      {app.activeEntities
        .filter((e) => e.id !== exclude)
        .map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} ({e.currency})
          </option>
        ))}
    </select>
  );
}

/** Entidad por defecto para formularios: la del contexto o la primera. */
function useDefaultEntityId() {
  const app = useApp();
  return app.currentEntity?.id ?? app.activeEntities[0]?.id ?? '';
}

// ---------------------------------------------------------------- Entidad
export function EntityFormModal({
  open,
  onClose,
  onSaved,
  entity,
}: {
  open: boolean;
  onClose: () => void;
  onSaved?: (e: EntityDto) => void | Promise<void>;
  entity?: EntityDto | null;
}) {
  const { loading, error, run, setError } = useSubmit();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('HNL');
  const [color, setColor] = useState(PALETTE[1]);
  const [threshold, setThreshold] = useState('0');

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(entity?.name ?? '');
    setCurrency(entity?.currency ?? 'HNL');
    setColor(entity?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]);
    setThreshold(entity ? centsInput(entity.minCashThreshold) : '0');
  }, [open, entity, setError]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = parseMoneyInput(threshold);
    if (t === null) return setError('Umbral inválido');
    const body = { name, currency, color, minCashThreshold: t };
    const ok = await run(async () => {
      const saved = entity
        ? await api<EntityDto>(`/api/entities/${entity.id}`, { method: 'PATCH', body })
        : await api<EntityDto>('/api/entities', { body });
      await onSaved?.(saved);
    }, entity ? 'Entidad actualizada' : 'Entidad creada');
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={entity ? 'Editar entidad' : 'Nueva entidad'}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label="Nombre">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Moneda base" hint={entity ? 'Solo editable si no tiene datos' : undefined}>
            <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Umbral mínimo de caja">
            <input className="input text-right" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </Field>
        </div>
        <Field label="Color identificador">
          <div className="flex flex-wrap items-center gap-2">
            {PALETTE.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setColor(c)}
                className="h-7 w-7 rounded-full ring-offset-2 dark:ring-offset-slate-900"
                style={{ backgroundColor: c, boxShadow: color === c ? `0 0 0 2px ${c}` : undefined }}
                aria-label={c}
              />
            ))}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-10 cursor-pointer rounded" />
          </div>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Cuenta
export function AccountFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const defaultEntity = useDefaultEntityId();
  const { loading, error, run, setError } = useSubmit();
  const [entityId, setEntityId] = useState(defaultEntity);
  const [name, setName] = useState('');
  const [type, setType] = useState('BANK');
  const [institution, setInstitution] = useState('');
  const [opening, setOpening] = useState('0');
  const [date, setDate] = useState(app.today);
  const [creditLimit, setCreditLimit] = useState('');
  const [statementDay, setStatementDay] = useState('15');
  const [paymentDueDay, setPaymentDueDay] = useState('5');
  const [payFrom, setPayFrom] = useState('');
  const isCardType = type === 'CREDIT_CARD';
  const entityAccounts = useApi<AccountDto[]>(open && isCardType && entityId ? `/api/accounts?ctx=${entityId}` : null);
  const payable = useMemo(() => liquidAccounts(entityAccounts.data), [entityAccounts.data]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEntityId(defaultEntity);
    setName('');
    setType('BANK');
    setInstitution('');
    setOpening('0');
    setDate(app.today);
    setCreditLimit('');
    setStatementDay('15');
    setPaymentDueDay('5');
    setPayFrom('');
  }, [open, defaultEntity, app.today, setError]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseMoneyInput(opening);
    if (amount === null || (isCardType && Number(amount) < 0)) return setError(isCardType ? 'Deuda inválida' : 'Saldo inválido');
    const limit = creditLimit.trim() ? parseMoneyInput(creditLimit) : null;
    if (creditLimit.trim() && limit === null) return setError('Límite inválido');
    const sd = Number(statementDay);
    const pd = Number(paymentDueDay);
    if (isCardType && (!(sd >= 1 && sd <= 31) || !(pd >= 1 && pd <= 31))) return setError('Los días deben estar entre 1 y 31');
    const body = {
      entityId,
      name,
      type,
      institution,
      openingBalance: amount,
      openingDate: date,
      ...(isCardType ? { creditLimit: limit, statementDay: sd, paymentDueDay: pd, defaultPaymentAccountId: payFrom || null } : {}),
    };
    const ok = await run(() => api('/api/accounts', { body }), isCardType ? 'Tarjeta creada' : 'Cuenta creada');
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Nueva cuenta / caja">
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label="Entidad">
          <EntitySelect value={entityId} onChange={setEntityId} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nombre">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="BAC Corriente" />
          </Field>
          <Field label="Tipo">
            <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="BANK">Cuenta bancaria</option>
              <option value="CASH">Caja chica</option>
              <option value="WALLET">Billetera digital</option>
              <option value="CREDIT_CARD">Tarjeta de crédito</option>
            </select>
          </Field>
        </div>
        <Field label={isCardType ? 'Banco emisor (opcional)' : 'Institución (opcional)'}>
          <input className="input" value={institution} onChange={(e) => setInstitution(e.target.value)} />
        </Field>
        {isCardType && (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Día de corte">
                <input className="input text-right" type="number" min={1} max={31} value={statementDay} onChange={(e) => setStatementDay(e.target.value)} required />
              </Field>
              <Field label="Día límite de pago">
                <input className="input text-right" type="number" min={1} max={31} value={paymentDueDay} onChange={(e) => setPaymentDueDay(e.target.value)} required />
              </Field>
              <Field label="Límite (opcional)">
                <input className="input text-right" inputMode="decimal" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
              </Field>
            </div>
            <Field label="Cuenta de pago por defecto (opcional)">
              <select className="input" value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
                <option value="">Ninguna</option>
                {payable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-xs text-slate-500">
              Las compras hasta el día de corte se pagan en la siguiente fecha límite; las posteriores, en la del ciclo subsiguiente.
              La tarjeta no suma a la Caja real hoy.
            </p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={`${isCardType ? 'Deuda actual' : 'Saldo actual'} (${app.entityById.get(entityId)?.currency ?? ''})`} hint={isCardType ? 'Se proyecta en la próxima fecha de pago' : undefined}>
            <input className="input text-right" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </Field>
          <Field label="Fecha del saldo">
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            {isCardType ? 'Crear tarjeta' : 'Crear cuenta'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Partida CxC / CxP
export interface ObligationLike {
  id: string;
  entityId: string;
  direction: 'IN' | 'OUT';
  description: string;
  amount: Cents;
  paid: Cents;
  remaining: Cents;
  dueDate: string;
  expectedDate: string;
  priority: 'FIXED' | 'FLEXIBLE';
  isHypothetical: boolean;
  counterparty: { id: string; name: string } | null;
  notes: string | null;
  transferId: string | null;
}

export function ObligationFormModal({
  open,
  onClose,
  direction,
  obligation,
  hypothetical,
}: {
  open: boolean;
  onClose: () => void;
  direction: 'IN' | 'OUT';
  obligation?: ObligationLike | null;
  hypothetical?: boolean;
}) {
  const app = useApp();
  const defaultEntity = useDefaultEntityId();
  const { loading, error, run, setError } = useSubmit();
  const [entityId, setEntityId] = useState(defaultEntity);
  const [description, setDescription] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(app.today);
  const [expectedDate, setExpectedDate] = useState(app.today);
  const [priority, setPriority] = useState<'FIXED' | 'FLEXIBLE'>('FLEXIBLE');
  const [isHypothetical, setIsHypothetical] = useState(false);
  const [notes, setNotes] = useState('');
  const catalog = useApi<{ counterparties: { id: string; entityId: string; name: string }[] }>(
    open && entityId ? `/api/catalog?ctx=${entityId}` : null,
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEntityId(obligation?.entityId ?? defaultEntity);
    setDescription(obligation?.description ?? '');
    setCounterparty(obligation?.counterparty?.name ?? '');
    setAmount(obligation ? centsInput(obligation.amount) : '');
    setDueDate(obligation?.dueDate ?? app.today);
    setExpectedDate(obligation?.expectedDate ?? app.today);
    setPriority(obligation?.priority ?? (direction === 'OUT' ? 'FIXED' : 'FLEXIBLE'));
    setIsHypothetical(obligation?.isHypothetical ?? Boolean(hypothetical));
    setNotes(obligation?.notes ?? '');
  }, [open, obligation, defaultEntity, app.today, direction, hypothetical, setError]);

  const isIn = (obligation?.direction ?? direction) === 'IN';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = parseMoneyInput(amount);
    if (a === null || Number(a) <= 0) return setError('Monto inválido');
    const base = {
      description,
      amount: a,
      dueDate,
      expectedDate,
      priority,
      counterpartyName: counterparty.trim() || null,
      notes: notes || null,
    };
    const ok = await run(
      () =>
        obligation
          ? api(`/api/obligations/${obligation.id}`, { method: 'PATCH', body: base })
          : api('/api/obligations', { body: { ...base, entityId, direction, isHypothetical } }),
      obligation ? 'Partida actualizada' : 'Partida registrada',
    );
    if (ok) onClose();
  }

  const title = `${obligation ? 'Editar' : 'Nueva'} ${isIn ? 'cuenta por cobrar' : 'cuenta por pagar'}${isHypothetical ? ' (hipotética)' : ''}`;

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        {!obligation && (
          <Field label="Entidad">
            <EntitySelect value={entityId} onChange={setEntityId} />
          </Field>
        )}
        <Field label="Descripción">
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            maxLength={200}
            placeholder={isIn ? 'Factura 001-245 Campaña Navidad' : 'Pago proveedor de impresión'}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={isIn ? 'Cliente' : 'Proveedor'}>
            <input className="input" list="cf-counterparties" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
            <datalist id="cf-counterparties">
              {catalog.data?.counterparties.map((c) => <option key={c.id} value={c.name} />)}
            </datalist>
          </Field>
          <Field label={`Monto total (${app.entityById.get(entityId)?.currency ?? ''})`}>
            <input className="input text-right" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vencimiento contractual">
            <input
              className="input"
              type="date"
              value={dueDate}
              onChange={(e) => {
                if (expectedDate === dueDate) setExpectedDate(e.target.value);
                setDueDate(e.target.value);
              }}
              required
            />
          </Field>
          <Field label="Fecha esperada" hint="La proyección usa esta fecha">
            <input className="input" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} required />
          </Field>
        </div>
        {!isIn && (
          <Field label="Prioridad">
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as 'FIXED' | 'FLEXIBLE')}>
              <option value="FIXED">Inamovible (planilla, impuestos, préstamos)</option>
              <option value="FLEXIBLE">Flexible / negociable</option>
            </select>
          </Field>
        )}
        <Field label="Notas (opcional)">
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </Field>
        {!obligation && (
          <Toggle
            tone="violet"
            checked={isHypothetical}
            onChange={setIsHypothetical}
            label={<span className="text-sm">Hipotética (solo visible en Modo Simulación)</span>}
          />
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Abono / Pago
export function PaymentModal({
  open,
  onClose,
  target,
  full,
}: {
  open: boolean;
  onClose: () => void;
  target: { id: string; entityId: string; direction: 'IN' | 'OUT'; description: string; remaining: Cents } | null;
  full?: boolean;
}) {
  const app = useApp();
  const { loading, error, run, setError } = useSubmit();
  const accounts = useApi<AccountDto[]>(open && target ? `/api/accounts?ctx=${target.entityId}` : null);
  // Una tarjeta solo sirve para pagar (no cobrar), y siempre por el saldo completo
  const active = useMemo(
    () => (accounts.data ?? []).filter((a) => !a.archived && (target?.direction === 'OUT' || !isCard(a))),
    [accounts.data, target?.direction],
  );
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(app.today);
  const [installments, setInstallments] = useState(1);
  const selected = active.find((a) => a.id === accountId);
  const payingWithCard = Boolean(selected && isCard(selected));

  useEffect(() => {
    if (!open || !target) return;
    setError(null);
    setAmount(centsInput(target.remaining));
    setDate(app.today);
    setInstallments(1);
  }, [open, target, app.today, setError]);

  useEffect(() => {
    if (payingWithCard && target) setAmount(centsInput(target.remaining));
  }, [payingWithCard, target]);

  useEffect(() => {
    if (active.length && !active.some((a) => a.id === accountId)) setAccountId(active[0].id);
  }, [active, accountId]);

  if (!target) return null;
  const currency = app.entityById.get(target.entityId)?.currency ?? 'HNL';
  const verb = target.direction === 'IN' ? 'Cobro' : 'Pago';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = parseMoneyInput(amount);
    if (a === null || Number(a) <= 0) return setError('Monto inválido');
    const ok = await run(
      () =>
        api(`/api/obligations/${target!.id}/payments`, {
          body: { accountId, amount: a, date, ...(payingWithCard ? { installments } : {}) },
        }),
      payingWithCard ? 'Pagado con tarjeta: se proyecta en su fecha de pago' : `${verb} registrado`,
    );
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={full ? `Marcar como ${target.direction === 'IN' ? 'cobrado' : 'pagado'}` : `Registrar abono parcial`}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {target.description} · Pendiente: <strong>{formatMoney(target.remaining, currency)}</strong>
        </p>
        {accounts.data && active.length === 0 ? (
          <ErrorBox message="Esta entidad no tiene cuentas activas. Crea una en Configuración → Cuentas." />
        ) : (
          <Field label={target.direction === 'IN' ? 'Cuenta que recibe' : 'Cuenta que paga'}>
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
              {active.map((a) => (
                <option key={a.id} value={a.id}>
                  {isCard(a) ? `💳 ${a.name} · deuda ${formatMoney(Math.max(-a.balance, 0), currency)}` : `${a.name} · ${formatMoney(a.balance, currency)}`}
                </option>
              ))}
            </select>
          </Field>
        )}
        {payingWithCard && (
          <Field label="Cuotas">
            <select className="input" value={installments} onChange={(e) => setInstallments(Number(e.target.value))}>
              {INSTALLMENT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'Contado (1)' : `${n} cuotas`}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Monto (${currency})`}>
            <input
              className="input text-right"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              readOnly={full || payingWithCard}
              required
            />
          </Field>
          <Field label={payingWithCard ? 'Fecha de compra' : 'Fecha real'}>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        {payingWithCard && (
          <CardImpactPreview card={selected} purchaseDate={date} amount={target.remaining} installments={installments} currency={currency} />
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading} disabled={!accountId}>
            Registrar {verb.toLowerCase()}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Reprogramar
export function RescheduleModal({
  open,
  onClose,
  target,
}: {
  open: boolean;
  onClose: () => void;
  target: { id: string; description: string; expectedDate: string; dueDate: string; isHypothetical: boolean } | null;
}) {
  const app = useApp();
  const { loading, error, run, setError } = useSubmit();
  const [date, setDate] = useState('');
  useEffect(() => {
    if (open && target) {
      setError(null);
      setDate(target.expectedDate < app.today ? app.today : target.expectedDate);
    }
  }, [open, target, app.today, setError]);
  if (!target) return null;
  const simulated = app.whatIf && !target.isHypothetical;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        simulated
          ? api('/api/scenario/overrides', { method: 'PUT', body: { obligationId: target!.id, expectedDate: date } })
          : api(`/api/obligations/${target!.id}`, { method: 'PATCH', body: { expectedDate: date } }),
      simulated ? 'Fecha simulada' : 'Fecha reprogramada',
    );
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={simulated ? 'Reprogramar (simulación)' : 'Reprogramar fecha esperada'}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {target.description}
          <br />
          Vencimiento contractual: <strong>{target.dueDate}</strong> (no cambia)
        </p>
        <Field label="Nueva fecha esperada">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <div className="flex flex-wrap gap-2">
          {[7, 14, 30].map((d) => (
            <Button key={d} type="button" size="sm" onClick={() => setDate(addDays(date || app.today, d))}>
              +{d} días
            </Button>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Recurrencia
export function RecurrenceFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const defaultEntity = useDefaultEntityId();
  const { loading, error, run, setError } = useSubmit();
  const [entityId, setEntityId] = useState(defaultEntity);
  const [direction, setDirection] = useState<'IN' | 'OUT'>('OUT');
  const [description, setDescription] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState('MONTHLY');
  const [startDate, setStartDate] = useState(app.today);
  const [endDate, setEndDate] = useState('');
  const [priority, setPriority] = useState<'FIXED' | 'FLEXIBLE'>('FIXED');

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEntityId(defaultEntity);
    setDescription('');
    setCounterparty('');
    setAmount('');
    setStartDate(app.today);
    setEndDate('');
  }, [open, defaultEntity, app.today, setError]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = parseMoneyInput(amount);
    if (a === null || Number(a) <= 0) return setError('Monto inválido');
    const ok = await run(
      () =>
        api('/api/recurrences', {
          body: {
            entityId,
            direction,
            description,
            amount: a,
            frequency,
            startDate,
            endDate: endDate || null,
            priority,
            counterpartyName: counterparty || null,
          },
        }),
      'Recurrencia creada',
    );
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Nueva recurrencia">
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Entidad">
            <EntitySelect value={entityId} onChange={setEntityId} />
          </Field>
          <Field label="Tipo">
            <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as 'IN' | 'OUT')}>
              <option value="OUT">Gasto recurrente</option>
              <option value="IN">Ingreso recurrente</option>
            </select>
          </Field>
        </div>
        <Field label="Descripción">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} required placeholder="Planilla quincenal" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={direction === 'IN' ? 'Cliente' : 'Proveedor'}>
            <input className="input" value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
          </Field>
          <Field label={`Monto (${app.entityById.get(entityId)?.currency ?? ''})`}>
            <input className="input text-right" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Frecuencia">
            <select className="input" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
              <option value="WEEKLY">Semanal</option>
              <option value="BIWEEKLY">Quincenal</option>
              <option value="MONTHLY">Mensual</option>
              <option value="YEARLY">Anual</option>
            </select>
          </Field>
          <Field label="Primera fecha">
            <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </Field>
          <Field label="Hasta (opcional)">
            <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
        </div>
        {direction === 'OUT' && (
          <Field label="Prioridad">
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as 'FIXED' | 'FLEXIBLE')}>
              <option value="FIXED">Inamovible</option>
              <option value="FLEXIBLE">Flexible / negociable</option>
            </select>
          </Field>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            Crear
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Transferencia inter-entidad
export function TransferFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const defaultEntity = useDefaultEntityId();
  const { loading, error, run, setError } = useSubmit();
  const [kind, setKind] = useState('TRANSFER');
  const [fromEntityId, setFrom] = useState(defaultEntity);
  const [toEntityId, setTo] = useState('');
  const [amountFrom, setAmountFrom] = useState('');
  const [amountTo, setAmountTo] = useState('');
  const [date, setDate] = useState(app.today);
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFrom(defaultEntity);
    setTo('');
    setAmountFrom('');
    setAmountTo('');
    setDate(app.today);
    setDescription('');
  }, [open, defaultEntity, app.today, setError]);

  const fromCur = app.entityById.get(fromEntityId)?.currency;
  const toCur = app.entityById.get(toEntityId)?.currency;
  const differentCurrency = Boolean(fromCur && toCur && fromCur !== toCur);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = parseMoneyInput(amountFrom);
    const b = differentCurrency ? parseMoneyInput(amountTo) : a;
    if (!a || !b || Number(a) <= 0 || Number(b) <= 0) return setError('Monto inválido');
    const ok = await run(
      () =>
        api('/api/transfers', {
          body: { kind, fromEntityId, toEntityId, amountFrom: a, amountTo: b, expectedDate: date, description: description || null },
        }),
      'Transferencia planificada',
    );
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Transferencia entre entidades">
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label="Tipo">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="TRANSFER">Transferencia de fondos</option>
            <option value="LOAN">Préstamo inter-compañía</option>
            <option value="CONTRIBUTION">Aporte de capital</option>
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Desde">
            <EntitySelect value={fromEntityId} onChange={setFrom} exclude={toEntityId} />
          </Field>
          <Field label="Hacia">
            <EntitySelect value={toEntityId} onChange={setTo} exclude={fromEntityId} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Monto que sale (${fromCur ?? ''})`}>
            <input className="input text-right" inputMode="decimal" value={amountFrom} onChange={(e) => setAmountFrom(e.target.value)} required />
          </Field>
          {differentCurrency ? (
            <Field label={`Monto que entra (${toCur})`}>
              <input className="input text-right" inputMode="decimal" value={amountTo} onChange={(e) => setAmountTo(e.target.value)} required />
            </Field>
          ) : (
            <Field label="Fecha esperada">
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
          )}
        </div>
        {differentCurrency && (
          <Field label="Fecha esperada">
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        )}
        <Field label="Descripción (opcional)">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <p className="text-xs text-slate-500">
          Se reflejará como salida en el origen y entrada en el destino. En la vista consolidada se netea automáticamente.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            Planificar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ExecuteTransferModal({
  open,
  onClose,
  transfer,
}: {
  open: boolean;
  onClose: () => void;
  transfer: { id: string; fromEntityId: string; toEntityId: string; amountFrom: Cents; amountTo: Cents } | null;
}) {
  const app = useApp();
  const { loading, error, run, setError } = useSubmit();
  const fromAccounts = useApi<AccountDto[]>(open && transfer ? `/api/accounts?ctx=${transfer.fromEntityId}` : null);
  const toAccounts = useApi<AccountDto[]>(open && transfer ? `/api/accounts?ctx=${transfer.toEntityId}` : null);
  const [fromAccountId, setFromAcc] = useState('');
  const [toAccountId, setToAcc] = useState('');
  const [date, setDate] = useState(app.today);

  useEffect(() => {
    if (open) {
      setError(null);
      setDate(app.today);
    }
  }, [open, app.today, setError]);
  useEffect(() => {
    const a = liquidAccounts(fromAccounts.data);
    if (a.length && !a.some((x) => x.id === fromAccountId)) setFromAcc(a[0].id);
  }, [fromAccounts.data, fromAccountId]);
  useEffect(() => {
    const a = liquidAccounts(toAccounts.data);
    if (a.length && !a.some((x) => x.id === toAccountId)) setToAcc(a[0].id);
  }, [toAccounts.data, toAccountId]);

  if (!transfer) return null;
  const from = app.entityById.get(transfer.fromEntityId);
  const to = app.entityById.get(transfer.toEntityId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(
      () => api(`/api/transfers/${transfer!.id}`, { body: { action: 'execute', fromAccountId, toAccountId, date } }),
      'Transferencia ejecutada',
    );
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Ejecutar transferencia">
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label={`Sale de ${from?.name ?? ''} (${formatMoney(transfer.amountFrom, from?.currency ?? 'HNL')})`}>
          <select className="input" value={fromAccountId} onChange={(e) => setFromAcc(e.target.value)} required>
            {liquidAccounts(fromAccounts.data).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Entra a ${to?.name ?? ''} (${formatMoney(transfer.amountTo, to?.currency ?? 'HNL')})`}>
          <select className="input" value={toAccountId} onChange={(e) => setToAcc(e.target.value)} required>
            {liquidAccounts(toAccounts.data).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fecha real">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading} disabled={!fromAccountId || !toAccountId}>
            Ejecutar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
