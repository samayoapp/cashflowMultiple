import type { Prisma } from '@prisma/client';
import { badRequest } from './api';

type Db = Prisma.TransactionClient;

/**
 * Resuelve la contraparte de una partida: valida que un id pertenezca a la entidad,
 * o busca/crea por nombre dentro de la misma entidad (aislamiento estricto).
 */
export async function resolveCounterparty(
  db: Db,
  entityId: string,
  input: { counterpartyId?: string | null; counterpartyName?: string | null },
  type: 'CUSTOMER' | 'SUPPLIER',
): Promise<string | null | undefined> {
  if (input.counterpartyId) {
    const c = await db.counterparty.findUnique({ where: { id: input.counterpartyId } });
    if (!c || c.entityId !== entityId) throw badRequest('La contraparte no pertenece a la entidad');
    return c.id;
  }
  const name = input.counterpartyName?.trim();
  if (name) {
    const existing = await db.counterparty.findFirst({
      where: { entityId, name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) return existing.id;
    const created = await db.counterparty.create({ data: { entityId, name, type } });
    return created.id;
  }
  if (input.counterpartyId === null || input.counterpartyName === null) return null;
  return undefined;
}

export async function assertCategory(db: Db, entityId: string, categoryId: string | null | undefined) {
  if (!categoryId) return categoryId;
  const c = await db.category.findUnique({ where: { id: categoryId } });
  if (!c || c.entityId !== entityId) throw badRequest('La categoría no pertenece a la entidad');
  return c.id;
}
