import type { Account } from '@prisma/client';
import { prisma } from './db';
import { dbDate, isoOf } from './serialize';
import { getSettings } from './projection-data';
import { todayInTz, type ISODate } from '@/lib/dates';
import { effectiveSellRate, rate4, rateToString, type Rate4 } from '@/lib/projection/fx';

/**
 * Servicio de tipo de cambio USD→HNL.
 *  - Fuente en línea con respaldo (dos APIs públicas + espejo) y, sin conexión, la última tasa guardada.
 *  - Venta efectiva = tasa oficial + spread bancario configurable (por defecto L. 0.18).
 *  - Una tasa MANUAL del día nunca se sobrescribe por la sincronización automática.
 */
const PAIR = { from: 'USD', to: 'HNL' } as const;
const DEFAULT_SPREAD = 1800; // 0.1800

interface OnlineSource {
  name: string;
  url: string;
  pick: (json: unknown) => number | undefined;
}

const SOURCES: OnlineSource[] = [
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    pick: (j) => (j as { result?: string; rates?: Record<string, number> }).result === 'success' ? (j as { rates: Record<string, number> }).rates.HNL : undefined,
  },
  {
    name: 'currency-api (jsdelivr)',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    pick: (j) => (j as { usd?: Record<string, number> }).usd?.hnl,
  },
  {
    name: 'currency-api (pages.dev)',
    url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    pick: (j) => (j as { usd?: Record<string, number> }).usd?.hnl,
  },
];

export interface CurrentFx {
  date: ISODate;
  officialSellRate: string;
  officialBuyRate: string | null;
  bankSpread: string;
  effectiveSellRate: string;
  /** Tasa efectiva en diezmilésimas, lista para el motor. */
  effective4: Rate4;
  source: string;
  updatedAt: string;
  /** true si no es la tasa de hoy (se usa la última conocida). */
  stale: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

/** Consulta las fuentes en línea en orden; devuelve la primera tasa válida. */
export async function fetchOnlineUsdHnl(sources: OnlineSource[] = SOURCES): Promise<{ rate: number; source: string }> {
  const errors: string[] = [];
  for (const s of sources) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(s.url, { signal: ctrl.signal, cache: 'no-store', headers: { accept: 'application/json' } });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const v = s.pick(await res.json());
      // Verificación de rango para descartar respuestas absurdas
      if (typeof v !== 'number' || !(v > 15 && v < 40)) throw new Error(`tasa fuera de rango: ${v}`);
      return { rate: v, source: s.name };
    } catch (e) {
      errors.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`Sin conexión con las fuentes de tipo de cambio (${errors.join(' | ')})`);
}

async function spread4(): Promise<Rate4> {
  const s = await prisma.appSetting.findUnique({ where: { id: 1 }, select: { fxBankSpread: true } });
  return s ? rate4(s.fxBankSpread) : DEFAULT_SPREAD;
}

async function upsertDay(date: ISODate, official4: Rate4, spread: Rate4, source: string, effectiveOverride?: Rate4) {
  const effective = effectiveOverride ?? effectiveSellRate(official4, spread);
  const fields = {
    rate: rateToString(official4),
    officialBuyRate: rateToString(official4),
    officialSellRate: rateToString(official4),
    bankSpread: rateToString(spread),
    effectiveSellRate: rateToString(effective),
    source,
  };
  return prisma.exchangeRate.upsert({
    where: { fromCurrency_toCurrency_effectiveDate: { fromCurrency: PAIR.from, toCurrency: PAIR.to, effectiveDate: dbDate(date) } },
    update: fields,
    create: { fromCurrency: PAIR.from, toCurrency: PAIR.to, effectiveDate: dbDate(date), ...fields },
  });
}

/**
 * Sincroniza la tasa de hoy desde internet.
 * Sin `force`, respeta una tasa MANUAL del día. Si todas las fuentes fallan, deja registrado el error
 * y la app sigue usando la última tasa válida guardada.
 */
export async function syncToday(opts: { force?: boolean } = {}) {
  const settings = await getSettings();
  const today = todayInTz(settings.timezone);
  const existing = await prisma.exchangeRate.findUnique({
    where: { fromCurrency_toCurrency_effectiveDate: { fromCurrency: PAIR.from, toCurrency: PAIR.to, effectiveDate: dbDate(today) } },
  });
  if (existing?.source === 'MANUAL' && !opts.force) {
    return { updated: false, reason: 'Hoy ya hay una tasa manual (usa forzar para reemplazarla)', current: await getCurrentFx() };
  }
  try {
    const online = await fetchOnlineUsdHnl();
    await upsertDay(today, rate4(online.rate), await spread4(), 'API');
    await prisma.appSetting.update({ where: { id: 1 }, data: { fxLastSyncAt: new Date(), fxLastSyncError: null } });
    return { updated: true, source: online.source, current: await getCurrentFx() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.appSetting.update({ where: { id: 1 }, data: { fxLastSyncAt: new Date(), fxLastSyncError: msg.slice(0, 500) } });
    return { updated: false, reason: msg, current: await getCurrentFx() };
  }
}

/** Sincroniza solo si todavía no existe la tasa de hoy (arranque del servidor / tarea diaria). */
export async function syncIfMissing() {
  const settings = await getSettings();
  const today = todayInTz(settings.timezone);
  const exists = await prisma.exchangeRate.findUnique({
    where: { fromCurrency_toCurrency_effectiveDate: { fromCurrency: PAIR.from, toCurrency: PAIR.to, effectiveDate: dbDate(today) } },
    select: { id: true },
  });
  if (exists) return { updated: false, reason: 'La tasa de hoy ya existe' };
  return syncToday();
}

/**
 * Ajuste manual (solo ADMIN):
 *  - bankSpread: cambia el spread global y recalcula la venta efectiva de hoy.
 *  - officialSellRate y/o effectiveSellRate: fija la tasa del día como MANUAL.
 */
export async function overrideToday(args: { officialSellRate?: string; bankSpread?: string; effectiveSellRate?: string }) {
  const settings = await getSettings();
  const today = todayInTz(settings.timezone);
  let spread = await spread4();
  if (args.bankSpread !== undefined) {
    spread = rate4(args.bankSpread);
    await prisma.appSetting.update({ where: { id: 1 }, data: { fxBankSpread: rateToString(spread) } });
  }
  const current = await getCurrentFx();
  const official = args.officialSellRate ? rate4(args.officialSellRate) : current ? rate4(current.officialSellRate) : null;
  if (official === null) throw new Error('No hay tasa oficial: sincroniza o ingrésala manualmente');
  const manual = Boolean(args.officialSellRate || args.effectiveSellRate);
  const todayRow = await prisma.exchangeRate.findUnique({
    where: { fromCurrency_toCurrency_effectiveDate: { fromCurrency: PAIR.from, toCurrency: PAIR.to, effectiveDate: dbDate(today) } },
  });
  const source = manual ? 'MANUAL' : (todayRow?.source ?? current?.source ?? 'MANUAL');
  await upsertDay(today, official, spread, source, args.effectiveSellRate ? rate4(args.effectiveSellRate) : undefined);
  return getCurrentFx();
}

/** Tasa vigente: la última fila USD→HNL con fecha <= hoy. */
export async function getCurrentFx(): Promise<CurrentFx | null> {
  const settings = await prisma.appSetting.findUnique({ where: { id: 1 } });
  const today = todayInTz(settings?.timezone ?? 'America/Tegucigalpa');
  const row = await prisma.exchangeRate.findFirst({
    where: { fromCurrency: PAIR.from, toCurrency: PAIR.to, effectiveDate: { lte: dbDate(today) } },
    orderBy: { effectiveDate: 'desc' },
  });
  if (!row) return null;
  const spread = row.bankSpread ? rate4(row.bankSpread) : settings ? rate4(settings.fxBankSpread) : DEFAULT_SPREAD;
  const official = rate4(row.officialSellRate ?? row.rate);
  const effective = row.effectiveSellRate ? rate4(row.effectiveSellRate) : effectiveSellRate(official, spread);
  return {
    date: isoOf(row.effectiveDate),
    officialSellRate: rateToString(official),
    officialBuyRate: row.officialBuyRate ? rateToString(rate4(row.officialBuyRate)) : null,
    bankSpread: rateToString(spread),
    effectiveSellRate: rateToString(effective),
    effective4: effective,
    source: row.source ?? 'MANUAL',
    updatedAt: row.updatedAt.toISOString(),
    stale: isoOf(row.effectiveDate) < today,
    lastSyncAt: settings?.fxLastSyncAt?.toISOString() ?? null,
    lastSyncError: settings?.fxLastSyncError ?? null,
  };
}

/** Tasa de venta que usa una tarjeta: la propia (si la tiene) o la efectiva global. */
export function cardRateFor(card: Pick<Account, 'customSellRate'>, fx: CurrentFx | null): Rate4 | null {
  if (card.customSellRate) return rate4(card.customSellRate);
  return fx?.effective4 ?? null;
}

// ---------------------------------------------------------------- Tarea diaria
const SYNC_HOUR_UTC = 14; // 08:30 America/Tegucigalpa (UTC-6, sin horario de verano)
const SYNC_MINUTE = 30;

export function msUntilNextSync(now: Date = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SYNC_HOUR_UTC, SYNC_MINUTE, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

let started = false;

/** Arranca la sincronización: al iniciar (si falta la tasa de hoy) y todos los días a las 08:30 hora de Honduras. */
export function startFxScheduler() {
  if (started) return;
  started = true;
  const run = async (label: string) => {
    try {
      const r = await syncIfMissing();
      console.log(`[fx] ${label}: ${r.updated && 'current' in r ? `tasa actualizada (${r.current?.effectiveSellRate})` : r.reason}`);
    } catch (e) {
      console.error(`[fx] ${label}: error`, e instanceof Error ? e.message : e);
    }
  };
  const schedule = () => {
    const ms = msUntilNextSync();
    console.log(`[fx] próxima sincronización en ${Math.round(ms / 60000)} min (08:30 America/Tegucigalpa)`);
    setTimeout(async () => {
      await run('sincronización diaria');
      schedule();
    }, ms).unref?.();
  };
  setTimeout(() => void run('arranque'), 10_000).unref?.();
  schedule();
}
