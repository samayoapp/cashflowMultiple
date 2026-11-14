/**
 * Datos de DEMOSTRACIÓN (npm run seed:demo). NO destructivo: nunca borra nada.
 * - Si la entidad demo ya existe, no hace nada.
 * - Solo carga datos en la Entidad Base si todavía no tiene cuentas.
 * Crea: segunda entidad en USD, cuentas, CxC/CxP (con vencidas y abonos),
 * recurrencias, una transferencia inter-entidad, tasas HNL/USD/EUR y partidas hipotéticas.
 * - Tarjeta demo "Visa Empresarial (demo)" en la Entidad Base (solo si no existe):
 *   bimoneda (L. / $), consumos categorizados, una compra a 6 cuotas, un consumo en USD a 3 cuotas,
 *   deuda inicial y un pago parcial. Sincroniza el tipo de cambio del día si falta.
 */
import { PrismaClient, type Direction, type Priority } from '@prisma/client';
import { addDays, todayInTz } from '../src/lib/dates';
import { centsToDecimalString } from '../src/lib/money';
import { createTransfer, registerPayment } from '../src/lib/server/services';
import { createCardCharge, createOpeningDebt, payCreditCard } from '../src/lib/server/cards';
import { getCurrentFx, syncIfMissing } from '../src/lib/server/fx';

const prisma = new PrismaClient();
const DEMO_NAME = 'Publimatec Digital (demo)';
const d = (iso: string) => new Date(iso + 'T00:00:00Z');
const money = (units: number) => centsToDecimalString(Math.round(units * 100));

async function main() {
  const settings = await prisma.appSetting.findUnique({ where: { id: 1 } });
  const today = todayInTz(settings?.timezone ?? 'America/Tegucigalpa');
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!admin) throw new Error('Primero arranca la app para crear el usuario ADMIN (bootstrap).');

  await seedCardDemo(today, admin.id);

  if (await prisma.entity.findFirst({ where: { name: DEMO_NAME } })) {
    console.log('La unidad de negocio demo ya existe. Nada más que hacer.');
    return;
  }
  const base = await prisma.entity.findFirst({ where: { isDefault: true } });
  if (!base) throw new Error('No existe la unidad de negocio Base. Ejecuta el bootstrap primero.');

  // --- Tasas de cambio (no se duplican gracias al índice único) ---
  const rateDate = d(addDays(today, -30));
  for (const [from, to, rate] of [
    ['USD', 'HNL', '24.750000'],
    ['EUR', 'HNL', '26.900000'],
    ['EUR', 'USD', '1.087000'],
  ] as const) {
    await prisma.exchangeRate.upsert({
      where: { fromCurrency_toCurrency_effectiveDate: { fromCurrency: from, toCurrency: to, effectiveDate: rateDate } },
      update: {},
      create: { fromCurrency: from, toCurrency: to, rate, effectiveDate: rateDate },
    });
  }

  const demo = await prisma.entity.create({
    data: { name: DEMO_NAME, currency: 'USD', color: '#6366f1', minCashThreshold: money(3000) },
  });

  async function account(entityId: string, name: string, type: 'BANK' | 'CASH' | 'WALLET', opening: number) {
    const a = await prisma.account.create({ data: { entityId, name, type } });
    await prisma.cashMovement.create({
      data: { entityId, accountId: a.id, type: 'OPENING', amount: money(opening), date: d(addDays(today, -45)), description: 'Saldo de apertura' },
    });
    return a;
  }

  async function ob(
    entityId: string,
    direction: Direction,
    description: string,
    amount: number,
    expectedOffset: number,
    opts: { dueOffset?: number; priority?: Priority; counterparty?: string; hypothetical?: boolean } = {},
  ) {
    let counterpartyId: string | undefined;
    if (opts.counterparty) {
      const existing = await prisma.counterparty.findFirst({ where: { entityId, name: opts.counterparty } });
      counterpartyId =
        existing?.id ??
        (await prisma.counterparty.create({
          data: { entityId, name: opts.counterparty, type: direction === 'IN' ? 'CUSTOMER' : 'SUPPLIER' },
        })).id;
    }
    return prisma.obligation.create({
      data: {
        entityId,
        direction,
        description,
        amount: money(amount),
        dueDate: d(addDays(today, opts.dueOffset ?? expectedOffset)),
        expectedDate: d(addDays(today, expectedOffset)),
        priority: opts.priority ?? (direction === 'OUT' ? 'FIXED' : 'FLEXIBLE'),
        isHypothetical: Boolean(opts.hypothetical),
        counterpartyId,
        createdById: admin!.id,
      },
    });
  }

  // ---------------- Entidad Base (HNL) ----------------
  const baseHasData = (await prisma.account.count({ where: { entityId: base.id } })) > 0;
  let baseBank: { id: string } | null = null;
  if (!baseHasData) {
    await prisma.entity.update({ where: { id: base.id }, data: { minCashThreshold: money(150000) } });
    baseBank = await account(base.id, 'BAC Corriente', 'BANK', 820000);
    await account(base.id, 'Caja chica oficina', 'CASH', 15000);

    // Vencidas (se arrastran a la semana actual)
    await ob(base.id, 'IN', 'Factura 001-245 Campaña Navidad', 185000, -12, { counterparty: 'Supermercados La Colonia' });
    await ob(base.id, 'OUT', 'Impresión de vallas (proveedor)', 64000, -3, { counterparty: 'Impresiones Gráficas S.A.', priority: 'FLEXIBLE' });

    // Con abono parcial
    const partial = await ob(base.id, 'IN', 'Factura 001-251 Pauta TV octubre', 240000, 6, { counterparty: 'Banco Atlántida' });
    await registerPayment({ obligationId: partial.id, accountId: baseBank.id, amount: 90000_00, date: addDays(today, -2), userId: admin.id });

    // Doble fecha: vence pronto pero se espera más tarde
    await ob(base.id, 'IN', 'Factura 001-260 Activación BTL', 310000, 35, { dueOffset: 15, counterparty: 'Tigo Honduras' });
    await ob(base.id, 'IN', 'Factura 001-262 Producción spot', 145000, 20, { counterparty: 'Cervecería Hondureña' });
    await ob(base.id, 'IN', 'Factura 001-270 Campaña verano', 420000, 63, { counterparty: 'Supermercados La Colonia' });

    await ob(base.id, 'OUT', 'ISR pago a cuenta', 95000, 9, { counterparty: 'SAR', priority: 'FIXED' });
    await ob(base.id, 'OUT', 'Cuota préstamo vehículo', 38000, 18, { counterparty: 'Banco Ficohsa', priority: 'FIXED' });
    await ob(base.id, 'OUT', 'Renovación licencias software', 52000, 27, { counterparty: 'Adobe', priority: 'FLEXIBLE' });
    await ob(base.id, 'OUT', 'Proveedor de pantallas LED', 210000, 41, { counterparty: 'LED Solutions', priority: 'FLEXIBLE' });

    // Recurrencias
    await prisma.recurringRule.createMany({
      data: [
        { entityId: base.id, direction: 'OUT', description: 'Planilla quincenal', amount: money(165000), frequency: 'BIWEEKLY', startDate: d(addDays(today, 3)), priority: 'FIXED' },
        { entityId: base.id, direction: 'OUT', description: 'Alquiler oficina', amount: money(42000), frequency: 'MONTHLY', startDate: d(addDays(today, 8)), priority: 'FIXED' },
        { entityId: base.id, direction: 'IN', description: 'Iguala mensual cliente corporativo', amount: money(120000), frequency: 'MONTHLY', startDate: d(addDays(today, 12)) },
      ],
    });

    // What-If: compra de equipo hipotética
    await ob(base.id, 'OUT', '¿Compra de cámara y lentes?', 280000, 22, { hypothetical: true, priority: 'FLEXIBLE', counterparty: 'Proveedor de equipo' });
    console.log('  -> Datos demo cargados en la unidad de negocio Base');
  } else {
    console.log('  -> La unidad de negocio Base ya tiene cuentas: no se modifica');
  }

  // ---------------- Entidad demo (USD) ----------------
  const demoBank = await account(demo.id, 'Banco Promerica USD', 'BANK', 18500);
  await account(demo.id, 'PayPal', 'WALLET', 2300);

  await ob(demo.id, 'IN', 'Retainer agencia EE.UU. - noviembre', 6500, -5, { counterparty: 'Brightline Media LLC' });
  const partialUsd = await ob(demo.id, 'IN', 'Proyecto web e-commerce', 12000, 10, { counterparty: 'Café Honduras Export' });
  await registerPayment({ obligationId: partialUsd.id, accountId: demoBank.id, amount: 4000_00, date: addDays(today, -1), userId: admin.id });
  await ob(demo.id, 'IN', 'Campaña Google Ads gestionada', 3800, 24, { counterparty: 'Hotel Clarion' });
  await ob(demo.id, 'IN', 'Licenciamiento de contenido', 9500, 52, { counterparty: 'Brightline Media LLC' });
  await ob(demo.id, 'OUT', 'Servidores y nube (AWS)', 1450, 4, { counterparty: 'Amazon Web Services', priority: 'FIXED' });
  await ob(demo.id, 'OUT', 'Freelancers de diseño', 5200, 16, { counterparty: 'Equipo freelance', priority: 'FLEXIBLE' });
  await ob(demo.id, 'OUT', 'Pago de pauta Meta Ads', 7800, 30, { counterparty: 'Meta Platforms', priority: 'FIXED' });
  await prisma.recurringRule.createMany({
    data: [
      { entityId: demo.id, direction: 'OUT', description: 'Suscripciones SaaS', amount: money(640), frequency: 'MONTHLY', startDate: d(addDays(today, 5)), priority: 'FIXED' },
      { entityId: demo.id, direction: 'OUT', description: 'Honorarios equipo remoto', amount: money(3200), frequency: 'BIWEEKLY', startDate: d(addDays(today, 7)), priority: 'FIXED' },
    ],
  });
  await ob(demo.id, 'IN', '¿Nuevo cliente SaaS (propuesta)?', 15000, 45, { hypothetical: true, counterparty: 'Prospecto regional' });

  // Transferencia inter-entidad: préstamo de la demo (USD) a la Base (HNL)
  await createTransfer({
    kind: 'LOAN',
    fromEntityId: demo.id,
    toEntityId: base.id,
    amountFrom: 4000_00,
    amountTo: 99000_00,
    expectedDate: addDays(today, 13),
    description: 'Préstamo inter-compañía',
    userId: admin.id,
  });

  console.log(`  -> Unidad de negocio demo creada: ${DEMO_NAME}`);
  console.log('Listo. Abre el dashboard y alterna entre la vista consolidada y cada unidad de negocio.');
}

const CARD_NAME = 'Visa Empresarial (demo)';

/** Tarjeta de crédito demo en la Entidad Base. Idempotente: si ya existe, no hace nada. */
async function seedCardDemo(today: string, userId: string) {
  const base = await prisma.entity.findFirst({ where: { isDefault: true } });
  if (!base) return;
  if (await prisma.account.findFirst({ where: { entityId: base.id, name: CARD_NAME } })) {
    console.log('  -> La tarjeta demo ya existe: no se modifica');
    return;
  }
  const bank = await prisma.account.findFirst({ where: { entityId: base.id, type: 'BANK', archivedAt: null }, orderBy: { createdAt: 'asc' } });

  async function category(name: string) {
    const existing = await prisma.category.findFirst({ where: { entityId: base!.id, name, direction: 'OUT' } });
    return existing?.id ?? (await prisma.category.create({ data: { entityId: base!.id, name, direction: 'OUT' } })).id;
  }

  const card = await prisma.$transaction(async (tx) => {
    const c = await tx.account.create({
      data: {
        entityId: base.id,
        name: CARD_NAME,
        type: 'CREDIT_CARD',
        institution: 'BAC Credomatic',
        creditLimit: money(150000),
        statementDay: 15,
        paymentDueDay: 5,
        defaultPaymentAccountId: bank?.id ?? null,
        foreignCurrency: base.currency === 'HNL' ? 'USD' : null,
        creditLimitForeign: base.currency === 'HNL' ? money(5000) : null,
      },
    });
    await createOpeningDebt(tx, c, 8500_00, today, userId);
    return c;
  });

  await createCardCharge({
    cardId: card.id,
    purchaseDate: addDays(today, -20),
    description: 'Licencias Adobe Creative Cloud',
    amount: 12400_00,
    installments: 1,
    categoryId: await category('Software'),
    counterpartyName: 'Adobe',
    userId,
  });
  await createCardCharge({
    cardId: card.id,
    purchaseDate: addDays(today, -6),
    description: 'Combustible flota',
    amount: 4850_00,
    installments: 1,
    categoryId: await category('Combustible'),
    counterpartyName: 'Texaco',
    userId,
  });
  await createCardCharge({
    cardId: card.id,
    purchaseDate: addDays(today, -2),
    description: 'Laptop para diseño (6 cuotas)',
    amount: 36000_00,
    installments: 6,
    categoryId: await category('Equipo'),
    counterpartyName: 'Jetstereo',
    userId,
  });
  if (card.foreignCurrency) {
    const fx = (await syncIfMissing().catch(() => null), await getCurrentFx());
    if (fx) {
      await createCardCharge({
        cardId: card.id,
        purchaseDate: addDays(today, -4),
        description: 'Suscripción anual Figma (3 cuotas)',
        amount: 540_00,
        installments: 3,
        currency: 'USD',
        categoryId: await category('Software'),
        counterpartyName: 'Figma',
        userId,
      });
      await createCardCharge({
        cardId: card.id,
        purchaseDate: addDays(today, -1),
        description: 'Servidores AWS',
        amount: 86_40,
        installments: 1,
        currency: 'USD',
        categoryId: await category('Software'),
        counterpartyName: 'Amazon Web Services',
        userId,
      });
    } else {
      console.log('  !! Sin tipo de cambio disponible: se omiten los consumos demo en USD');
    }
  }
  if (bank) {
    await payCreditCard({ cardId: card.id, fromAccountId: bank.id, amount: 5000_00, date: today, note: 'Abono demo', userId });
  }
  console.log(`  -> Tarjeta demo creada: ${CARD_NAME}`);
}

main()
  .catch((e) => {
    console.error('[seed-demo] Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
