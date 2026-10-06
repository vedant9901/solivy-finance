const mode = process.env.DEPLOYMENT_MODE || (process.env.DATABASE_URL ? 'online' : 'offline');
if (mode === 'online') {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required for online mode.'); process.exit(1); }
  if (!process.env.SESSION_SECRET) { console.error('SESSION_SECRET is required for online mode.'); process.exit(1); }
  console.log('Online environment OK.');
} else {
  console.log('Offline mode. FINANCE_DATA_DIR is optional; the application uses the persistent SOLIVY default when it is not set.');
}
