'use client';

import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, Copy, KeyRound, Pencil, Plus, Scale, Trash2, Webhook } from 'lucide-react';
import { useApp } from '@/components/AppContext';
import { Badge, Button, Card, cn, EmptyState, ErrorBox, Field, Loading, Modal, Tabs, Toggle, useToast } from '@/components/ui';
import { EntityDot } from '@/components/AppShell';
import { AccountFormModal, centsInput, EntityFormModal, parseMoneyInput } from '@/components/forms';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { centsToDecimalString, formatMoney, toCents } from '@/lib/money';
import type { AccountDto, EntityDto } from '@/lib/server/dto';

type Tab = 'entities' | 'accounts' | 'rates' | 'users' | 'general';

export default function SettingsPage() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('accounts');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'accounts', label: 'Cuentas' },
    { id: 'entities', label: 'Entidades e integraciones' },
    { id: 'rates', label: 'Tasas de cambio' },
    ...(app.isAdmin
      ? [
          { id: 'users' as Tab, label: 'Usuarios' },
          { id: 'general' as Tab, label: 'General' },
        ]
      : []),
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">Configuración</h1>
        <Tabs<Tab> tabs={tabs} value={tab} onChange={setTab} />
      </div>
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'entities' && <EntitiesTab />}
      {tab === 'rates' && <RatesTab />}
      {tab === 'users' && app.isAdmin && <UsersTab />}
      {tab === 'general' && app.isAdmin && <GeneralTab />}
    </div>
  );
}

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

// ---------------------------------------------------------------- Cuentas
function AccountsTab() {
  const app = useApp();
  const act = useAction();
  const { data, error, loading } = useApi<AccountDto[]>(`/api/accounts?ctx=${encodeURIComponent(app.ctx)}`);
  const [creating, setCreating] = useState(false);
  const [reconciling, setReconciling] = useState<AccountDto | null>(null);
  const [actual, setActual] = useState('');

  const TYPE: Record<string, string> = { BANK: 'Banco', CASH: 'Caja chica', WALLET: 'Billetera', CREDIT_CARD: 'Tarjeta de crédito' };
  const recIsCard = reconciling?.type === 'CREDIT_CARD';

  return (
    <Card className="p-0 sm:p-0">
      <div className="flex items-center justify-between border-b border-slate-200 p-3 dark:border-slate-800">
        <p className="text-sm text-slate-500">
          Saldos reales = apertura + cobros − pagos ± ajustes. Las tarjetas muestran su deuda y no suman a la caja real.
        </p>
        <Button variant="primary" onClick={() => setCreating(true)}>
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
                <th className="th">Entidad</th>
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
                        </div>
                      )}
                    </td>
                    {a.type === 'CREDIT_CARD' ? (
                      <td className="td num font-semibold text-rose-600">
                        {a.balance < 0 ? `Deuda ${formatMoney(-a.balance, e?.currency ?? 'HNL')}` : formatMoney(a.balance, e?.currency ?? 'HNL')}
                      </td>
                    ) : (
                      <td className={cn('td num font-semibold', a.balance < 0 && 'text-rose-600')}>{formatMoney(a.balance, e?.currency ?? 'HNL')}</td>
                    )}
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        {!a.archived && (
                          <Button
                            size="sm"
                            onClick={() => {
                              setReconciling(a);
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
          </table>
        </div>
      )}
      <AccountFormModal open={creating} onClose={() => setCreating(false)} />
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
                  () => api(`/api/accounts/${reconciling.id}/reconcile`, { body: { actualBalance: balance } }),
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
        {recIsCard ? (
          <p className="mb-3 text-sm text-slate-500">
            Deuda en sistema: <strong>{reconciling && formatMoney(Math.max(-reconciling.balance, 0), app.entityById.get(reconciling.entityId)?.currency ?? 'HNL')}</strong>.
            Ingresa la deuda que muestra el banco (p. ej. con intereses o comisiones); la diferencia se registra como ajuste. Para
            proyectar su pago, registra los intereses como un consumo.
          </p>
        ) : (
          <p className="mb-3 text-sm text-slate-500">
            Saldo en sistema: <strong>{reconciling && formatMoney(reconciling.balance, app.entityById.get(reconciling.entityId)?.currency ?? 'HNL')}</strong>. Ingresa
            el saldo que muestra el banco hoy; la diferencia se registra como ajuste.
          </p>
        )}
        <Field label={recIsCard ? 'Deuda según estado de cuenta' : 'Saldo real según banco'}>
          <input className="input text-right" inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------- Entidades
function EntitiesTab() {
  const app = useApp();
  const act = useAction();
  const [editing, setEditing] = useState<{ open: boolean; entity: EntityDto | null }>({ open: false, entity: null });
  const [token, setToken] = useState<{ token: string; endpoint: string; entity: string } | null>(null);
  const toast = useToast();

  async function rotate(e: EntityDto) {
    if (e.webhookEnabled && !confirm('Se generará un token nuevo y el anterior dejará de funcionar. ¿Continuar?')) return;
    try {
      const r = await api<{ token: string; endpoint: string }>(`/api/entities/${e.id}/webhook-token`, { method: 'POST' });
      setToken({ ...r, entity: e.name });
      emitDataChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error', 'error');
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-0 sm:p-0">
        <div className="flex items-center justify-between border-b border-slate-200 p-3 dark:border-slate-800">
          <p className="text-sm text-slate-500">Cada entidad tiene datos aislados, su moneda base y su umbral de alerta.</p>
          {app.isAdmin && (
            <Button variant="primary" onClick={() => setEditing({ open: true, entity: null })}>
              <Plus className="h-4 w-4" /> Nueva entidad
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 dark:bg-slate-800/50">
              <tr>
                <th className="th">Entidad</th>
                <th className="th">Moneda</th>
                <th className="th text-right">Umbral mínimo</th>
                <th className="th">Webhook</th>
                <th className="th text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {app.entities.map((e) => (
                <tr key={e.id} className={cn('border-t border-slate-100 dark:border-slate-800', e.archived && 'opacity-50')}>
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
                    {e.webhookEnabled ? <Badge tone="green">Activo · …{e.webhookTokenHint}</Badge> : <Badge>Inactivo</Badge>}
                  </td>
                  <td className="td">
                    {app.isAdmin && (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" title="Editar" onClick={() => setEditing({ open: true, entity: e })}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="ghost" title={e.webhookEnabled ? 'Rotar token webhook' : 'Generar webhook'} onClick={() => rotate(e)}>
                          <Webhook className="h-4 w-4" />
                        </Button>
                        {e.webhookEnabled && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Desactivar webhook"
                            onClick={() => confirm('¿Desactivar el webhook?') && act(() => api(`/api/entities/${e.id}/webhook-token`, { method: 'DELETE' }), 'Webhook desactivado')}
                          >
                            <KeyRound className="h-4 w-4 text-rose-500" />
                          </Button>
                        )}
                        {!e.isDefault && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title={e.archived ? 'Reactivar' : 'Archivar'}
                            onClick={() =>
                              act(
                                () => api(`/api/entities/${e.id}`, { method: 'PATCH', body: { archived: !e.archived } }),
                                e.archived ? 'Entidad reactivada' : 'Entidad archivada',
                              )
                            }
                          >
                            {e.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <EntityFormModal
        open={editing.open}
        entity={editing.entity}
        onClose={() => setEditing({ open: false, entity: null })}
        onSaved={() => app.refresh()}
      />

      <Modal open={Boolean(token)} onClose={() => setToken(null)} title={`Webhook de ${token?.entity ?? ''}`} wide>
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
}

function RatesTab() {
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
              Solo se usan para la vista consolidada (moneda de reporte: {app.settings.reportingCurrency}). Nunca alteran los saldos reales.
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
                  <td className="td">{r.effectiveDate}</td>
                  <td className="td text-right">
                    {app.isAdmin && (
                      <Button size="sm" variant="ghost" onClick={() => confirm('¿Eliminar esta tasa?') && act(() => api(`/api/rates/${r.id}`, { method: 'DELETE' }), 'Tasa eliminada')}>
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

function UsersTab() {
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
        <p className="text-sm text-slate-500">Los administradores ven todas las entidades; los usuarios solo las asignadas.</p>
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
              <th className="th">Entidades</th>
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
              <option value="USER">Usuario (entidades asignadas)</option>
              <option value="ADMIN">Administrador (todo)</option>
            </select>
          </Field>
          {role === 'USER' && (
            <div>
              <span className="label">Entidades con acceso</span>
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
function GeneralTab() {
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
