'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { api, emitDataChanged, useApi } from '@/lib/client/api';
import { Button, Field } from './ui';

export interface CategoryOption {
  id: string;
  name: string;
  direction: 'IN' | 'OUT';
  color: string | null;
}

const NEW = '__new__';

/**
 * Selector de categoría de una unidad, filtrado por tipo (gasto/ingreso), con la opción
 * "+ Nueva categoría…" para crearla sin salir del formulario.
 */
export function CategorySelect({
  entityId,
  direction,
  value,
  onChange,
  label,
}: {
  entityId: string | null | undefined;
  direction: 'IN' | 'OUT';
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  const catalog = useApi<{ categories: (CategoryOption & { entityId: string })[] }>(entityId ? `/api/catalog?ctx=${entityId}` : null);
  const options = (catalog.data?.categories ?? []).filter((c) => c.direction === direction && c.entityId === entityId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!entityId || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const c = await api<{ id: string }>('/api/categories', { body: { entityId, name: name.trim(), direction } });
      await catalog.reload();
      emitDataChanged();
      onChange(c.id);
      setCreating(false);
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setSaving(false);
    }
  }

  const fieldLabel = label ?? (direction === 'OUT' ? 'Categoría del gasto' : 'Categoría del ingreso');

  if (creating) {
    return (
      <Field label={fieldLabel} hint={error ?? undefined}>
        <div className="flex gap-1">
          <input
            className="input"
            autoFocus
            placeholder="Nombre de la nueva categoría"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setCreating(false);
              }
            }}
          />
          <Button type="button" size="sm" variant="primary" title="Crear" onClick={create} loading={saving} disabled={!name.trim()}>
            <Check className="h-4 w-4" />
          </Button>
          <Button type="button" size="sm" title="Volver" onClick={() => setCreating(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </Field>
    );
  }

  return (
    <Field label={fieldLabel}>
      <select
        className="input"
        value={value}
        disabled={!entityId}
        onChange={(e) => {
          if (e.target.value === NEW) {
            setCreating(true);
            setError(null);
          } else onChange(e.target.value);
        }}
      >
        <option value="">Sin categoría</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        <option value={NEW}>+ Nueva categoría…</option>
      </select>
    </Field>
  );
}

/** Etiqueta de categoría para tablas (punto de color + nombre). */
export function CategoryTag({ category }: { category: { name: string; color?: string | null } | null | undefined }) {
  if (!category) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: category.color ?? '#94a3b8' }} />
      {category.name}
    </span>
  );
}
