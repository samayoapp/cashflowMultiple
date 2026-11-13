import { prisma } from '@/lib/server/db';
import { notFound, ok, route } from '@/lib/server/api';
import { requireAdmin } from '@/lib/server/auth';
import { generateWebhookToken } from '@/lib/server/tokens';

export const dynamic = 'force-dynamic';

/** Genera (o rota) el token del webhook. El token completo solo se devuelve aquí, una vez. */
export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  await requireAdmin();
  const entity = await prisma.entity.findUnique({ where: { id: params.id } });
  if (!entity) throw notFound('Entidad no encontrada');
  const { token, hash, hint } = generateWebhookToken();
  await prisma.entity.update({ where: { id: entity.id }, data: { webhookTokenHash: hash, webhookTokenHint: hint } });
  const base = process.env.APP_URL || new URL(req.url).origin;
  return ok({ token, endpoint: `${base.replace(/\/$/, '')}/api/webhooks/${token}`, hint });
});

/** Desactiva el webhook de la entidad. */
export const DELETE = route<{ params: { id: string } }>(async (_req, { params }) => {
  await requireAdmin();
  await prisma.entity.update({ where: { id: params.id }, data: { webhookTokenHash: null, webhookTokenHint: null } });
  return ok({ ok: true });
});
