import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { notFound, ok, readJson, route } from '@/lib/server/api';
import { requireUser } from '@/lib/server/auth';
import { assertEntityAccess } from '@/lib/server/scope';
import { registerPayment } from '@/lib/server/services';
import { getSettings } from '@/lib/server/projection-data';
import { obligationDto, obligationInclude } from '@/lib/server/dto';
import { cents } from '@/lib/server/serialize';
import { id, isoDate, optionalText, positiveMoney } from '@/lib/validation';
import { todayInTz } from '@/lib/dates';

export const dynamic = 'force-dynamic';

const schema = z.object({
  accountId: id,
  /** Si se omite, se liquida el saldo pendiente completo ("Marcar como pagado/cobrado"). */
  amount: positiveMoney.optional(),
  date: isoDate.optional(),
  note: optionalText(300),
  /** Solo al pagar con tarjeta de crédito: cuotas (1..36). */
  installments: z.coerce.number().int().min(1).max(36).optional(),
  /** Cierra la partida con este monto real aunque difiera del pendiente (se conserva el proyectado). */
  settle: z.boolean().optional(),
  /** Con `settle` en una ocurrencia recurrente: el monto real se usa también para las próximas. */
  updateRule: z.boolean().optional(),
});

export const POST = route<{ params: { id: string } }>(async (req, { params }) => {
  const user = await requireUser();
  const o = await prisma.obligation.findUnique({ where: { id: params.id }, include: { payments: true } });
  if (!o) throw notFound('Partida no encontrada');
  await assertEntityAccess(user, o.entityId);
  const data = schema.parse(await readJson(req));
  const settings = await getSettings();
  const remaining = cents(o.amount) - o.payments.reduce((s, p) => s + cents(p.amount), 0);

  await registerPayment({
    obligationId: o.id,
    accountId: data.accountId,
    amount: data.amount ?? remaining,
    date: data.date ?? todayInTz(settings.timezone),
    note: data.note,
    installments: data.installments,
    settle: data.settle,
    updateRule: data.updateRule,
    userId: user.id,
  });
  const updated = await prisma.obligation.findUniqueOrThrow({ where: { id: o.id }, include: obligationInclude });
  return ok(obligationDto(updated), { status: 201 });
});
