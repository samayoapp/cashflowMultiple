'use client';

import { useState } from 'react';
import { Tabs } from '@/components/ui';
import { AccountsTab } from '@/components/settings-tabs';
import { TransfersTab } from '@/components/TransfersTab';
import { InterUnitStatement } from '@/components/InterUnitStatement';

type Tab = 'accounts' | 'transfers' | 'interunit';

/** Caja y Bancos: cuentas con su saldo real, transferencias y estado de cuenta entre unidades. */
export default function CashPage() {
  const [tab, setTab] = useState<Tab>('accounts');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Caja y Bancos</h1>
          <p className="text-sm text-slate-500">Cuentas y tarjetas con su saldo real, transferencias y saldos entre unidades de negocio.</p>
        </div>
        <Tabs<Tab>
          tabs={[
            { id: 'accounts', label: 'Cuentas' },
            { id: 'transfers', label: 'Transferencias' },
            { id: 'interunit', label: 'Entre unidades' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'transfers' && <TransfersTab />}
      {tab === 'interunit' && <InterUnitStatement />}
    </div>
  );
}
