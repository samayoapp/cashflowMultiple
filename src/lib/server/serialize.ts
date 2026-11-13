import type { Prisma } from '@prisma/client';
import { fromUTCDate, toUTCDate, type ISODate } from '@/lib/dates';
import { centsToDecimalString, toCents, type Cents } from '@/lib/money';

/** ISODate -> Date para columnas @db.Date */
export const dbDate = (iso: ISODate) => toUTCDate(iso);
export const isoOf = (d: Date) => fromUTCDate(d);
export const isoOrNull = (d: Date | null | undefined) => (d ? fromUTCDate(d) : null);

/** Centavos -> string decimal para Prisma */
export const dec = (c: Cents) => centsToDecimalString(c);

export const cents = (d: Prisma.Decimal | null | undefined): Cents => (d ? toCents(d.toString()) : 0);
