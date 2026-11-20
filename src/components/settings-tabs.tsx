'use client';

/** Pestañas de Ajustes (por unidad de negocio) y Configuración (toda la aplicación). */

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Archive, ArchiveRestore, Copy, GripVertical, KeyRound, Lock, Merge, Pencil, Plus, Scale, Star, Trash2, Webhook } from 'lucide-react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useApp } from '@/components/AppContext';
import { Badge, Button, Card, cn, confirmDialog, EmptyState, ErrorBox, Field, Loading, Modal, TableTotals, Tabs, Toggle, useToast } from '@/components/ui';
import { EntityDot } from '@/components/AppShell';
import { AccountFormModal, centsInput, EntityFormModal, parseMoneyInput } from '@/components/forms';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { centsToDecimalString, formatMoney, toCents } from '@/lib/money';
import type { AccountDto, EntityDto } from '@/lib/server/dto';

function useAction() {
  const toast = useToast();
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      emitDataChanged();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
      return false;
    }
  };
}

// ---------------------------------------------------------------- Categorías
interface CategoryRow {
  id: string;
  entityId: string;
  name: string;
  direction: 'IN' | 'OUT';
  color: string | null;
  uses: { obligations: number; rules: number; cardCharges: number };
}

const CATEGORY_PALETTE = ['#10b981', '#6366f1', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899', '#84cc16', '#64748b'];

const usesOf = (c: CategoryRow) => c.uses.obligations + c.uses.rules + c.uses.cardCharges;
function usesLabel(c: CategoryRow) {
  const parts = [
    c.uses.obligations && `${c.uses.obligations} partida${c.uses.obligations === 1 ? '' : 's'}`,
    c.uses.rules && `${c.uses.rules} recurrente${c.uses.rules === 1 ? '' : 's'}`,
    c.uses.cardCharges && `${c.uses.cardCharges} consumo${c.uses.cardCharges === 1 ? '' : 's'} de tarjeta`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Sin uso';
}

/** Catálogo de categorías de gastos e ingresos de cada unidad (para etiquetar y analizar movimientos). */
export function CategoriesTab() {
  const app = useApp();
  const act = useAction();
  const { data, error, loading } = useApi<CategoryRow[]>(`/api/categories?ctx=${encodeURIComponent(app.ctx)}`);
  const [form, setForm] = useState<{ open: boolean; category: CategoryRow | null; direction: 'IN' | 'OUT' }>({
    open: false,
    category: null,
    direction: 'OUT',
  });
  const [merging, setMerging] = useState<CategoryRow | null>(null);
  const consolidated = !app.currentEntity;

  async function remove(c: CategoryRow) {
    const n = usesOf(c);
    if (
      !(await confirmDialog({
        title: 'Eliminar categoría',
        message: n
          ? `"${c.name}" se usa en ${usesLabel(c)}. Si la eliminas, todo eso queda "Sin categoría" (no se borra ningún movimiento). Si quieres conservar la etiqueta, mejor usa "Fusionar".`
          : `¿Eliminar la categoría "${c.name}"?`,
        confirmLabel: 'Eliminar',
        tone: 'danger',
      }))
    )
      return;
    await act(() => api(`/api/categories/${c.id}`, { method: 'DELETE' }), 'Categoría eliminada');
  }

  const section = (direction: 'IN' | 'OUT') => {
    const rows = (data ?? []).filter((c) => c.direction === direction);
    return (
      <Card className="p-0 sm:p-0">
        <div className="flex items-center justify-between border-b border-slate-200 p-3 dark:border-slate-800">
          <div>
            <h2 className="font-semibold">{direction === 'OUT' ? 'Categorías de gastos' : 'Categorías de ingresos'}</h2>
            <p className="text-xs text-slate-500">
              {direction === 'OUT' ? 'Para CxP, gastos recurrentes y consumos con tarjeta.' : 'Para CxC e ingresos recurrentes.'}
            </p>
          </div>
          <Button variant="primary" onClick={() => setForm({ open: true, category: null, direction })}>
            <Plus className="h-4 w-4" /> Nueva
          </Button>
        </div>
        {!rows.length ? (
          <EmptyState title="Sin categorías">
            {direction === 'OUT' ? 'Ej.: Planilla, Alquiler, Inventario, Publicidad, Servicios públicos…' : 'Ej.: Ventas de contado, Servicios, Comisiones…'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <th className="th">Categoría</th>
                  {consolidated && <th className="th">Unidad de negocio</th>}
                  <th className="th">Uso</th>
                  <th className="th text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const e = app.entityById.get(c.entityId);
                  return (
                    <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="td">
                        <span className="inline-flex items-center gap-2 font-medium">
                          <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color ?? '#94a3b8' }} />
                          {c.name}
                        </span>
                      </td>
                      {consolidated && (
                        <td className="td">
                          <span className="inline-flex items-center gap-1.5">
                            {e && <EntityDot color={e.color} />} {e?.name}
                          </span>
                        </td>
                      )}
                      <td className="td text-sm text-slate-500">{usesLabel(c)}</td>
                      <td className="td">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" title="Renombrar / color" onClick={() => setForm({ open: true, category: c, direction })}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" title="Fusionar en otra categoría (pasa todo lo etiquetado)" onClick={() => setMerging(c)}>
                            <Merge className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" title="Eliminar" onClick={() => remove(c)}>
                            <Trash2 className="h-4 w-4 text-rose-500" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      {error ? (
        <ErrorBox message={error} />
      ) : loading && !data ? (
        <Loading />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {section('OUT')}
          {section('IN')}
        </div>
      )}
      <CategoryFormModal
        open={form.open}
        onClose={() => setForm((f) => ({ ...f, open: false }))}
        category={form.category}
        direction={form.direction}
      />
      <CategoryMergeModal source={merging} all={data ?? []} onClose={() => setMerging(null)} />
    </div>
  );
}

function CategoryFormModal({
  open,
  onClose,
  category,
  direction,
}: {
  open: boolean;
  onClose: () => void;
  category: CategoryRow | null;
  direction: 'IN' | 'OUT';
}) {
  const app = useApp();
  const act = useAction();
  const [entityId, setEntityId] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState(CATEGORY_PALETTE[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEntityId(category?.entityId ?? app.currentEntity?.id ?? app.activeEntities[0]?.id ?? '');
    setName(category?.name ?? '');
    setColor(category?.color ?? CATEGORY_PALETTE[Math.floor(Math.random() * CATEGORY_PALETTE.length)]);
  }, [open, category, app.currentEntity, app.activeEntities]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (category) await api(`/api/categories/${category.id}`, { method: 'PATCH', body: { name, color } });
      else await api('/api/categories', { body: { entityId, name, direction, color } });
      await act(async () => undefined, category ? 'Categoría actualizada' : 'Categoría creada');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setSaving(false);
    }
  }

  const kind = direction === 'OUT' ? 'gasto' : 'ingreso';
  return (
    <Modal open={open} onClose={onClose} title={category ? `Editar categoría: ${category.name}` : `Nueva categoría de ${kind}`}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBox message={error} />}
        {!category && !app.currentEntity && (
          <Field label="Unidad de negocio">
            <select className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)} required>
              {app.activeEntities.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Nombre">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus />
        </Field>
        <Field label="Color (para gráficos y reportes)">
          <div className="flex flex-wrap items-center gap-2">
            {CATEGORY_PALETTE.map((c) => (
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
        {category && usesOf(category) > 0 && (
          <p className="text-xs text-slate-500">Lo ya etiquetado ({usesLabel(category)}) toma el nuevo nombre automáticamente.</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {category ? 'Guardar' : 'Crear'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Fusiona una categoría en otra (misma unidad y tipo): pasa todo lo etiquetado y elimina la original. */
function CategoryMergeModal({ source, all, onClose }: { source: CategoryRow | null; all: CategoryRow[]; onClose: () => void }) {
  const act = useAction();
  const [target, setTarget] = useState('');
  const [saving, setSaving] = useState(false);
  const candidates = useMemo(
    () => (source ? all.filter((c) => c.id !== source.id && c.entityId === source.entityId && c.direction === source.direction) : []),
    [all, source],
  );
  useEffect(() => setTarget(candidates[0]?.id ?? ''), [candidates]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!source || !target) return;
    setSaving(true);
    const ok = await act(() => api(`/api/categories/${source.id}`, { method: 'DELETE', body: { mergeInto: target } }), 'Categorías fusionadas');
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <Modal open={Boolean(source)} onClose={onClose} title={`Fusionar "${source?.name ?? ''}"`}>
      <form onSubmit={submit} className="space-y-3">
        {!candidates.length ? (
          <ErrorBox message="No hay otra categoría del mismo tipo en esta unidad para fusionar." />
        ) : (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Todo lo etiquetado con «{source?.name}» ({source ? usesLabel(source) : ''}) pasa a la categoría elegida, y «{source?.name}» se elimina.
              Útil para limpiar duplicadas (p. ej. «Gasolina» y «Combustible»).
            </p>
            <Field label="Pasar todo a">
              <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} required>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!candidates.length}>
            Fusionar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Cuentas
export function AccountsTab() {
  const app = useApp();
  const act = useAction();
  const { data, error, loading } = useApi<AccountDto[]>(`/api/accounts?ctx=${encodeURIComponent(app.ctx)}`);
  const [form, setForm] = useState<{ open: boolean; account: AccountDto | null }>({ open: false, account: null });
  const [reconciling, setReconciling] = useState<AccountDto | null>(null);
  const [actual, setActual] = useState('');

  const TYPE: Record<string, string> = { BANK: 'Banco', CASH: 'Caja chica', WALLET: 'Billetera', CREDIT_CARD: 'Tarjeta de crédito' };
  const recIsCard = reconciling?.type === 'CREDIT_CARD';
  const [recCurrency, setRecCurrency] = useState<string | null>(null); // null = moneda de la entidad
  const recEntityCur = reconciling ? (app.entityById.get(reconciling.entityId)?.currency ?? 'HNL') : 'HNL';
  const recCur = recCurrency ?? recEntityCur;
  const recBalance = reconciling ? (recCurrency ? reconciling.balanceForeign : reconciling.balance) : 0;

  return (
    <Card className="p-0 sm:p-0">
      <div className="flex items-center justify-between border-b border-slate-200 p-3 dark:border-slate-800">
        <p className="text-sm text-slate-500">
          Saldos reales = apertura + cobros − pagos ± ajustes. Las tarjetas muestran su deuda y no suman a la caja real.
        </p>
        <Button variant="primary" onClick={() => setForm({ open: true, account: null })}>
          <Plus className="h-4 w-4" /> Nueva cuenta
        </Button>
      </div>
      {error ? (
        <div className="p-4">
          <ErrorBox message={error} />
        </div>
      ) : loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <EmptyState title="Sin cuentas en este contexto">Registra tus cuentas bancarias, cajas chicas y billeteras con su saldo actual.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <th className="th">Cuenta</th>
                <th className="th">Unidad de negocio</th>
                <th className="th">Tipo</th>
                <th className="th text-right">Saldo real</th>
                <th className="th text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => {
                const e = app.entityById.get(a.entityId);
                return (
                  <tr key={a.id} className={cn('border-t border-slate-100 dark:border-slate-800', a.archived && 'opacity-50')}>
                    <td className="td">
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-slate-500">{a.institution}</div>
                    </td>
                    <td className="td">
                      <span className="inline-flex items-center gap-1.5">
                        {e && <EntityDot color={e.color} />} {e?.name}
                      </span>
                    </td>
                    <td className="td">
                      {TYPE[a.type]}
                      {a.type === 'CREDIT_CARD' && (
                        <div className="text-xs text-slate-500">
                          Corte {a.statementDay} · pago {a.paymentDueDay}
                          {a.creditLimit ? ` · límite ${formatMoney(a.creditLimit, e?.currency ?? 'HNL')}` : ''}
                          {a.foreignCurrency && ` · bimoneda${a.creditLimitForeign ? ` (límite ${formatMoney(a.creditLimitForeign, a.foreignCurrency)})` : ''}`}
                          {a.customSellRate && ` · tasa propia ${a.customSellRate}`}
                        </div>
                      )}
                    </td>
                    {a.type === 'CREDIT_CARD' ? (
                      <td className="td num font-semibold text-rose-600">
                        {a.balance < 0 ? `Deuda ${formatMoney(-a.balance, e?.currency ?? 'HNL')}` : formatMoney(a.balance, e?.currency ?? 'HNL')}
                        {a.foreignCurrency && (
                          <div>{a.balanceForeign < 0 ? `+ ${formatMoney(-a.balanceForeign, a.foreignCurrency)}` : formatMoney(a.balanceForeign, a.foreignCurrency)}</div>
                        )}
                      </td>
                    ) : (
                      <td className={cn('td num font-semibold', a.balance < 0 && 'text-rose-600')}>{formatMoney(a.balance, e?.currency ?? 'HNL')}</td>
                    )}
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        {!a.archived && (
                          <Button size="sm" variant="ghost" title="Editar" onClick={() => setForm({ open: true, account: a })}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {!a.archived && (
                          <Button
                            size="sm"
                            onClick={() => {
                              setReconciling(a);
                              setRecCurrency(null);
                              setActual(centsInput(a.type === 'CREDIT_CARD' ? -a.balance : a.balance));
                            }}
                          >
                            <Scale className="h-3.5 w-3.5" /> Conciliar
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          title={a.archived ? 'Reactivar' : 'Archivar'}
                          onClick={() => act(() => api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { archived: !a.archived } }), a.archived ? 'Cuenta reactivada' : 'Cuenta archivada')}
                        >
                          {a.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <TableTotals
              rows={data}
              noun={['cuenta', 'cuentas']}
              note={data.some((a) => a.archived) ? 'sin archivadas' : undefined}
              section={(a) => (a.archived ? false : a.type === 'CREDIT_CARD' ? 'Deuda en tarjetas' : 'Caja real')}
              columns={[
                null,
                null,
                null,
                (a) => {
                  const c = app.entityById.get(a.entityId)?.currency ?? 'HNL';
                  if (a.type !== 'CREDIT_CARD') return { amount: a.balance, currency: c };
                  // Deuda en positivo, como se muestra en cada tarjeta
                  return [{ amount: -a.balance, currency: c }, ...(a.foreignCurrency && a.balanceForeign ? [{ amount: -a.balanceForeign, currency: a.foreignCurrency }] : [])];
                },
                null,
              ]}
            />
          </table>
        </div>
      )}
      <AccountFormModal open={form.open} account={form.account} onClose={() => setForm({ open: false, account: null })} />
      <Modal
        open={Boolean(reconciling)}
        onClose={() => setReconciling(null)}
        title={`Conciliar: ${reconciling?.name ?? ''}`}
        footer={
          <>
            <Button onClick={() => setReconciling(null)}>Cancelar</Button>
            <Button
              variant="primary"
              onClick={async () => {
                const v = parseMoneyInput(actual);
                if (v === null || !reconciling) return;
                // En tarjetas se captura la deuda (positiva); el saldo contable es su negativo
                const balance = recIsCard ? centsToDecimalString(-toCents(v)) : v;
                const ok = await act(
                  () => api(`/api/accounts/${reconciling.id}/reconcile`, { body: { actualBalance: balance, currency: recCurrency } }),
                  'Saldo conciliado',
                );
                if (ok) setReconciling(null);
              }}
            >
              Ajustar saldo
            </Button>
          </>
        }
      >
        {recIsCard && reconciling?.foreignCurrency && (
          <div className="mb-3">
            <Tabs<string>
              tabs={[
                { id: 'base', label: `Sub-saldo ${recEntityCur}` },
                { id: reconciling.foreignCurrency, label: `Sub-saldo ${reconciling.foreignCurrency}` },
              ]}
              value={recCurrency ?? 'base'}
              onChange={(v) => {
                const cur = v === 'base' ? null : v;
                setRecCurrency(cur);
                setActual(centsInput(-(cur ? reconciling.balanceForeign : reconciling.balance)));
              }}
            />
          </div>
        )}
        {recIsCard ? (
          <p className="mb-3 text-sm text-slate-500">
            Deuda en sistema: <strong>{reconciling && formatMoney(Math.max(-recBalance, 0), recCur)}</strong>.
            Ingresa la deuda que muestra el banco (p. ej. con intereses o comisiones); la diferencia se registra como ajuste. Para
            proyectar su pago, registra los intereses como un consumo.
          </p>
        ) : (
          <p className="mb-3 text-sm text-slate-500">
            Saldo en sistema: <strong>{reconciling && formatMoney(reconciling.balance, app.entityById.get(reconciling.entityId)?.currency ?? 'HNL')}</strong>. Ingresa
            el saldo que muestra el banco hoy; la diferencia se registra como ajuste.
          </p>
        )}
        <Field label={recIsCard ? `Deuda según estado de cuenta (${recCur})` : 'Saldo real según banco'}>
          <input className="input text-right" inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------- Unidad de negocio actual
type WebhookToken = { token: string; endpoint: string; entity: string };

/** Datos e integración de la unidad de negocio seleccionada en el menú superior. */
export function UnitTab() {
  const app = useApp();
  const act = useAction();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState<WebhookToken | null>(null);
  const e = app.currentEntity;

  if (!e) {
    return (
      <Card>
        <EmptyState title="Elige una unidad de negocio">
          <p>Estos ajustes son propios de cada unidad de negocio. Selecciona una (también puedes usar el menú superior):</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {app.activeEntities.map((u) => (
              <Button key={u.id} onClick={() => app.setCtx(u.id)}>
                <EntityDot color={u.color} /> {u.name}
              </Button>
            ))}
          </div>
        </EmptyState>
      </Card>
    );
  }

  async function rotate(u: EntityDto) {
    if (
      u.webhookEnabled &&
      !(await confirmDialog({
        title: 'Rotar token del webhook',
        message: 'Se generará un token nuevo y el anterior dejará de funcionar. ¿Continuar?',
        confirmLabel: 'Generar token nuevo',
        tone: 'danger',
      }))
    )
      return;
    try {
      const r = await api<{ token: string; endpoint: string }>(`/api/entities/${u.id}/webhook-token`, { method: 'POST' });
      setToken({ ...r, entity: u.name });
      emitDataChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error', 'error');
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="font-semibold">Datos de la unidad de negocio</h2>
          {app.isAdmin && (
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Editar
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-[auto,1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-slate-500">Nombre</dt>
          <dd className="flex flex-wrap items-center gap-2 font-medium">
            <EntityDot color={e.color} /> {e.name}
            {e.isDefault && <Badge tone="green">Base</Badge>}
            {e.archived && <Badge>Archivada</Badge>}
          </dd>
          <dt className="text-slate-500">Moneda base</dt>
          <dd>{e.currency}</dd>
          <dt className="text-slate-500">Umbral mínimo de caja</dt>
          <dd className="tabular-nums">{formatMoney(e.minCashThreshold, e.currency)}</dd>
        </dl>
        <p className="mt-4 text-xs text-slate-500">
          Crear, ordenar, archivar o eliminar unidades de negocio se hace en Configuración → Unidades de negocio.
        </p>
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-semibold">
            <Webhook className="h-4 w-4 text-slate-500" /> Integración (webhook)
          </h2>
          {e.webhookEnabled ? <Badge tone="green">Activo · …{e.webhookTokenHint}</Badge> : <Badge>Inactivo</Badge>}
        </div>
        <p className="text-sm text-slate-500">
          Permite que el CRM o n8n envíen cuentas por cobrar y por pagar de esta unidad de negocio. Llegan a la Bandeja externa
          como pendientes de revisión.
        </p>
        {app.isAdmin && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => rotate(e)}>
              <Webhook className="h-4 w-4" /> {e.webhookEnabled ? 'Rotar token' : 'Generar webhook'}
            </Button>
            {e.webhookEnabled && (
              <Button
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: 'Desactivar webhook',
                      message: `¿Desactivar el webhook de "${e.name}"? Las integraciones que lo usan dejarán de enviar datos.`,
                      confirmLabel: 'Desactivar',
                      tone: 'danger',
                    })
                  )
                    void act(() => api(`/api/entities/${e.id}/webhook-token`, { method: 'DELETE' }), 'Webhook desactivado');
                }}
              >
                <KeyRound className="h-4 w-4 text-rose-500" /> Desactivar
              </Button>
            )}
          </div>
        )}
      </Card>

      <EntityFormModal open={editing} entity={e} onClose={() => setEditing(false)} onSaved={() => app.refresh()} />
      <WebhookTokenModal token={token} onClose={() => setToken(null)} />
    </div>
  );
}

function WebhookTokenModal({ token, onClose }: { token: WebhookToken | null; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal open={Boolean(token)} onClose={onClose} title={`Webhook de ${token?.entity ?? ''}`} wide>
      {token && (
        <div className="space-y-3 text-sm">
          <p className="rounded-lg bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Copia este endpoint ahora: por seguridad no se volverá a mostrar completo.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-lg bg-slate-100 p-2 text-xs dark:bg-slate-800">{token.endpoint}</code>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(token.endpoint);
                toast('Copiado');
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-slate-500">Ejemplo (n8n / CRM):</p>
          <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{`curl -X POST '${token.endpoint}' \\
-H 'Content-Type: application/json' \\
-d '{"type":"receivable","description":"Factura 001-123","amount":"15000.00",
     "dueDate":"2026-12-01","counterparty":"Cliente S.A.",
     "externalId":"crm-991","source":"crm-publimatec"}'`}</pre>
          <p className="text-slate-500">Los movimientos llegan a la Bandeja externa como pendientes de revisión.</p>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Entidades
/** Arrastre solo vertical (equivale a restrictToVerticalAxis sin otra dependencia). */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** Fila de tabla reordenable; `children` recibe el asa de arrastre ya armada. */
function SortableEntityRow({ id, className, children }: { id: string; className?: string; children: (handle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition, position: 'relative', zIndex: isDragging ? 10 : undefined };
  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      title="Arrastra para cambiar el orden"
      aria-label="Arrastra para cambiar el orden"
      className="inline-flex h-7 w-6 cursor-grab touch-none items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing dark:hover:bg-slate-800 dark:hover:text-slate-200"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="h-4 w-4" />
    </button>
  );
  return (
    <tr ref={setNodeRef} style={style} className={cn(className, isDragging && 'bg-white shadow-lg ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700')}>
      {children(handle)}
    </tr>
  );
}

export function EntitiesTab() {
  const app = useApp();
  const act = useAction();
  const [editing, setEditing] = useState<{ open: boolean; entity: EntityDto | null }>({ open: false, entity: null });
  const toast = useToast();

  // Orden optimista mientras se guarda; al refrescar el contexto vuelve a mandar el servidor
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => setOrder(null), [app.entities]);
  const entities = useMemo(() => {
    if (!order) return app.entities;
    const pos = new Map(order.map((id, i) => [id, i]));
    return [...app.entities].sort((a, b) =>
      a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity),
    );
  }, [app.entities, order]);
  const sortableIds = useMemo(() => entities.filter((e) => !e.isDefault).map((e) => e.id), [entities]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = sortableIds.indexOf(String(active.id));
    const to = sortableIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(sortableIds, from, to);
    setOrder(next);
    try {
      await api('/api/entities/order', { method: 'PUT', body: { ids: next } });
      emitDataChanged();
    } catch (err) {
      setOrder(null);
      toast(err instanceof Error ? err.message : 'No se pudo guardar el orden', 'error');
    }
  }

  async function makeDefault(e: EntityDto) {
    if (
      !(await confirmDialog({
        title: 'Unidad de negocio Base',
        message: `¿Definir "${e.name}" como unidad de negocio Base? Aparecerá primero en el menú y será la unidad de negocio por defecto al registrar.`,
        confirmLabel: 'Definir como Base',
        tone: 'primary',
      }))
    )
      return;
    void act(() => api(`/api/entities/${e.id}/make-default`, { method: 'POST' }), `"${e.name}" es ahora la unidad de negocio Base`);
  }

  async function remove(e: EntityDto) {
    if (
      !(await confirmDialog({
        title: 'Eliminar unidad de negocio',
        message: `¿Eliminar definitivamente "${e.name}"? Solo es posible si no tiene ningún dato registrado. Esta acción no se puede deshacer.`,
        confirmLabel: 'Eliminar',
        tone: 'danger',
      }))
    )
      return;
    const done = await act(() => api(`/api/entities/${e.id}`, { method: 'DELETE' }), `Unidad de negocio "${e.name}" eliminada`);
    if (done && app.ctx === e.id) app.setCtx('all');
  }

  return (
    <div className="space-y-4">
      <Card className="p-0 sm:p-0">
        <div className="flex items-center justify-between border-b border-slate-200 p-3 dark:border-slate-800">
          <p className="text-sm text-slate-500">
            Cada unidad de negocio tiene datos aislados, su moneda base y su umbral de alerta. La unidad de negocio Base va primero y es la
            predeterminada (se cambia con la estrella); el resto se ordena arrastrando y así se verá en el menú.
          </p>
          {app.isAdmin && (
            <Button variant="primary" onClick={() => setEditing({ open: true, entity: null })}>
              <Plus className="h-4 w-4" /> Nueva unidad de negocio
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <DndContext id="entities-order" sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragEnd={onDragEnd}>
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <table className="w-full">
                <thead className="bg-slate-50 dark:bg-slate-800/50">
                  <tr>
                    {app.isAdmin && <th className="th w-8" />}
                    <th className="th">Unidad de negocio</th>
                    <th className="th">Moneda</th>
                    <th className="th text-right">Umbral mínimo</th>
                    <th className="th text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {entities.map((e) => {
                    const rowClass = cn('border-t border-slate-100 dark:border-slate-800', e.archived && 'opacity-50');
                    const cells = (handle: ReactNode) => (
                      <>
                        {app.isAdmin && <td className="td w-8 pr-0">{handle}</td>}
                        <td className="td">
                          <span className="inline-flex items-center gap-2 font-medium">
                            <EntityDot color={e.color} /> {e.name}
                            {e.isDefault && <Badge tone="green">Base</Badge>}
                            {e.archived && <Badge>Archivada</Badge>}
                          </span>
                        </td>
                        <td className="td">{e.currency}</td>
                        <td className="td num">{formatMoney(e.minCashThreshold, e.currency)}</td>
                        <td className="td">
                          {app.isAdmin && (
                            <div className="flex justify-end gap-1">
                              {!e.isDefault && !e.archived && (
                                <Button size="sm" variant="ghost" title="Definir como unidad de negocio Base" onClick={() => makeDefault(e)}>
                                  <Star className="h-4 w-4 text-amber-500" />
                                </Button>
                              )}
                              <Button size="sm" variant="ghost" title="Editar" onClick={() => setEditing({ open: true, entity: e })}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              {!e.isDefault && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  title={e.archived ? 'Reactivar' : 'Archivar'}
                                  onClick={() =>
                                    act(
                                      () => api(`/api/entities/${e.id}`, { method: 'PATCH', body: { archived: !e.archived } }),
                                      e.archived ? 'Unidad de negocio reactivada' : 'Unidad de negocio archivada',
                                    )
                                  }
                                >
                                  {e.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                                </Button>
                              )}
                              {!e.isDefault && (
                                <Button size="sm" variant="ghost" title="Eliminar (solo si está vacía)" onClick={() => remove(e)}>
                                  <Trash2 className="h-4 w-4 text-rose-500" />
                                </Button>
                              )}
                            </div>
                          )}
                        </td>
                      </>
                    );
                    if (e.isDefault || !app.isAdmin) {
                      return (
                        <tr key={e.id} className={rowClass}>
                          {cells(
                            <span className="inline-flex h-7 w-6 items-center justify-center text-slate-300 dark:text-slate-600" title="La unidad de negocio Base siempre va primero">
                              <Lock className="h-3.5 w-3.5" />
                            </span>,
                          )}
                        </tr>
                      );
                    }
                    return (
                      <SortableEntityRow key={e.id} id={e.id} className={rowClass}>
                        {cells}
                      </SortableEntityRow>
                    );
                  })}
                </tbody>
              </table>
            </SortableContext>
          </DndContext>
        </div>
      </Card>

      <EntityFormModal
        open={editing.open}
        entity={editing.entity}
        onClose={() => setEditing({ open: false, entity: null })}
        onSaved={() => app.refresh()}
      />

    </div>
  );
}

// ---------------------------------------------------------------- Tasas
interface RateRow {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveDate: string;
  officialSellRate: string | null;
  bankSpread: string | null;
  effectiveSellRate: string | null;
  source: string | null;
}

export function RatesTab() {
  const app = useApp();
  const act = useAction();
  const { data, error, loading } = useApi<RateRow[]>('/api/rates');
  const [from, setFrom] = useState('USD');
  const [to, setTo] = useState(app.settings.reportingCurrency);
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(app.today);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {app.isAdmin && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Registrar tasa</h2>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await act(() => api('/api/rates', { body: { fromCurrency: from, toCurrency: to, rate, effectiveDate: date } }), 'Tasa guardada');
              if (ok) setRate('');
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="1 unidad de">
                <input className="input uppercase" maxLength={3} value={from} onChange={(e) => setFrom(e.target.value.toUpperCase())} required />
              </Field>
              <Field label="Equivale en">
                <input className="input uppercase" maxLength={3} value={to} onChange={(e) => setTo(e.target.value.toUpperCase())} required />
              </Field>
            </div>
            <Field label="Tasa">
              <input className="input text-right" inputMode="decimal" placeholder="24.7500" value={rate} onChange={(e) => setRate(e.target.value)} required />
            </Field>
            <Field label="Vigente desde">
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
            <Button type="submit" variant="primary" className="w-full">
              Guardar tasa
            </Button>
            <p className="text-xs text-slate-500">
              Se usan para la vista consolidada (moneda de reporte: {app.settings.reportingCurrency}). Nunca alteran los saldos reales. La
              tasa USD→HNL del día (con spread bancario para tarjetas) se sincroniza sola a las 08:30; edítala desde el indicador de la
              barra superior.
            </p>
          </form>
        </Card>
      )}
      <Card className={cn('p-0 sm:p-0', app.isAdmin ? 'lg:col-span-2' : 'lg:col-span-3')}>
        {error ? (
          <div className="p-4">
            <ErrorBox message={error} />
          </div>
        ) : loading && !data ? (
          <Loading />
        ) : !data?.length ? (
          <EmptyState title="Sin tasas registradas" />
        ) : (
          <table className="w-full">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <th className="th">Par</th>
                <th className="th text-right">Tasa</th>
                <th className="th text-right">Spread</th>
                <th className="th text-right">Venta efectiva</th>
                <th className="th">Fuente</th>
                <th className="th">Vigente desde</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="td font-medium">
                    1 {r.fromCurrency} = {r.toCurrency}
                  </td>
                  <td className="td num">{Number(r.rate).toLocaleString('es-HN', { maximumFractionDigits: 6 })}</td>
                  <td className="td num text-slate-500">{r.bankSpread ?? '—'}</td>
                  <td className="td num font-semibold">{r.effectiveSellRate ?? '—'}</td>
                  <td className="td text-xs">{r.source === 'API' ? 'En línea' : r.source === 'MANUAL' ? 'Manual' : (r.source ?? 'Manual')}</td>
                  <td className="td">{r.effectiveDate}</td>
                  <td className="td text-right">
                    {app.isAdmin && (
                      <Button size="sm" variant="ghost" onClick={async () => {
                          if (
                            await confirmDialog({
                              title: 'Eliminar tasa',
                              message: `¿Eliminar la tasa ${r.fromCurrency}/${r.toCurrency} vigente desde ${r.effectiveDate}?`,
                              confirmLabel: 'Eliminar',
                              tone: 'danger',
                            })
                          )
                            void act(() => api(`/api/rates/${r.id}`, { method: 'DELETE' }), 'Tasa eliminada');
                        }}>
                        <Trash2 className="h-4 w-4 text-rose-500" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Usuarios
interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
  active: boolean;
  entityIds: string[];
}

export function UsersTab() {
  const app = useApp();
  const act = useAction();
  const { data, error, loading } = useApi<UserRow[]>('/api/users');
  const [form, setForm] = useState<{ open: boolean; user: UserRow | null }>({ open: false, user: null });
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'USER'>('USER');
  const [entityIds, setEntityIds] = useState<string[]>([]);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!form.open) return;
    setEmail(form.user?.email ?? '');
    setName(form.user?.name ?? '');
    setPassword('');
    setRole(form.user?.role ?? 'USER');
    setEntityIds(form.user?.entityIds ?? []);
    setActive(form.user?.active ?? true);
  }, [form]);

  async function save() {
    const u = form.user;
    const ok = u
      ? await act(
          () => api(`/api/users/${u.id}`, { method: 'PATCH', body: { name, role, active, entityIds, ...(password ? { password } : {}) } }),
          'Usuario actualizado',
        )
      : await act(() => api('/api/users', { body: { email, name, password, role, entityIds } }), 'Usuario creado');
    if (ok) setForm({ open: false, user: null });
  }

  return (
    <Card className="p-0 sm:p-0">
      <div className="flex items-center justify-between border-b border-slate-200 p-3 dark:border-slate-800">
        <p className="text-sm text-slate-500">Los administradores ven todas las unidades de negocio; los usuarios solo las asignadas.</p>
        <Button variant="primary" onClick={() => setForm({ open: true, user: null })}>
          <Plus className="h-4 w-4" /> Nuevo usuario
        </Button>
      </div>
      {error ? (
        <div className="p-4">
          <ErrorBox message={error} />
        </div>
      ) : loading && !data ? (
        <Loading />
      ) : (
        <table className="w-full">
          <thead className="bg-slate-50 dark:bg-slate-800/50">
            <tr>
              <th className="th">Usuario</th>
              <th className="th">Rol</th>
              <th className="th">Unidades de negocio</th>
              <th className="th">Estado</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {data?.map((u) => (
              <tr key={u.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="td">
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </td>
                <td className="td">{u.role === 'ADMIN' ? <Badge tone="violet">Administrador</Badge> : <Badge>Usuario</Badge>}</td>
                <td className="td text-xs">
                  {u.role === 'ADMIN' ? 'Todas' : u.entityIds.map((id) => app.entityById.get(id)?.name).filter(Boolean).join(', ') || 'Ninguna'}
                </td>
                <td className="td">{u.active ? <Badge tone="green">Activo</Badge> : <Badge tone="red">Inactivo</Badge>}</td>
                <td className="td text-right">
                  <Button size="sm" variant="ghost" onClick={() => setForm({ open: true, user: u })}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal
        open={form.open}
        onClose={() => setForm({ open: false, user: null })}
        title={form.user ? 'Editar usuario' : 'Nuevo usuario'}
        footer={
          <>
            <Button onClick={() => setForm({ open: false, user: null })}>Cancelar</Button>
            <Button variant="primary" onClick={save}>
              Guardar
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {!form.user && (
            <Field label="Correo">
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          )}
          <Field label="Nombre">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={form.user ? 'Nueva contraseña (opcional)' : 'Contraseña'} hint="Mínimo 10 caracteres">
            <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Rol">
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as 'ADMIN' | 'USER')}>
              <option value="USER">Usuario (unidades de negocio asignadas)</option>
              <option value="ADMIN">Administrador (todo)</option>
            </select>
          </Field>
          {role === 'USER' && (
            <div>
              <span className="label">Unidades de negocio con acceso</span>
              <div className="space-y-1">
                {app.activeEntities.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={entityIds.includes(e.id)}
                      onChange={(ev) => setEntityIds((ids) => (ev.target.checked ? [...ids, e.id] : ids.filter((x) => x !== e.id)))}
                    />
                    <EntityDot color={e.color} /> {e.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {form.user && <Toggle checked={active} onChange={setActive} label="Usuario activo" />}
        </div>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------- General
export function GeneralTab() {
  const app = useApp();
  const act = useAction();
  const [currency, setCurrency] = useState(app.settings.reportingCurrency);
  const [tz, setTz] = useState(app.settings.timezone);
  return (
    <Card className="max-w-lg">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act(() => api('/api/settings', { method: 'PATCH', body: { reportingCurrency: currency, timezone: tz } }), 'Ajustes guardados');
          if (ok) await app.refresh();
        }}
      >
        <Field label="Moneda de reporte (vista consolidada)">
          <input className="input uppercase" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Zona horaria" hint="Define qué día es 'hoy' para vencidos y proyecciones">
          <input className="input" value={tz} onChange={(e) => setTz(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary">
          Guardar
        </Button>
      </form>
    </Card>
  );
}
