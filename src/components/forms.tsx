'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Trash2, Undo2 } from 'lucide-react';
import type { AccountDto, EntityDto, RuleDto, TransferDto } from '@/lib/server/dto';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { centsToDecimalString, formatMoney, toCents, type Cents } from '@/lib/money';
import { addDays, formatShortDate } from '@/lib/dates';
import { dueDateFor, nextDayOnOrAfter, statementCloseFor } from '@/lib/projection/card-cycle';
import { useApp } from './AppContext';
import { Button, cn, confirmDialog, ErrorBox, Field, Modal, Toggle, useToast } from './ui';
import { CardImpactPreview, INSTALLMENT_OPTIONS, isCard, liquidAccounts } from './cards';
import { CategorySelect } from './CategorySelect';

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
    }, entity ? 'Unidad de negocio actualizada' : 'Unidad de negocio creada');
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={entity ? 'Editar unidad de negocio' : 'Nueva unidad de negocio'}>
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
/** Saldo / deuda inicial por moneda (GET /api/accounts/:id). */
interface OpeningSlot {
  currency: string | null;
  kind: 'STATEMENT' | 'UNBILLED' | null;
  amount: Cents;
  date: string | null;
  locked: boolean;
}

const LIQUID_TYPES: [string, string][] = [
  ['BANK', 'Cuenta bancaria'],
  ['CASH', 'Caja chica'],
  ['WALLET', 'Billetera digital'],
];

/** Alta y edición de cuentas / tarjetas. Con `account` edita (la entidad no cambia). */
export function AccountFormModal({ open, onClose, account }: { open: boolean; onClose: () => void; account?: AccountDto | null }) {
  const app = useApp();
  const toast = useToast();
  const editing = Boolean(account);
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
  const [dual, setDual] = useState(false);
  const [limitForeign, setLimitForeign] = useState('');
  const [openingForeign, setOpeningForeign] = useState('0');
  const [unbilled, setUnbilled] = useState('0');
  const [unbilledForeign, setUnbilledForeign] = useState('0');
  const [budget, setBudget] = useState('');
  const [customRate, setCustomRate] = useState('');
  const [reschedule, setReschedule] = useState(true);
  const isCardType = type === 'CREDIT_CARD';
  const entityCurrency = app.entityById.get(entityId)?.currency ?? '';
  const foreignCurrency = entityCurrency === 'HNL' ? 'USD' : entityCurrency === 'USD' ? 'HNL' : null;
  const entityAccounts = useApi<AccountDto[]>(open && isCardType && entityId ? `/api/accounts?ctx=${entityId}` : null);
  const payable = useMemo(() => liquidAccounts(entityAccounts.data), [entityAccounts.data]);
  const detail = useApi<AccountDto & { opening: OpeningSlot[] }>(open && account ? `/api/accounts/${account.id}` : null);
  const slots = detail.data?.id === account?.id ? detail.data?.opening : undefined;
  const slotOf = (foreign: boolean, kind: 'STATEMENT' | 'UNBILLED' | null) =>
    slots?.find((x) => (x.currency !== null) === foreign && x.kind === kind);
  const baseSlot = slotOf(false, isCardType ? 'STATEMENT' : null);
  const foreignSlot = slotOf(true, 'STATEMENT');
  const unbilledSlot = slotOf(false, 'UNBILLED');
  const unbilledForeignSlot = slotOf(true, 'UNBILLED');
  const firstDate = slots?.find((x) => x.date)?.date ?? null;
  const anyLocked = Boolean(slots?.some((x) => x.locked));
  const cycleChanged =
    editing && isCardType && (Number(statementDay) !== account?.statementDay || Number(paymentDueDay) !== account?.paymentDueDay);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEntityId(account?.entityId ?? defaultEntity);
    setName(account?.name ?? '');
    setType(account?.type ?? 'BANK');
    setInstitution(account?.institution ?? '');
    setOpening('0');
    setDate(app.today);
    setCreditLimit(account?.creditLimit != null ? centsInput(account.creditLimit) : '');
    setStatementDay(String(account?.statementDay ?? 15));
    setPaymentDueDay(String(account?.paymentDueDay ?? 5));
    setPayFrom(account?.defaultPaymentAccountId ?? '');
    setDual(Boolean(account?.foreignCurrency));
    setLimitForeign(account?.creditLimitForeign != null ? centsInput(account.creditLimitForeign) : '');
    setOpeningForeign('0');
    setUnbilled('0');
    setUnbilledForeign('0');
    setBudget(account?.cycleBudget != null ? centsInput(account.cycleBudget) : '');
    setCustomRate(account?.customSellRate ?? '');
    setReschedule(true);
  }, [open, account, defaultEntity, app.today, setError]);

  // En edición, el saldo/deuda inicial llega con el detalle de la cuenta
  useEffect(() => {
    if (!open || !slots) return;
    setOpening(centsInput(baseSlot?.amount ?? 0));
    setOpeningForeign(centsInput(foreignSlot?.amount ?? 0));
    setUnbilled(centsInput(unbilledSlot?.amount ?? 0));
    setUnbilledForeign(centsInput(unbilledForeignSlot?.amount ?? 0));
    setDate(firstDate ?? app.today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slots]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseMoneyInput(opening);
    if (amount === null || (isCardType && Number(amount) < 0)) return setError(isCardType ? 'Deuda inválida' : 'Saldo inválido');
    const limit = creditLimit.trim() ? parseMoneyInput(creditLimit) : null;
    if (creditLimit.trim() && limit === null) return setError('Límite inválido');
    const sd = Number(statementDay);
    const pd = Number(paymentDueDay);
    if (isCardType && (!(sd >= 1 && sd <= 31) || !(pd >= 1 && pd <= 31))) return setError('Los días deben estar entre 1 y 31');
    const isDual = isCardType && dual && Boolean(foreignCurrency);
    const limF = isDual && limitForeign.trim() ? parseMoneyInput(limitForeign) : null;
    if (isDual && limitForeign.trim() && limF === null) return setError(`Límite en ${foreignCurrency} inválido`);
    const openF = isDual ? parseMoneyInput(openingForeign || '0') : '0';
    if (openF === null || Number(openF) < 0) return setError(`Deuda en ${foreignCurrency} inválida`);
    if (isDual && customRate.trim() && !/^\d+(\.\d{1,4})?$/.test(customRate.trim())) return setError('Tasa propia inválida (hasta 4 decimales)');
    const unb = isCardType ? parseMoneyInput(unbilled || '0') : '0';
    if (unb === null || Number(unb) < 0) return setError('Consumos desde el corte inválidos');
    const unbF = isDual ? parseMoneyInput(unbilledForeign || '0') : '0';
    if (unbF === null || Number(unbF) < 0) return setError(`Consumos desde el corte en ${foreignCurrency} inválidos`);
    const bud = isCardType && budget.trim() ? parseMoneyInput(budget) : null;
    if (isCardType && budget.trim() && (bud === null || Number(bud) < 0)) return setError('Presupuesto inválido');
    const cardBody = isCardType
      ? { creditLimit: limit, statementDay: sd, paymentDueDay: pd, defaultPaymentAccountId: payFrom || null, cycleBudget: bud }
      : {};

    if (account) {
      if (!slots) return setError('Cargando el saldo inicial, intenta de nuevo');
      // Solo se envía el saldo inicial si cambió (una deuda con pagos no se puede corregir aquí)
      const body: Record<string, unknown> = { name, institution, ...cardBody };
      if (!isCardType && type !== account.type) body.type = type;
      if (isCardType) {
        body.dualCurrency = isDual;
        if (isDual) Object.assign(body, { creditLimitForeign: limF, customSellRate: customRate.trim() || null });
        if (cycleChanged) body.rescheduleInstallments = reschedule;
      }
      if (toCents(amount) !== (baseSlot?.amount ?? 0)) body.openingBalance = amount;
      if (isDual && toCents(openF) !== (foreignSlot?.amount ?? 0)) body.openingDebtForeign = openF;
      if (isCardType && toCents(unb) !== (unbilledSlot?.amount ?? 0)) body.openingUnbilled = unb;
      if (isDual && toCents(unbF) !== (unbilledForeignSlot?.amount ?? 0)) body.openingUnbilledForeign = unbF;
      if (date !== (firstDate ?? app.today)) body.openingDate = date;
      const ok = await run(async () => {
        const r = await api<{ rescheduled: number }>(`/api/accounts/${account.id}`, { method: 'PATCH', body });
        toast(`${isCardType ? 'Tarjeta' : 'Cuenta'} actualizada${r.rescheduled ? ` · ${r.rescheduled} cuota(s) re-programada(s)` : ''}`);
      });
      if (ok) onClose();
      return;
    }

    const body = {
      entityId,
      name,
      type,
      institution,
      openingBalance: amount,
      openingDate: date,
      ...cardBody,
      ...(isCardType ? { openingUnbilled: unb } : {}),
      ...(isDual
        ? {
            dualCurrency: true,
            creditLimitForeign: limF,
            openingDebtForeign: openF,
            openingUnbilledForeign: unbF,
            customSellRate: customRate.trim() || null,
          }
        : {}),
    };
    const ok = await run(() => api('/api/accounts', { body }), isCardType ? 'Tarjeta creada' : 'Cuenta creada');
    if (ok) onClose();
  }

  const lockedHint = 'Ya tiene pagos aplicados: corrígela con "Conciliar"';
  const openingLabel = editing ? 'Saldo inicial' : 'Saldo actual';
  const cycleHint = (() => {
    const sd = Number(statementDay);
    const pd = Number(paymentDueDay);
    if (!isCardType || !(sd >= 1 && sd <= 31) || !(pd >= 1 && pd <= 31) || !date) return null;
    const close = statementCloseFor(date, sd);
    return { nextPay: nextDayOnOrAfter(date, pd), close, due: dueDateFor(close, pd) };
  })();

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Editar ${isCardType ? 'tarjeta' : 'cuenta'}: ${account?.name ?? ''}` : 'Nueva cuenta / caja'}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        {!editing && (
          <Field label="Unidad de negocio">
            <EntitySelect value={entityId} onChange={setEntityId} />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nombre">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="BAC Corriente" />
          </Field>
          <Field label="Tipo">
            <select className="input" value={type} onChange={(e) => setType(e.target.value)} disabled={editing && isCardType}>
              {LIQUID_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
              {(!editing || isCardType) && <option value="CREDIT_CARD">Tarjeta de crédito</option>}
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
              <Field label={`Límite ${entityCurrency} (opcional)`}>
                <input className="input text-right" inputMode="decimal" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
              </Field>
            </div>
            {cycleChanged && (
              <div className="rounded-lg bg-amber-50 p-2 dark:bg-amber-500/10">
                <Toggle
                  checked={reschedule}
                  onChange={setReschedule}
                  label={<span className="text-sm">Re-programar las cuotas pendientes con el nuevo ciclo</span>}
                />
                <p className="mt-1 text-xs text-slate-500">
                  {reschedule
                    ? 'Las cuotas no pagadas se mueven al corte y fecha de pago que les toca con los nuevos días.'
                    : 'Las cuotas ya registradas conservan sus fechas; solo los consumos nuevos usarán el nuevo ciclo.'}
                </p>
              </div>
            )}
            {foreignCurrency && (
              <Toggle
                checked={dual}
                onChange={setDual}
                label={<span className="text-sm">Bimoneda: también acepta consumos en {foreignCurrency}</span>}
              />
            )}
            {dual && foreignCurrency && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Límite ${foreignCurrency} (opcional)`}>
                  <input className="input text-right" inputMode="decimal" value={limitForeign} onChange={(e) => setLimitForeign(e.target.value)} />
                </Field>
                <Field label="Tasa propia (opcional)" hint={`Global: ${app.fx?.effectiveSellRate ?? '—'}`}>
                  <input className="input text-right" inputMode="decimal" value={customRate} onChange={(e) => setCustomRate(e.target.value)} placeholder={app.fx?.effectiveSellRate} />
                </Field>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
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
              <Field
                label={`Presupuesto por ciclo ${entityCurrency} (opcional)`}
                hint="Tope de gasto entre un corte y otro; te avisa si vas a pasarte"
              >
                <input className="input text-right" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
              </Field>
            </div>
            <p className="text-xs text-slate-500">
              Las compras hasta el día de corte se pagan en la siguiente fecha límite; las posteriores, en la del ciclo subsiguiente.
              La tarjeta no suma a la Caja real hoy.
            </p>
          </div>
        )}
        {isCardType ? (
          <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{editing ? 'Deuda inicial de la tarjeta' : 'Deuda actual de la tarjeta'}</p>
                <p className="text-xs text-slate-500">Sepárala como aparece en la app del banco: lo ya cortado y lo consumido después.</p>
              </div>
              <Field label="A la fecha">
                <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required disabled={anyLocked} />
              </Field>
            </div>
            <div className="grid grid-cols-[3rem_1fr_1fr] items-center gap-2 text-xs text-slate-500">
              <span />
              <span>Saldo al último corte</span>
              <span>Consumos desde el corte</span>
              {[
                { cur: entityCurrency, a: opening, setA: setOpening, sa: baseSlot, b: unbilled, setB: setUnbilled, sb: unbilledSlot },
                ...(dual && foreignCurrency
                  ? [
                      {
                        cur: foreignCurrency,
                        a: openingForeign,
                        setA: setOpeningForeign,
                        sa: foreignSlot,
                        b: unbilledForeign,
                        setB: setUnbilledForeign,
                        sb: unbilledForeignSlot,
                      },
                    ]
                  : []),
              ].map((r) => (
                <Fragment key={r.cur}>
                  <span className="font-medium text-slate-700 dark:text-slate-300">{r.cur}</span>
                  <input
                    className="input text-right"
                    inputMode="decimal"
                    value={r.a}
                    onChange={(e) => r.setA(e.target.value)}
                    disabled={r.sa?.locked || (editing && !slots)}
                    title={r.sa?.locked ? lockedHint : undefined}
                  />
                  <input
                    className="input text-right"
                    inputMode="decimal"
                    value={r.b}
                    onChange={(e) => r.setB(e.target.value)}
                    disabled={r.sb?.locked || (editing && !slots)}
                    title={r.sb?.locked ? lockedHint : undefined}
                  />
                </Fragment>
              ))}
            </div>
            {cycleHint && (
              <p className="text-xs text-slate-500">
                Saldo al corte: se proyecta para el <strong>{formatShortDate(cycleHint.nextPay)}</strong>. Consumos desde el corte: se
                facturan el {formatShortDate(cycleHint.close)} y se proyectan para el <strong>{formatShortDate(cycleHint.due)}</strong>.
              </p>
            )}
            {anyLocked && <p className="text-xs text-amber-600">Los montos bloqueados ya tienen pagos aplicados: corrígelos con &quot;Conciliar&quot;.</p>}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label={`${openingLabel} (${entityCurrency})`}>
              <input
                className="input text-right"
                inputMode="decimal"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                disabled={editing && !slots}
              />
            </Field>
            <Field label="Fecha del saldo">
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
            {editing && (
              <p className="col-span-2 rounded-lg bg-sky-50 p-2 text-xs text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">
                <strong>Cargar historia:</strong> lleva la fecha hacia atrás (p. ej. 01/01 del año) y pon el saldo que la cuenta tenía ese día.
                Luego registra los cobros, pagos y transferencias desde esa fecha; al final usa <strong>Conciliar</strong> para cuadrar con el
                banco. Ningún movimiento puede quedar antes de esta fecha.
              </p>
            )}
          </div>
        )}
        {editing && (
          <p className="text-xs text-slate-500">
            Corregir el {isCardType ? 'saldo o la deuda inicial' : 'saldo inicial'} cambia la Caja real y toda la proyección en la misma
            diferencia. Si el saldo inicial estaba bien y lo que no cuadra es el saldo de hoy, usa <strong>Conciliar</strong>: deja un
            ajuste con fecha y no reescribe la historia.
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            {editing ? 'Guardar cambios' : isCardType ? 'Crear tarjeta' : 'Crear cuenta'}
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
  /** undefined = quien abre el formulario no la conoce (no se toca al guardar). */
  category?: { id: string; name: string } | null;
  notes: string | null;
  /** Gasto reembolsable: fecha en que se hizo el gasto. */
  expenseDate?: string | null;
  transferId: string | null;
  recurrenceId?: string | null;
  payments?: { id: string; amount: Cents; date: string; accountName: string; byCard?: boolean }[];
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
  const [expenseDate, setExpenseDate] = useState('');
  const [categoryId, setCategoryId] = useState('');
  // Historia: crear la partida ya liquidada (cuenta y fecha real del pago/cobro)
  const [settled, setSettled] = useState(false);
  const [settleAccount, setSettleAccount] = useState('');
  const [settleDate, setSettleDate] = useState(app.today);
  const [settleDateTouched, setSettleDateTouched] = useState(false);
  const catalog = useApi<{ counterparties: { id: string; entityId: string; name: string }[] }>(
    open && entityId ? `/api/catalog?ctx=${entityId}` : null,
  );
  const entityAccounts = useApi<AccountDto[]>(open && !obligation && settled && entityId ? `/api/accounts?ctx=${entityId}` : null);
  const settleAccounts = useMemo(() => liquidAccounts(entityAccounts.data), [entityAccounts.data]);
  useEffect(() => {
    if (settleAccount && !settleAccounts.some((a) => a.id === settleAccount)) setSettleAccount('');
  }, [settleAccounts, settleAccount]);

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
    setExpenseDate(obligation?.expenseDate ?? '');
    setCategoryId(obligation?.category?.id ?? '');
    setSettled(false);
    setSettleAccount('');
    setSettleDate(app.today);
    setSettleDateTouched(false);
  }, [open, obligation, defaultEntity, app.today, direction, hypothetical, setError]);

  const isIn = (obligation?.direction ?? direction) === 'IN';
  const toast = useToast();
  const [undoing, setUndoing] = useState<string | null>(null);
  const payments = obligation?.payments ?? [];
  const canDelete = Boolean(obligation) && payments.length === 0 && !obligation?.transferId && !obligation?.recurrenceId;

  async function undoPayment(p: { id: string; amount: Cents; date: string; accountName: string }) {
    if (!obligation) return;
    const cur = app.entityById.get(obligation.entityId)?.currency ?? 'HNL';
    const what = isIn ? 'cobro' : 'pago';
    if (
      !(await confirmDialog({
        title: `Deshacer ${what}`,
        message: `¿Deshacer el ${what} de ${formatMoney(p.amount, cur)} del ${p.date} (${p.accountName})? Se quita también del saldo de la cuenta.`,
        confirmLabel: `Deshacer ${what}`,
        tone: 'danger',
      }))
    )
      return;
    setUndoing(p.id);
    try {
      await api(`/api/obligations/${obligation.id}/payments/${p.id}`, { method: 'DELETE' });
      toast(`${isIn ? 'Cobro' : 'Pago'} deshecho`);
      emitDataChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setUndoing(null);
    }
  }

  async function remove() {
    if (!obligation) return;
    if (
      !(await confirmDialog({
        title: 'Eliminar partida',
        message: `¿Eliminar definitivamente "${obligation.description}"? No se puede deshacer.`,
        confirmLabel: 'Eliminar',
        tone: 'danger',
      }))
    )
      return;
    const ok = await run(() => api(`/api/obligations/${obligation.id}`, { method: 'DELETE' }), 'Partida eliminada');
    if (ok) onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = parseMoneyInput(amount);
    if (a === null || Number(a) <= 0) return setError('Monto inválido');
    const settling = !obligation && settled && !isHypothetical;
    if (settling && !settleAccount) return setError(`Elige la cuenta ${isIn ? 'que recibió el cobro' : 'que hizo el pago'}`);
    const base = {
      description,
      amount: a,
      dueDate,
      expectedDate,
      priority,
      counterpartyName: counterparty.trim() || null,
      ...(!obligation || obligation.category !== undefined ? { categoryId: categoryId || null } : {}),
      notes: notes || null,
      ...(obligation?.expenseDate ? { expenseDate: expenseDate || null } : {}),
    };
    const ok = await run(
      () =>
        obligation
          ? api(`/api/obligations/${obligation.id}`, { method: 'PATCH', body: base })
          : api('/api/obligations', {
              body: {
                ...base,
                entityId,
                direction,
                isHypothetical,
                ...(settling ? { settlement: { accountId: settleAccount, date: settleDate } } : {}),
              },
            }),
      obligation ? 'Partida actualizada' : settling ? `Partida registrada como ${isIn ? 'cobrada' : 'pagada'}` : 'Partida registrada',
    );
    if (ok) onClose();
  }

  const title = `${obligation ? 'Editar' : 'Nueva'} ${isIn ? 'cuenta por cobrar' : 'cuenta por pagar'}${isHypothetical ? ' (hipotética)' : ''}`;

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        {!obligation && (
          <Field label="Unidad de negocio">
            <EntitySelect
              value={entityId}
              onChange={(id) => {
                setEntityId(id);
                setCategoryId(''); // las categorías son de cada unidad
              }}
            />
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
        <CategorySelect
          entityId={entityId}
          direction={(obligation?.direction ?? direction) as 'IN' | 'OUT'}
          value={categoryId}
          onChange={setCategoryId}
          label={isIn ? 'Categoría del ingreso' : 'Categoría del gasto'}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vencimiento contractual">
            <input
              className="input"
              type="date"
              value={dueDate}
              onChange={(e) => {
                if (expectedDate === dueDate) setExpectedDate(e.target.value);
                if (!settleDateTouched) setSettleDate(e.target.value);
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
        {obligation?.expenseDate && (
          <Field label="Fecha del gasto" hint="Cuándo se hizo el gasto; las fechas de arriba son las del reembolso">
            <input className="input" type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
          </Field>
        )}
        <Field label="Notas (opcional)">
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </Field>
        {!obligation && !isHypothetical && (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <Toggle
              checked={settled}
              onChange={(v) => {
                setSettled(v);
                if (v && !settleDateTouched) setSettleDate(dueDate);
              }}
              label={<span className="text-sm">Ya fue {isIn ? 'cobrada' : 'pagada'} (registrar historia)</span>}
            />
            {settled && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={isIn ? 'Cuenta que recibió' : 'Cuenta que pagó'}>
                    <select className="input" value={settleAccount} onChange={(e) => setSettleAccount(e.target.value)} required>
                      <option value="">Selecciona…</option>
                      {settleAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={`Fecha real del ${isIn ? 'cobro' : 'pago'}`}>
                    <input
                      className="input"
                      type="date"
                      value={settleDate}
                      onChange={(e) => {
                        setSettleDate(e.target.value);
                        setSettleDateTouched(true);
                      }}
                      required
                    />
                  </Field>
                </div>
                <p className="text-xs text-slate-500">
                  Se registra el {isIn ? 'cobro' : 'pago'} completo y mueve el saldo de la cuenta en esa fecha. La fecha no puede ser anterior a la apertura
                  de la cuenta: para cargar historia, primero lleva la apertura hacia atrás con el saldo que tenía entonces.
                </p>
              </>
            )}
          </div>
        )}
        {!obligation && !settled && (
          <Toggle
            tone="violet"
            checked={isHypothetical}
            onChange={setIsHypothetical}
            label={<span className="text-sm">Hipotética (solo visible en Modo Simulación)</span>}
          />
        )}
        {payments.length > 0 && (
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{isIn ? 'Cobros' : 'Pagos'} registrados</p>
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {payments.map((p) => (
                <li key={p.id} className="flex items-center gap-2 py-1.5">
                  <span className="tabular-nums">{p.date}</span>
                  <span className="truncate text-slate-500">{p.byCard ? `💳 ${p.accountName}` : p.accountName}</span>
                  <span className="ml-auto tabular-nums font-medium">{formatMoney(p.amount, app.entityById.get(obligation!.entityId)?.currency ?? 'HNL')}</span>
                  {!p.byCard && (
                    <Button type="button" size="sm" variant="ghost" title={`Deshacer este ${isIn ? 'cobro' : 'pago'}`} loading={undoing === p.id} onClick={() => undoPayment(p)}>
                      <Undo2 className="h-4 w-4 text-rose-500" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-slate-500">Deshacer quita el movimiento de la cuenta y la partida vuelve a quedar pendiente.</p>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          {canDelete && (
            <Button type="button" variant="ghost" className="mr-auto text-rose-600" onClick={remove}>
              <Trash2 className="h-4 w-4" /> Eliminar
            </Button>
          )}
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
  defaultDate,
}: {
  open: boolean;
  onClose: () => void;
  target: { id: string; entityId: string; direction: 'IN' | 'OUT'; description: string; remaining: Cents } | null;
  full?: boolean;
  /** Fecha propuesta (p. ej. la de una ocurrencia pasada); por defecto, hoy. */
  defaultDate?: string;
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
    setDate(defaultDate && defaultDate < app.today ? defaultDate : app.today);
    setInstallments(1);
  }, [open, target, app.today, defaultDate, setError]);

  useEffect(() => {
    if (payingWithCard && target) setAmount(centsInput(target.remaining));
  }, [payingWithCard, target]);

  // En un cobro hay que elegir a qué cuenta cae el dinero (salvo que solo haya una);
  // en un pago se propone la primera cuenta.
  const mustChoose = target?.direction === 'IN' && active.length > 1;
  useEffect(() => {
    if (open) setAccountId('');
  }, [open, target?.id]);
  useEffect(() => {
    if (accountId && active.some((a) => a.id === accountId)) return;
    if (accountId) setAccountId('');
    else if (active.length && !mustChoose) setAccountId(active[0].id);
  }, [active, accountId, mustChoose]);

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
          <ErrorBox message="Esta unidad de negocio no tiene cuentas activas. Crea una en Ajustes → Cuentas y tarjetas." />
        ) : (
          <Field label={target.direction === 'IN' ? '¿A qué cuenta cae el dinero?' : 'Cuenta que paga'}>
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)} required autoFocus={mustChoose}>
              {mustChoose && <option value="">Selecciona la cuenta que recibe…</option>}
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
/** Alta y edición de recurrencias. Con `rule` edita (entidad y tipo no cambian). */
/** Confirmación para eliminar una recurrencia completa (las fechas ya pagadas se conservan). */
export async function confirmDeleteRecurrence(description: string): Promise<boolean> {
  return confirmDialog({
    title: 'Eliminar recurrencia',
    message:
      `¿Eliminar la recurrencia "${description}"?\n\nSe borran todas sus fechas futuras y las pendientes. ` +
      'Las que ya tienen cobros/pagos se conservan como partidas normales. No se puede deshacer.',
    confirmLabel: 'Eliminar',
    tone: 'danger',
  });
}

export function recurrenceDeletedMsg(r: { deleted: number; kept: number }): string {
  return `Recurrencia eliminada${r.kept ? ` · ${r.kept} fecha(s) con pagos se conservaron` : ''}`;
}

export function RecurrenceFormModal({
  open,
  onClose,
  rule,
  defaultDirection = 'OUT',
}: {
  open: boolean;
  onClose: () => void;
  rule?: RuleDto | null;
  defaultDirection?: 'IN' | 'OUT';
}) {
  const app = useApp();
  const editing = Boolean(rule);
  const defaultEntity = useDefaultEntityId();
  const { loading, error, run, setError } = useSubmit();
  const toast = useToast();
  const [entityId, setEntityId] = useState(defaultEntity);
  const [direction, setDirection] = useState<'IN' | 'OUT'>('OUT');
  const [description, setDescription] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState('MONTHLY');
  const [startDate, setStartDate] = useState(app.today);
  const [endDate, setEndDate] = useState('');
  const [priority, setPriority] = useState<'FIXED' | 'FLEXIBLE'>('FIXED');
  const [isHypothetical, setIsHypothetical] = useState(false);
  const [categoryId, setCategoryId] = useState('');

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (rule) {
      setCategoryId(rule.category?.id ?? '');
      setEntityId(rule.entityId);
      setDirection(rule.direction);
      setDescription(rule.description);
      setCounterparty(rule.counterparty?.name ?? '');
      setAmount(centsInput(rule.amount));
      setFrequency(rule.frequency);
      setStartDate(rule.startDate);
      setEndDate(rule.endDate ?? '');
      setPriority(rule.priority);
      setIsHypothetical(rule.isHypothetical);
      return;
    }
    setCategoryId('');
    setEntityId(defaultEntity);
    setDirection(defaultDirection);
    setDescription('');
    setCounterparty('');
    setAmount('');
    setFrequency('MONTHLY');
    setStartDate(app.today);
    setEndDate('');
    setPriority('FIXED');
    // En Modo Simulación, lo nuevo nace hipotético
    setIsHypothetical(app.whatIf);
  }, [open, rule, defaultDirection, defaultEntity, app.today, app.whatIf, setError]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = parseMoneyInput(amount);
    if (a === null || Number(a) <= 0) return setError('Monto inválido');
    if (endDate && endDate < startDate) return setError('La fecha final es anterior a la primera fecha');
    const common = {
      description,
      amount: a,
      frequency,
      startDate,
      endDate: endDate || null,
      priority,
      counterpartyName: counterparty.trim() || null,
      categoryId: categoryId || null,
      isHypothetical,
    };
    const ok = await run(
      () =>
        rule
          ? api(`/api/recurrences/${rule.id}`, { method: 'PATCH', body: common })
          : api('/api/recurrences', { body: { entityId, direction, ...common } }),
      rule
        ? 'Recurrencia actualizada'
        : isHypothetical
          ? `Recurrencia hipotética creada${app.whatIf ? '' : ' (actívala en Modo Simulación para verla)'}`
          : 'Recurrencia creada',
    );
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Editar recurrencia: ${rule?.description ?? ''}` : 'Nueva recurrencia'}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unidad de negocio">
            {editing ? (
              <input className="input" value={app.entityById.get(entityId)?.name ?? ''} disabled />
            ) : (
              <EntitySelect
                value={entityId}
                onChange={(id) => {
                  setEntityId(id);
                  setCategoryId('');
                }}
              />
            )}
          </Field>
          <Field label="Tipo">
            <select
              className="input"
              value={direction}
              onChange={(e) => {
                setDirection(e.target.value as 'IN' | 'OUT');
                setCategoryId('');
              }}
              disabled={editing}
            >
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
        <CategorySelect entityId={entityId} direction={direction} value={categoryId} onChange={setCategoryId} />
        <div className="grid grid-cols-3 gap-3">
          <Field label="Frecuencia">
            <select className="input" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
              <option value="DAILY">Diaria</option>
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
        <Toggle
          tone="violet"
          checked={isHypothetical}
          onChange={setIsHypothetical}
          label={<span className="text-sm">Hipotética (solo se proyecta en Modo Simulación)</span>}
        />
        {editing && rule && rule.isHypothetical !== isHypothetical && (
          <p className="text-xs text-violet-700 dark:text-violet-300">
            {isHypothetical
              ? 'Pasará a ser hipotética: sus fechas pendientes dejan de proyectarse fuera de la simulación.'
              : 'Pasará a ser real: sus fechas se proyectan siempre, también fuera de la simulación.'}
          </p>
        )}
        {editing && (
          <p className="text-xs text-slate-500">
            Los cambios aplican a las ocurrencias futuras proyectadas. Las que ya se pagaron, abonaron o editaron
            individualmente conservan sus datos.
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          {rule && (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto text-rose-600"
              onClick={async () => {
                if (!(await confirmDeleteRecurrence(rule.description))) return;
                const ok = await run(async () => {
                  const r = await api<{ deleted: number; kept: number }>(`/api/recurrences/${rule.id}`, { method: 'DELETE' });
                  toast(recurrenceDeletedMsg(r));
                });
                if (ok) onClose();
              }}
            >
              <Trash2 className="h-4 w-4" /> Eliminar
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            {editing ? 'Guardar cambios' : 'Crear'}
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
  const [repayDate, setRepayDate] = useState(addDays(app.today, 30));
  const [repayTouched, setRepayTouched] = useState(false);
  const [interest, setInterest] = useState('0');
  const isLoan = kind === 'LOAN';

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFrom(defaultEntity);
    setTo('');
    setAmountFrom('');
    setAmountTo('');
    setDate(app.today);
    setDescription('');
    setRepayDate(addDays(app.today, 30));
    setRepayTouched(false);
    setInterest('0');
  }, [open, defaultEntity, app.today, setError]);

  // La devolución sigue a la fecha de entrega mientras no se elija a mano
  function onDate(v: string) {
    setDate(v);
    if (!repayTouched && v) setRepayDate(addDays(v, 30));
  }

  const fromCur = app.entityById.get(fromEntityId)?.currency;
  const toCur = app.entityById.get(toEntityId)?.currency;
  const differentCurrency = Boolean(fromCur && toCur && fromCur !== toCur);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = parseMoneyInput(amountFrom);
    const b = differentCurrency ? parseMoneyInput(amountTo) : a;
    if (!a || !b || Number(a) <= 0 || Number(b) <= 0) return setError('Monto inválido');
    const i = isLoan ? parseMoneyInput(interest || '0') : '0';
    if (i === null || Number(i) < 0) return setError('Interés inválido');
    if (isLoan && repayDate < date) return setError('La devolución no puede ser antes de la entrega');
    const ok = await run(
      () =>
        api('/api/transfers', {
          body: {
            kind,
            fromEntityId,
            toEntityId,
            amountFrom: a,
            amountTo: b,
            expectedDate: date,
            description: description || null,
            ...(isLoan ? { repaymentDate: repayDate, interest: i } : {}),
          },
        }),
      isLoan ? 'Préstamo y devolución programados' : 'Transferencia planificada',
    );
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Transferencia entre unidades de negocio">
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
              <input className="input" type="date" value={date} onChange={(e) => onDate(e.target.value)} required />
            </Field>
          )}
        </div>
        {differentCurrency && (
          <Field label="Fecha esperada">
            <input className="input" type="date" value={date} onChange={(e) => onDate(e.target.value)} required />
          </Field>
        )}
        <Field label="Descripción (opcional)">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {isLoan && (
          <LoanTermFields
            base={date}
            dueDate={repayDate}
            setDueDate={(v) => {
              setRepayDate(v);
              setRepayTouched(true);
            }}
            interest={interest}
            setInterest={setInterest}
            currency={fromCur ?? ''}
            principal={(() => {
              const c = parseMoneyInput(amountFrom);
              return c === null ? null : toCents(c);
            })()}
          />
        )}
        <p className="text-xs text-slate-500">
          {isLoan
            ? 'La entrega sale del origen y entra al destino; la devolución queda como CxC en quien presta y CxP en quien recibe, y se salda con abonos. En la vista consolidada se netea.'
            : 'Se reflejará como salida en el origen y entrada en el destino. En la vista consolidada se netea automáticamente.'}
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

/**
 * Ejecuta una transferencia entre unidades (todo lo pendiente) o, en devoluciones de préstamo,
 * registra un ABONO. Lee el saldo pendiente de cada lado desde /api/transfers/[id].
 */
export function ExecuteTransferModal({
  open,
  onClose,
  transfer,
  partial = false,
}: {
  open: boolean;
  onClose: () => void;
  transfer: { id: string } | null;
  /** Abrir directamente en modo abono (devoluciones de préstamo y reembolsos). */
  partial?: boolean;
}) {
  const app = useApp();
  const { loading, error, run, setError } = useSubmit();
  const detail = useApi<TransferDto>(open && transfer ? `/api/transfers/${transfer.id}` : null);
  const t = detail.data?.id === transfer?.id ? detail.data : undefined;
  const fromAccounts = useApi<AccountDto[]>(open && t ? `/api/accounts?ctx=${t.fromEntityId}` : null);
  const toAccounts = useApi<AccountDto[]>(open && t ? `/api/accounts?ctx=${t.toEntityId}` : null);
  const [fromAccountId, setFromAcc] = useState('');
  const [toAccountId, setToAcc] = useState('');
  const [date, setDate] = useState(app.today);
  const [amount, setAmount] = useState('');
  const [amountTo, setAmountTo] = useState('');
  const [amountToTouched, setAmountToTouched] = useState(false);
  /** Registro histórico: baja el saldo sin mover caja (el dinero ya está en los saldos). */
  const [historical, setHistorical] = useState(false);

  const isReimbursement = Boolean(t?.isReimbursement);
  // Devoluciones de préstamo y reembolsos se pagan por abonos
  const isRepayment = Boolean(t?.repaymentOfId) || isReimbursement;
  const abono = isRepayment && partial;
  const noun = isReimbursement ? 'reembolso' : 'devolución de préstamo';
  const from = t ? app.entityById.get(t.fromEntityId) : undefined;
  const to = t ? app.entityById.get(t.toEntityId) : undefined;
  const fromCur = from?.currency ?? 'HNL';
  const toCur = to?.currency ?? 'HNL';
  const differentCurrency = fromCur !== toCur;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDate(app.today);
    setAmountToTouched(false);
    setHistorical(false);
  }, [open, app.today, setError]);
  useEffect(() => {
    if (open && t) {
      setAmount(centsInput(t.remainingFrom));
      setAmountTo(centsInput(t.remainingTo));
    }
  }, [open, t]);
  useEffect(() => {
    const a = liquidAccounts(fromAccounts.data);
    if (a.length && !a.some((x) => x.id === fromAccountId)) setFromAcc(a[0].id);
  }, [fromAccounts.data, fromAccountId]);
  useEffect(() => {
    const a = liquidAccounts(toAccounts.data);
    if (a.length && !a.some((x) => x.id === toAccountId)) setToAcc(a[0].id);
  }, [toAccounts.data, toAccountId]);

  // Con monedas distintas, lo recibido se propone en proporción al saldo pendiente
  function onAmount(v: string) {
    setAmount(v);
    if (!t || !differentCurrency || amountToTouched) return;
    const c = parseMoneyInput(v);
    if (c !== null && t.remainingFrom > 0) setAmountTo(centsInput(Math.round((toCents(c) * t.remainingTo) / t.remainingFrom)));
  }

  if (!transfer) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!t) return;
    if (historical && date > app.today) return setError('Un registro histórico no puede tener fecha futura');
    const accounts = historical ? { historical: true } : { fromAccountId, toAccountId };
    let body: Record<string, unknown> = { action: 'execute', ...accounts, date };
    if (abono) {
      const a = parseMoneyInput(amount);
      if (a === null || toCents(a) <= 0) return setError('Monto inválido');
      if (toCents(a) > t.remainingFrom) return setError('El abono supera el saldo pendiente');
      const b = differentCurrency ? parseMoneyInput(amountTo) : null;
      if (differentCurrency && (b === null || toCents(b) <= 0)) return setError('Monto recibido inválido');
      body = { action: 'pay', ...accounts, date, amountFrom: a, ...(b ? { amountTo: b } : {}) };
    }
    const ok = await run(
      () => api(`/api/transfers/${t.id}`, { body }),
      historical
        ? abono
          ? 'Abono histórico registrado (sin mover caja)'
          : 'Registrado como histórico (sin mover caja)'
        : abono
          ? 'Abono registrado'
          : isRepayment ? (isReimbursement ? 'Reembolso saldado' : 'Préstamo saldado') : 'Transferencia ejecutada',
    );
    if (ok) onClose();
  }

  const title = abono ? `Abono a ${noun}` : isRepayment ? `Saldar ${noun}` : 'Ejecutar transferencia';
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        {detail.error && <ErrorBox message={detail.error} />}
        {!t ? (
          <p className="text-sm text-slate-500">Cargando…</p>
        ) : (
          <>
            {isRepayment && (
              <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/40">
                <p>
                  {from?.name} le {isReimbursement ? 'reembolsa' : 'devuelve'} a {to?.name}
                  {isReimbursement && t.description && <span className="text-slate-500"> · {t.description.replace(/^Reembolso: /, '')}</span>}
                </p>
                <p className="mt-1 text-slate-500">
                  Total {formatMoney(t.amountTo, toCur)}
                  {t.interest > 0 && ` (incluye interés ${formatMoney(t.interest, toCur)})`} · Abonado {formatMoney(t.paidTo, toCur)} ·{' '}
                  <strong className="text-slate-900 dark:text-white">Pendiente {formatMoney(t.remainingTo, toCur)}</strong>
                </p>
              </div>
            )}
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <Toggle checked={historical} onChange={setHistorical} tone="violet" label="Registro histórico (no mueve caja)" />
              {historical && (
                <p className="mt-2 text-xs text-slate-500">
                  Para pagos viejos que ya están reflejados en los saldos: baja lo pendiente en {from?.name} y {to?.name} sin tocar
                  ninguna cuenta.
                </p>
              )}
            </div>
            {!historical && (
              <>
                <Field label={`Sale de ${from?.name ?? ''}${abono ? '' : ` (${formatMoney(t.remainingFrom, fromCur)})`}`}>
                  <select className="input" value={fromAccountId} onChange={(e) => setFromAcc(e.target.value)} required>
                    {liquidAccounts(fromAccounts.data).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {formatMoney(a.balance, fromCur)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Entra a ${to?.name ?? ''}${abono ? '' : ` (${formatMoney(t.remainingTo, toCur)})`}`}>
                  <select className="input" value={toAccountId} onChange={(e) => setToAcc(e.target.value)} required>
                    {liquidAccounts(toAccounts.data).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              {abono && (
                <Field label={`Monto del abono (${fromCur})`}>
                  <input className="input text-right" inputMode="decimal" value={amount} onChange={(e) => onAmount(e.target.value)} required />
                </Field>
              )}
              {abono && differentCurrency && (
                <Field label={`Recibe (${toCur})`}>
                  <input
                    className="input text-right"
                    inputMode="decimal"
                    value={amountTo}
                    onChange={(e) => {
                      setAmountTo(e.target.value);
                      setAmountToTouched(true);
                    }}
                    required
                  />
                </Field>
              )}
              <Field label={historical ? 'Fecha en que se pagó' : 'Fecha real'}>
                <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} max={historical ? app.today : undefined} required />
              </Field>
            </div>
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading} disabled={!t || (!historical && (!fromAccountId || !toAccountId))}>
            {historical ? 'Registrar histórico' : abono ? 'Registrar abono' : isRepayment ? 'Saldar' : 'Ejecutar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Atajos de plazo para la devolución de un préstamo (días a partir de la entrega). */
const LOAN_TERMS = [30, 60, 90, 180];

function LoanTermFields({
  base,
  dueDate,
  setDueDate,
  interest,
  setInterest,
  currency,
  principal,
}: {
  base: string;
  dueDate: string;
  setDueDate: (v: string) => void;
  interest: string;
  setInterest: (v: string) => void;
  currency: string;
  principal: Cents | null;
}) {
  const i = parseMoneyInput(interest || '0');
  const total = principal !== null && i !== null ? principal + toCents(i) : null;
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Fecha de devolución" hint="Queda como CxC en quien presta y CxP en quien recibe">
          <input className="input" type="date" value={dueDate} min={base} onChange={(e) => setDueDate(e.target.value)} required />
        </Field>
        <Field label={`Interés total (${currency})`} hint="Opcional; 0 = sin interés">
          <input className="input text-right" inputMode="decimal" value={interest} onChange={(e) => setInterest(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-slate-500">Plazo:</span>
        {LOAN_TERMS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDueDate(addDays(base, d))}
            className={cn(
              'rounded-md border px-2 py-0.5',
              dueDate === addDays(base, d)
                ? 'border-slate-800 bg-slate-800 text-white dark:border-slate-200 dark:bg-slate-200 dark:text-slate-900'
                : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
            )}
          >
            {d} días
          </button>
        ))}
      </div>
      {total !== null && (
        <p className="text-xs text-slate-500">
          A devolver: <strong className="text-slate-900 dark:text-white">{formatMoney(total, currency)}</strong> en uno o varios abonos hasta saldarlo.
        </p>
      )}
    </div>
  );
}

/** Programa la devolución de un préstamo ya registrado (los anteriores a esta función). */
export function LoanRepaymentModal({ open, onClose, loan }: { open: boolean; onClose: () => void; loan: TransferDto | null }) {
  const app = useApp();
  const { loading, error, run, setError } = useSubmit();
  const base = loan ? (loan.executedDate ?? loan.expectedDate) : app.today;
  const [dueDate, setDueDate] = useState(addDays(app.today, 30));
  const [interest, setInterest] = useState('0');

  useEffect(() => {
    if (!open || !loan) return;
    setError(null);
    setDueDate(addDays(loan.executedDate ?? loan.expectedDate, 30));
    setInterest('0');
  }, [open, loan, setError]);

  if (!loan) return null;
  const lender = app.entityById.get(loan.fromEntityId);
  const borrower = app.entityById.get(loan.toEntityId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const i = parseMoneyInput(interest || '0');
    if (i === null || toCents(i) < 0) return setError('Interés inválido');
    const ok = await run(
      () => api(`/api/transfers/${loan!.id}`, { body: { action: 'repayment', dueDate, interest: i } }),
      'Devolución programada',
    );
    if (ok) onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Programar devolución del préstamo">
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {lender?.name} prestó {formatMoney(loan.amountFrom, lender?.currency ?? 'HNL')} a {borrower?.name}.
        </p>
        <LoanTermFields
          base={base}
          dueDate={dueDate}
          setDueDate={setDueDate}
          interest={interest}
          setInterest={setInterest}
          currency={lender?.currency ?? 'HNL'}
          principal={loan.amountFrom}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading}>
            Programar devolución
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Editar reembolso / devolución entre unidades
/**
 * Edita los detalles de un reembolso o devolución de préstamo entre unidades. Cambia las dos partidas
 * (CxP en quien debe y CxC en quien cobra) a la vez y no mueve caja. Sin abonos, también se puede eliminar.
 */
export function InterUnitEditModal({ open, onClose, transferId }: { open: boolean; onClose: () => void; transferId: string | null }) {
  const app = useApp();
  const toast = useToast();
  const { loading, error, run, setError } = useSubmit();
  const { data: t } = useApi<TransferDto>(open && transferId ? `/api/transfers/${transferId}` : null);
  const isReimb = Boolean(t?.isReimbursement);
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [amountFrom, setAmountFrom] = useState('');
  const [amountTo, setAmountTo] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [notes, setNotes] = useState('');
  const [expenseDate, setExpenseDate] = useState('');

  useEffect(() => {
    if (!open || !t || t.id !== transferId) return;
    setError(null);
    setDescription((t.description ?? '').replace(/^Reembolso:\s*/, ''));
    setDate(t.expectedDate);
    setAmountFrom(centsInput(t.amountFrom));
    setAmountTo(centsInput(t.amountTo));
    setCategoryId(t.categoryId ?? '');
    setNotes(t.notes ?? '');
    setExpenseDate(t.expenseDate ?? '');
  }, [open, t, transferId, setError]);

  if (!open || !t || t.id !== transferId) return null;
  const from = app.entityById.get(t.fromEntityId);
  const to = app.entityById.get(t.toEntityId);
  const curFrom = from?.currency ?? 'HNL';
  const curTo = to?.currency ?? 'HNL';
  const sameCurrency = curFrom === curTo;
  const hasPayments = t.paidFrom > 0 || t.paidTo > 0;
  const settled = t.status === 'EXECUTED';
  const amountLocked = !isReimb || t.chargeLinked || settled;
  const canDelete = !t.chargeLinked;
  const label = isReimb ? 'reembolso' : 'devolución';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { description, date, notes: notes.trim() || null };
    if (isReimb) {
      body.categoryId = categoryId || null;
      body.expenseDate = expenseDate || null;
    }
    if (!amountLocked) {
      const af = parseMoneyInput(amountFrom);
      if (!af || Number(af) <= 0) return setError('Monto inválido');
      body.amountFrom = af;
      if (!sameCurrency) {
        const at = parseMoneyInput(amountTo);
        if (!at || Number(at) <= 0) return setError(`Indica el monto en ${curTo}`);
        body.amountTo = at;
      }
    }
    const ok = await run(() => api(`/api/transfers/${t!.id}`, { method: 'PATCH', body }), 'Cambios guardados en ambas unidades');
    if (ok) onClose();
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: isReimb ? 'Eliminar reembolso' : 'Eliminar devolución',
        message: `¿Eliminar definitivamente este ${isReimb ? 'reembolso' : 'registro de devolución'}? Se borra la CxP de ${from?.name} y la CxC de ${to?.name}${
          hasPayments ? ', junto con sus abonos y los movimientos de caja que generaron (los saldos de las cuentas se revierten)' : ''
        }. No se puede deshacer.`,
        confirmLabel: 'Eliminar',
        tone: 'danger',
      }))
    )
      return;
    try {
      await api(`/api/transfers/${t!.id}`, { method: 'DELETE' });
      toast(isReimb ? 'Reembolso eliminado' : 'Devolución eliminada');
      emitDataChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  async function undoPayments() {
    if (
      !(await confirmDialog({
        title: 'Deshacer abonos',
        message: `Se borran los abonos de este ${label} (${formatMoney(t!.paidFrom, curFrom)}) y los movimientos de caja que generaron en ${from?.name} y ${to?.name}; los saldos de esas cuentas se revierten. Queda pendiente otra vez para que lo saldes con la cuenta correcta.`,
        confirmLabel: 'Deshacer abonos',
        tone: 'danger',
      }))
    )
      return;
    try {
      await api(`/api/transfers/${t!.id}`, { body: { action: 'undo' } });
      toast('Abonos deshechos: ya puedes saldarlo con la cuenta correcta');
      emitDataChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isReimb ? 'Editar reembolso entre unidades' : 'Editar devolución de préstamo'}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {from?.name} le debe a {to?.name}. Los cambios se aplican en las dos unidades y no mueven saldos.
        </p>
        <Field label="Descripción">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={180} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Monto (${curFrom})`} hint={hasPayments ? `Ya abonado: ${formatMoney(t.paidFrom, curFrom)}` : undefined}>
            <input
              className="input text-right"
              inputMode="decimal"
              value={amountFrom}
              onChange={(e) => setAmountFrom(e.target.value)}
              disabled={amountLocked}
              required
            />
          </Field>
          {!sameCurrency && (
            <Field label={`Recibe ${to?.name} (${curTo})`}>
              <input className="input text-right" inputMode="decimal" value={amountTo} onChange={(e) => setAmountTo(e.target.value)} disabled={amountLocked} />
            </Field>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {isReimb && (
            <Field label="Fecha del gasto">
              <input className="input" type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} max={date || undefined} />
            </Field>
          )}
          <Field label={isReimb ? 'Fecha de reembolso' : 'Fecha de devolución'}>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        {hasPayments && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800/50">
            <span className="text-slate-600 dark:text-slate-400">
              {settled ? 'Saldado' : 'Abonado'}: <b>{formatMoney(t.paidFrom, curFrom)}</b>. ¿Cuenta equivocada? Deshaz los abonos y vuelve a saldarlo.
            </span>
            <Button type="button" size="sm" onClick={undoPayments}>
              <Undo2 className="h-4 w-4" /> Deshacer abonos
            </Button>
          </div>
        )}
        {amountLocked && (
          <p className="text-xs text-slate-500">
            {settled && !t.chargeLinked && isReimb
              ? 'Ya está saldado: para cambiar el monto, deshaz primero sus abonos.'
              : t.chargeLinked
              ? 'El monto lo define el consumo de tarjeta al que está ligado.'
              : 'El monto de una devolución lo define el préstamo y su interés.'}
          </p>
        )}
        {isReimb && (
          <CategorySelect entityId={t.fromEntityId} direction="OUT" value={categoryId} onChange={setCategoryId} label={`Categoría del gasto en ${from?.name}`} />
        )}
        <Field label="Notas">
          <textarea className="input min-h-[60px]" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </Field>
        <div className="flex items-center justify-between gap-2 pt-2">
          <div>
            {canDelete && (
              <Button type="button" variant="ghost" onClick={remove} title={hasPayments ? 'Eliminar y revertir su caja' : 'Eliminar'}>
                <Trash2 className="h-4 w-4 text-rose-500" /> Eliminar
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" loading={loading}>
              Guardar
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Transferencia entre cuentas de una entidad
export function InternalTransferModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const defaultEntity = useDefaultEntityId();
  const { loading, error, run, setError } = useSubmit();
  const [entityId, setEntityId] = useState(defaultEntity);
  const [fromAccountId, setFromAcc] = useState('');
  const [toAccountId, setToAcc] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(app.today);
  const [description, setDescription] = useState('');
  const accounts = useApi<AccountDto[]>(open && entityId ? `/api/accounts?ctx=${entityId}` : null);
  const liquid = useMemo(() => liquidAccounts(accounts.data), [accounts.data]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEntityId(defaultEntity);
    setAmount('');
    setDate(app.today);
    setDescription('');
  }, [open, defaultEntity, app.today, setError]);

  useEffect(() => {
    setFromAcc('');
    setToAcc('');
  }, [entityId, open]);

  const currency = app.entityById.get(entityId)?.currency ?? 'HNL';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const a = parseMoneyInput(amount);
    if (!a || Number(a) <= 0) return setError('Monto inválido');
    if (fromAccountId === toAccountId) return setError('Elige dos cuentas distintas');
    const ok = await run(
      () =>
        api('/api/transfers/internal', {
          body: { entityId, fromAccountId, toAccountId, amount: a, date, description: description || null },
        }),
      'Transferencia registrada',
    );
    if (ok) onClose();
  }

  const accountOption = (a: AccountDto) => (
    <option key={a.id} value={a.id}>
      {a.name} · {formatMoney(a.balance, currency)}
    </option>
  );

  return (
    <Modal open={open} onClose={onClose} title="Transferencia entre cuentas">
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        <Field label="Unidad de negocio">
          <EntitySelect value={entityId} onChange={setEntityId} />
        </Field>
        {accounts.data && liquid.length < 2 ? (
          <ErrorBox message="Esta unidad de negocio necesita al menos dos cuentas activas (banco, caja o billetera)." />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sale de">
              <select className="input" value={fromAccountId} onChange={(e) => setFromAcc(e.target.value)} required>
                <option value="">Selecciona…</option>
                {liquid.filter((a) => a.id !== toAccountId).map(accountOption)}
              </select>
            </Field>
            <Field label="Entra a">
              <select className="input" value={toAccountId} onChange={(e) => setToAcc(e.target.value)} required>
                <option value="">Selecciona…</option>
                {liquid.filter((a) => a.id !== fromAccountId).map(accountOption)}
              </select>
            </Field>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Monto (${currency})`}>
            <input className="input text-right" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Fecha real">
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        <Field label="Descripción (opcional)">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="p. ej. Fondeo de caja chica" />
        </Field>
        <p className="text-xs text-slate-500">
          Se registra al momento: mueve el saldo entre las dos cuentas sin cambiar la caja total de la unidad de negocio. Para pagar una tarjeta usa la pestaña Tarjetas.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={loading} disabled={!fromAccountId || !toAccountId}>
            Transferir
          </Button>
        </div>
      </form>
    </Modal>
  );
}
