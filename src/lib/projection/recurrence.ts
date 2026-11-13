import { addDays, addMonths, toUTCDate, type ISODate } from '@/lib/dates';
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
  let i = 0;
  let current = rule.startDate;
  // Límite defensivo: 20 años de ocurrencias semanales
  while (current <= end && i < 1100) {
    if (current >= from) out.push(current);
    i += 1;
    current = nth(rule, i, anchorDay);
  }
  return out;
}

function nth(rule: EngineRule, i: number, anchorDay: number): ISODate {
  switch (rule.frequency) {
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
