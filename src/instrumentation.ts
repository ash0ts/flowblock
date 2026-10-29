export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.DATABASE_URL) {
    const { startMaintenance } = await import('./server/maintenance');
    startMaintenance();
  }
}
