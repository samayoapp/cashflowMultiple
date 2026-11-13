import { cookies } from 'next/headers';
import { prisma } from './db';
import { badRequest, forbidden, notFound } from './api';
import type { CurrentUser } from './auth';

/**
 * Aislamiento estricto por entidad. TODA lectura/escritura de datos operativos
 * debe pasar por estas funciones.
 */
export const CONTEXT_COOKIE = 'cf_ctx';
export const WHATIF_COOKIE = 'cf_whatif';
export const ALL_ENTITIES = 'all';

/** Entidades a las que el usuario tiene acceso (incluye archivadas si se pide). */
export async function getAllowedEntityIds(user: CurrentUser, opts: { includeArchived?: boolean } = {}) {
  const rows = await prisma.entity.findMany({
    where: {
      ...(user.role === 'ADMIN' ? {} : { id: { in: user.entityIds } }),
      ...(opts.includeArchived ? {} : { archivedAt: null }),
    },
    select: { id: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => r.id);
}

export async function assertEntityAccess(user: CurrentUser, entityId: string) {
  if (!entityId) throw badRequest('Falta la entidad');
  const exists = await prisma.entity.findUnique({ where: { id: entityId }, select: { id: true } });
  if (!exists) throw notFound('Entidad no encontrada');
  if (user.role !== 'ADMIN' && !user.entityIds.includes(entityId)) throw forbidden();
}

export interface ResolvedContext {
  consolidated: boolean;
  entityIds: string[];
  /** 'all' o el id de la entidad seleccionada */
  ctx: string;
}

/**
 * Resuelve el contexto (Consolidado o una entidad) desde ?ctx= o la cookie.
 * Si el contexto pedido no es accesible, responde 403 (no lo sustituye en silencio).
 */
export async function resolveContext(user: CurrentUser, explicit?: string | null): Promise<ResolvedContext> {
  const requested = explicit || cookies().get(CONTEXT_COOKIE)?.value || ALL_ENTITIES;
  const allowed = await getAllowedEntityIds(user);
  if (requested === ALL_ENTITIES) {
    return { consolidated: true, entityIds: allowed, ctx: ALL_ENTITIES };
  }
  if (!allowed.includes(requested)) {
    // Puede ser una entidad archivada a la que sí tiene acceso
    const withArchived = await getAllowedEntityIds(user, { includeArchived: true });
    if (!withArchived.includes(requested)) {
      if (!explicit) return { consolidated: true, entityIds: allowed, ctx: ALL_ENTITIES };
      throw forbidden();
    }
  }
  return { consolidated: false, entityIds: [requested], ctx: requested };
}

export function resolveWhatIf(explicit?: string | null): boolean {
  const v = explicit ?? cookies().get(WHATIF_COOKIE)?.value;
  return v === '1' || v === 'true';
}
