import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { conflict, ok, readJson, route } from '@/lib/server/api';
import { hashPassword, requireAdmin } from '@/lib/server/auth';
import { id, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const schema = z.object({
  name: shortText(120).optional(),
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres').max(200).optional(),
  role: z.enum(['ADMIN', 'USER']).optional(),
  active: z.boolean().optional(),
  entityIds: z.array(id).optional(),
});

export const PATCH = route<{ params: { id: string } }>(async (req, { params }) => {
  const admin = await requireAdmin();
  const data = schema.parse(await readJson(req));
  if (params.id === admin.id && (data.active === false || data.role === 'USER')) {
    throw conflict('No puedes desactivarte ni quitarte el rol de administrador a ti mismo');
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: params.id },
      data: {
        name: data.name,
        role: data.role,
        active: data.active,
        passwordHash: data.password ? await hashPassword(data.password) : undefined,
      },
    });
    if (data.entityIds) {
      await tx.userEntityAccess.deleteMany({ where: { userId: params.id } });
      await tx.userEntityAccess.createMany({
        data: data.entityIds.map((entityId) => ({ userId: params.id, entityId })),
        skipDuplicates: true,
      });
    }
  });
  return ok({ ok: true });
});
