import { z } from 'zod';
import { isISODate } from './dates';
import { toCents } from './money';

export const isoDate = z.string().refine(isISODate, 'Fecha inválida (formato YYYY-MM-DD)');

/** Monto positivo en string o número -> centavos */
export const money = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return toCents(v);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Monto inválido' });
      return z.NEVER;
    }
  });

export const positiveMoney = money.refine((c) => c > 0, 'El monto debe ser mayor que cero');
export const nonNegativeMoney = money.refine((c) => c >= 0, 'El monto no puede ser negativo');

export const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Moneda inválida (código ISO de 3 letras)');

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color inválido (#RRGGBB)');

export const direction = z.enum(['IN', 'OUT']);
export const priority = z.enum(['FIXED', 'FLEXIBLE']);
export const frequency = z.enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY']);
export const id = z.string().min(1).max(64);
export const shortText = (max = 200) => z.string().trim().min(1, 'Requerido').max(max);
export const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
