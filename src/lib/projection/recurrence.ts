import { addDays, addMonths, diffDays, toUTCDate, type ISODate } from '@/lib/dates';
import type { EngineRule } from './types';

/**
 * Fechas de ocurrencia de una regla recurrente dentro de [from, to] (inclusive).
 * Las mensuales/anuales conservan el día ancla de startDate (31 -> último día del mes).
 */
export function expandRule(rule: EngineRule, from: ISODate, to: ISODate): ISODate[] {
  if (!rule.active) return [];
  const end = rule.endDate && rule.endDate < to ? rule.endDate : to;
  if (end < from || rule.startDate > end) return [];

  const anchorDay = toUTCDate(rule.startDate).getUTCDate();
  const out: ISODate[] = [];
  // Frecuencias de paso fijo: se salta directo a la primera ocurrencia del rango
  // (una regla diaria de hace años no recorre todas sus fechas viejas).
  const step = STEP_DAYS[rule.frequency];
  let i = step && from > rule.startDate ? Math.ceil(diffDays(from, rule.startDate) / step) : 0;
  let current = nth(rule, i, anchorDay);
  // Límite defensivo de ocurrencias devueltas (más de 3 años de diarias)
  while (current <= end && out.length < 1200) {
    if (current >= from) out.push(current);
    i += 1;
    current = nth(rule, i, anchorDay);
  }
  return out;
}

/** Días entre ocurrencias de las frecuencias de paso fijo. */
const STEP_DAYS: Partial<Record<EngineRule['frequency'], number>> = { DAILY: 1, WEEKLY: 7, BIWEEKLY: 14 };

function nth(rule: EngineRule, i: number, anchorDay: number): ISODate {
  switch (rule.frequency) {
    case 'DAILY':
      return addDays(rule.startDate, i);
    case 'WEEKLY':
      return addDays(rule.startDate, 7 * i);
    case 'BIWEEKLY':
      return addDays(rule.startDate, 14 * i);
    case 'MONTHLY':
      return addMonths(rule.startDate, i, anchorDay);
    case 'YEARLY':
      return addMonths(rule.startDate, 12 * i, anchorDay);
  }
}

/** Clave única de una ocurrencia: regla + fecha original. */
export const occurrenceKey = (ruleId: string, date: ISODate) => `${ruleId}|${date}`;

/**
 * Ocurrencias virtuales (aún no materializadas como Obligation) de un conjunto de reglas
 * dentro de [from, to]. `materialized` contiene claves `occurrenceKey` de las ocurrencias
 * que ya existen como CxC/CxP (en cualquier estado) y por lo tanto reemplazan a la virtual.
 * Resultado ordenado por fecha y luego por descripción.
 */
export function pendingOccurrences<R extends EngineRule>(
  rules: readonly R[],
  materialized: ReadonlySet<string>,
  from: ISODate,
  to: ISODate,
): { rule: R; date: ISODate }[] {
  const out: { rule: R; date: ISODate }[] = [];
  for (const rule of rules) {
    for (const date of expandRule(rule, from, to)) {
      if (!materialized.has(occurrenceKey(rule.id, date))) out.push({ rule, date });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? a.rule.description.localeCompare(b.rule.description) : a.date < b.date ? -1 : 1));
}
