import type { Prisma } from '@prisma/client';
import { badRequest, conflict } from './api';

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
    if (!c || c.entityId !== entityId) throw badRequest('La contraparte no pertenece a la unidad de negocio');
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
  if (!c || c.entityId !== entityId) throw badRequest('La categoría no pertenece a la unidad de negocio');
  return c.id;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Crea una categoría validando que no exista otra igual (mismo nombre y tipo) en la unidad. */
export async function createCategory(
  db: Db,
  args: { entityId: string; name: string; direction: 'IN' | 'OUT'; color?: string | null },
) {
  const name = args.name.trim();
  if (!name) throw badRequest('El nombre no puede quedar vacío');
  if (args.color && !HEX.test(args.color)) throw badRequest('Color inválido');
  await assertCategoryNameFree(db, args.entityId, args.direction, name);
  return db.category.create({ data: { entityId: args.entityId, name, direction: args.direction, color: args.color ?? null } });
}

export async function assertCategoryNameFree(db: Db, entityId: string, direction: 'IN' | 'OUT', name: string, exceptId?: string) {
  const dup = await db.category.findFirst({
    where: { entityId, direction, name: { equals: name.trim(), mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  if (dup) throw conflict(`Ya existe la categoría "${dup.name}" en esta unidad`);
}

export { HEX as CATEGORY_COLOR };
