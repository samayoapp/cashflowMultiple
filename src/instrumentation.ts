/**
 * Se ejecuta una vez al arrancar el servidor de Next.js.
 * Inicia la sincronización diaria del tipo de cambio (desactivable con FX_SYNC_ENABLED=false).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.FX_SYNC_ENABLED === 'false') return;
  const { startFxScheduler } = await import('./lib/server/fx');
  startFxScheduler();
}
