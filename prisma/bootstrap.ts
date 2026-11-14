/**
 * Inicialización del primer despliegue. IDEMPOTENTE y NO destructiva:
 * solo crea lo que falta, nunca borra ni sobrescribe datos existentes.
 *  - AppSetting (moneda de reporte HNL)
 *  - Entidad Base por defecto
 *  - Escenario What-If por defecto
 *  - Usuario ADMIN inicial (desde ADMIN_EMAIL / ADMIN_PASSWORD) si no hay ningún usuario
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  await prisma.appSetting.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, reportingCurrency: process.env.REPORTING_CURRENCY || 'HNL' },
  });

  const anyEntity = await prisma.entity.findFirst({ select: { id: true } });
  if (!anyEntity) {
    await prisma.entity.create({
      data: {
        name: process.env.DEFAULT_ENTITY_NAME || 'Unidad de negocio Base',
        currency: process.env.DEFAULT_ENTITY_CURRENCY || 'HNL',
        color: '#10b981',
        isDefault: true,
      },
    });
    console.log('  -> Unidad de negocio Base creada');
  }

  const scenario = await prisma.scenario.findFirst({ where: { isDefault: true } });
  if (!scenario) {
    await prisma.scenario.create({ data: { name: 'Escenario principal', isDefault: true } });
  }

  const userCount = await prisma.user.count();
  if (userCount === 0) {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password || password.length < 10) {
      console.warn('  !! No hay usuarios y ADMIN_EMAIL/ADMIN_PASSWORD (mín. 10 caracteres) no están definidos.');
      console.warn('     Defínelos en .env y reinicia el contenedor para crear el administrador.');
    } else {
      await prisma.user.create({
        data: {
          email,
          name: process.env.ADMIN_NAME || 'Administrador',
          passwordHash: await bcrypt.hash(password, 12),
          role: 'ADMIN',
        },
      });
      console.log(`  -> Usuario ADMIN creado: ${email}`);
    }
  }
}

main()
  .catch((e) => {
    console.error('[bootstrap] Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
