import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { ok, readJson, route } from '@/lib/server/api';
import { hashPassword, requireAdmin } from '@/lib/server/auth';
import { id, shortText } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  await requireAdmin();
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    include: { entityAccess: { select: { entityId: true } } },
  });
  return ok(
    users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      active: u.active,
      entityIds: u.entityAccess.map((a) => a.entityId),
    })),
  );
});

const schema = z.object({
  email: z.string().trim().toLowerCase().email('Correo inválido').max(200),
  name: shortText(120),
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres').max(200),
  role: z.enum(['ADMIN', 'USER']).default('USER'),
  entityIds: z.array(id).default([]),
});

export const POST = route(async (req) => {
  await requireAdmin();
  const data = schema.parse(await readJson(req));
  const user = await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      passwordHash: await hashPassword(data.password),
      role: data.role,
      entityAccess: { create: data.entityIds.map((entityId) => ({ entityId })) },
    },
  });
  return ok({ id: user.id }, { status: 201 });
});
