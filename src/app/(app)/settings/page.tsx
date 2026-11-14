'use client';

import { useState } from 'react';
import { useApp } from '@/components/AppContext';
import { Tabs } from '@/components/ui';
import { EntitiesTab, GeneralTab, RatesTab, UsersTab } from '@/components/settings-tabs';

type Tab = 'entities' | 'rates' | 'users' | 'general';

/** Configuración de toda la aplicación (no depende de la unidad de negocio seleccionada). */
export default function SettingsPage() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('entities');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'entities', label: 'Unidades de negocio' },
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
        <div>
          <h1 className="text-xl font-semibold">Configuración</h1>
          <p className="text-sm text-slate-500">Ajustes de toda la aplicación.</p>
        </div>
        <Tabs<Tab> tabs={tabs} value={tab} onChange={setTab} />
      </div>
      {tab === 'entities' && <EntitiesTab />}
      {tab === 'rates' && <RatesTab />}
      {tab === 'users' && app.isAdmin && <UsersTab />}
      {tab === 'general' && app.isAdmin && <GeneralTab />}
    </div>
  );
}
