'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EntityDto } from '@/lib/server/dto';
import { api, CONTEXT_CHANGED_EVENT, DATA_CHANGED_EVENT, setCookie } from '@/lib/client/api';

export interface ContextPayload {
  user: { id: string; name: string; email: string; role: 'ADMIN' | 'USER' };
  entities: EntityDto[];
  ctx: string;
  whatIf: boolean;
  settings: { reportingCurrency: string; timezone: string };
  today: string;
  pendingStaging: number;
}

interface AppState extends ContextPayload {
  isAdmin: boolean;
  activeEntities: EntityDto[];
  entityById: Map<string, EntityDto>;
  currentEntity: EntityDto | null;
  /** Moneda en que se presentan los montos del contexto actual */
  currency: string;
  setCtx: (ctx: string) => void;
  setWhatIf: (v: boolean) => void;
  refresh: () => Promise<void>;
  /** query string con ctx y whatIf para las APIs */
  qs: string;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp fuera de AppProvider');
  return v;
}

export function AppProvider({ initial, children }: { initial: ContextPayload; children: ReactNode }) {
  const [state, setState] = useState<ContextPayload>(initial);

  const refresh = useCallback(async () => {
    const next = await api<ContextPayload>(`/api/context?ctx=${encodeURIComponent(state.ctx)}`);
    setState((s) => ({ ...next, whatIf: s.whatIf }));
  }, [state.ctx]);

  useEffect(() => {
    const h = () => void refresh().catch(() => {});
    window.addEventListener(DATA_CHANGED_EVENT, h);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, h);
  }, [refresh]);

  const setCtx = useCallback((ctx: string) => {
    setCookie('cf_ctx', ctx);
    setState((s) => ({ ...s, ctx }));
    window.dispatchEvent(new CustomEvent(CONTEXT_CHANGED_EVENT));
  }, []);

  const setWhatIf = useCallback((v: boolean) => {
    setCookie('cf_whatif', v ? '1' : '0');
    setState((s) => ({ ...s, whatIf: v }));
  }, []);

  const value = useMemo<AppState>(() => {
    const entityById = new Map(state.entities.map((e) => [e.id, e]));
    const currentEntity = state.ctx === 'all' ? null : (entityById.get(state.ctx) ?? null);
    return {
      ...state,
      isAdmin: state.user.role === 'ADMIN',
      activeEntities: state.entities.filter((e) => !e.archived),
      entityById,
      currentEntity,
      currency: currentEntity?.currency ?? state.settings.reportingCurrency,
      setCtx,
      setWhatIf,
      refresh,
      qs: `ctx=${encodeURIComponent(state.ctx)}&whatIf=${state.whatIf ? 1 : 0}`,
    };
  }, [state, setCtx, setWhatIf, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
