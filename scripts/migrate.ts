/**
 * Aplica TODOS los SQL de prisma/migrations en orden alfabético.
 * Los archivos son idempotentes (IF NOT EXISTS), por lo que re-ejecutarlos es seguro.
 * Cada archivo corre en su propia transacción: si uno falla, se revierte y el proceso termina con error.
 * Se registra la ejecución en "_cf_migrations" solo como bitácora.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL no está definido');

  const dir = join(process.cwd(), 'prisma', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS "_cf_migrations" (
      "file" TEXT PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      process.stdout.write(`  -> ${file} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO "_cf_migrations"("file","checksum") VALUES ($1,$2)
           ON CONFLICT ("file") DO UPDATE SET "checksum" = EXCLUDED."checksum", "appliedAt" = CURRENT_TIMESTAMP`,
          [file, checksum],
        );
        await client.query('COMMIT');
        console.log('ok');
      } catch (e) {
        await client.query('ROLLBACK');
        console.log('ERROR');
        throw e;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('[migrate] Falló la migración:', e instanceof Error ? e.message : e);
  process.exit(1);
});
