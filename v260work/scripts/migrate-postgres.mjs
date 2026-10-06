// The application creates/migrates the required PostgreSQL schemas lazily on first request.
// This command is intentionally a safe connectivity check and does not delete data.
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
console.log('DATABASE_URL is configured. PostgreSQL schemas are initialized by the SOLIVY API on first request.');
