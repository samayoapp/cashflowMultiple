'use client';

import { useState } from 'react';
import { useApp } from '@/components/AppContext';
import { EntityDot } from '@/components/AppShell';
import { Tabs } from '@/components/ui';
import { AccountsTab, UnitTab } from '@/components/settings-tabs';

type Tab = 'accounts' | 'unit';

/** Ajustes de la unidad de negocio seleccionada en el menú superior. */
export default function UnitSettingsPage() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('accounts');
  const unit = app.currentEntity;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            Ajustes
            {unit && (
              <span className="flex items-center gap-1.5 text-base font-normal text-slate-500">
                · <EntityDot color={unit.color} /> {unit.name}
              </span>
            )}
          </h1>
          <p className="text-sm text-slate-500">
            {unit ? 'Ajustes propios de esta unidad de negocio.' : 'Vista consolidada: elige una unidad de negocio en el menú superior para ver solo la suya.'}
          </p>
        </div>
        <Tabs<Tab>
          tabs={[
            { id: 'accounts', label: 'Cuentas y tarjetas' },
            { id: 'unit', label: 'Datos e integración' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'unit' && <UnitTab />}
    </div>
  );
}
