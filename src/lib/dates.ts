/**
 * Fechas de tesorería como strings ISO "YYYY-MM-DD" (sin hora ni zona).
 * Toda la aritmética se hace en UTC para evitar saltos por horario.
 */
export type ISODate = string;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(v: unknown): v is ISODate {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function toUTCDate(iso: ISODate): Date {
  return new Date(iso + 'T00:00:00Z');
}

export function fromUTCDate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

/** Convierte un Date de Prisma (columna @db.Date) a ISODate. */
export function dbDateToISO(d: Date | null | undefined): ISODate | null {
  return d ? fromUTCDate(d) : null;
}

export function addDays(iso: ISODate, days: number): ISODate {
  const d = toUTCDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTCDate(d);
}

/** Suma meses conservando el día ancla (se ajusta al último día del mes si no existe). */
export function addMonths(iso: ISODate, months: number, anchorDay?: number): ISODate {
  const d = toUTCDate(iso);
  const day = anchorDay ?? d.getUTCDate();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fromUTCDate(new Date(Date.UTC(y, m, Math.min(day, lastDay))));
}

export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTCDate(a).getTime() - toUTCDate(b).getTime()) / 86_400_000);
}

/** Lunes de la semana que contiene la fecha. */
export function startOfWeek(iso: ISODate): ISODate {
  const dow = toUTCDate(iso).getUTCDay(); // 0 = domingo
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(iso, offset);
}

/** "Hoy" en la zona horaria de la operación (por defecto Honduras). */
export function todayInTz(timeZone = 'America/Tegucigalpa', now: Date = new Date()): ISODate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts; // en-CA => YYYY-MM-DD
}

export function formatShortDate(iso: ISODate): string {
  const d = toUTCDate(iso);
  return d.toLocaleDateString('es-HN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

export function formatLongDate(iso: ISODate): string {
  const d = toUTCDate(iso);
  return d.toLocaleDateString('es-HN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
