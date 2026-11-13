import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/server/db';
import { ApiError, readJson, route } from '@/lib/server/api';
import { hashToken } from '@/lib/server/tokens';
import { dbDate, dec } from '@/lib/server/serialize';
import { isISODate } from '@/lib/dates';
import { parseAmountWithCurrency } from '@/lib/projection/fx';

export const dynamic = 'force-dynamic';

/**
 * Endpoint público por entidad para CRM / n8n.
 * NUNCA afecta el flujo directamente: todo llega a la Bandeja de Conciliación como PENDIENTE.
 *
 * POST /api/webhooks/<token>
 * {
 *   "type": "receivable" | "payable" | "IN" | "OUT",
 *   "description": "Factura 001-123",
 *   "amount": "15000.00",
 *   "dueDate": "2026-12-01",
 *   "expectedDate": "2026-12-15",      (opcional)
 *   "counterparty": "Cliente S.A.",    (opcional)
 *   "externalId": "crm-proposal-991",  (opcional; evita duplicados)
 *   "source": "crm-publimatec",        (opcional)
 *   "currency": "USD" | "HNL",         (opcional; también se detecta en "amount": "$ 45.00" / "L. 300")
 *   "card": "Visa Empresarial"         (opcional; pista para aprobarlo como consumo con tarjeta)
 * }
 */
const schema = z
  .object({
    type: z.string().max(20).optional(),
    direction: z.string().max(20).optional(),
    description: z.string().max(300).optional(),
    amount: z.union([z.string().max(30), z.number()]).optional(),
    dueDate: z.string().max(10).optional(),
    expectedDate: z.string().max(10).optional(),
    counterparty: z.string().max(160).optional(),
    externalId: z.string().max(120).optional(),
    source: z.string().max(60).optional(),
    currency: z.string().max(10).optional(),
    card: z.string().max(120).optional(),
    cardName: z.string().max(120).optional(),
  })
  .passthrough();

function parseDirection(v?: string): 'IN' | 'OUT' | null {
  const s = v?.trim().toLowerCase();
  if (!s) return null;
  if (['in', 'receivable', 'cxc', 'income', 'ingreso', 'cobro'].includes(s)) return 'IN';
  if (['out', 'payable', 'cxp', 'expense', 'egreso', 'pago'].includes(s)) return 'OUT';
  return null;
}

/** Moneda explícita: "USD" | "$" | "dólares" / "HNL" | "L" | "L." | "lempiras". */
function parseCurrency(v?: string): 'HNL' | 'USD' | null {
  const s = v?.trim().toLowerCase().replace(/\.$/, '');
  if (!s) return null;
  if (['usd', '$', 'us$', 'dolar', 'dólar', 'dolares', 'dólares'].includes(s)) return 'USD';
  if (['hnl', 'l', 'lps', 'lempira', 'lempiras'].includes(s)) return 'HNL';
  return null;
}

export const POST = route<{ params: { token: string } }>(async (req, { params }) => {
  const token = params.token;
  if (!token || token.length > 200) throw new ApiError(404, 'No encontrado');
  const entity = await prisma.entity.findUnique({ where: { webhookTokenHash: hashToken(token) } });
  if (!entity || entity.archivedAt) throw new ApiError(404, 'No encontrado');

  const raw = await readJson(req, 64 * 1024);
  const body = schema.parse(raw);
  // Monto y moneda: "$ 45.00", "L. 3,000", "80 USD"… La moneda explícita tiene prioridad; luego la del monto
  // y, si no hay, la que aparezca en la descripción.
  const parsed = parseAmountWithCurrency(body.amount);
  const amount = parsed?.cents ?? null;
  const currency =
    parseCurrency(body.currency) ?? parsed?.currency ?? (body.description ? parseAmountWithCurrency(body.description)?.currency ?? null : null);
  const cardHint = (body.card ?? body.cardName)?.trim() || null;
  const source = body.source?.trim() || 'webhook';
  const externalId = body.externalId?.trim() || null;

  if (externalId) {
    const existing = await prisma.stagingItem.findFirst({ where: { entityId: entity.id, source, externalId } });
    if (existing) return NextResponse.json({ id: existing.id, status: existing.status, duplicate: true });
  }

  try {
    const item = await prisma.stagingItem.create({
      data: {
        entityId: entity.id,
        source,
        externalId,
        direction: parseDirection(body.type ?? body.direction),
        description: body.description?.trim() || null,
        amount: amount !== null ? dec(amount) : null,
        dueDate: body.dueDate && isISODate(body.dueDate) ? dbDate(body.dueDate) : null,
        expectedDate: body.expectedDate && isISODate(body.expectedDate) ? dbDate(body.expectedDate) : null,
        counterparty: body.counterparty?.trim() || null,
        currency,
        cardHint,
        payload: raw as Prisma.InputJsonValue,
      },
    });
    return NextResponse.json({ id: item.id, status: item.status }, { status: 202 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && externalId) {
      const existing = await prisma.stagingItem.findFirst({ where: { entityId: entity.id, source, externalId } });
      if (existing) return NextResponse.json({ id: existing.id, status: existing.status, duplicate: true });
    }
    throw e;
  }
});
