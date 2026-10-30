// Preloaded in the measurement child. Creates the shared pg Pool (the bridge reuses
// globalThis.solivyPgPool) and counts every byte crossing the PostgreSQL sockets —
// the same bytes Neon bills as network transfer (plus TLS overhead in production).
const { Pool } = require('pg');
const sockets = new Set();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 10000 });
pool.on('connect', (client) => { const s = client.connection && client.connection.stream; if (s) sockets.add(s); });
globalThis.solivyPgPool = pool;
globalThis.__pgBytes = () => { let r = 0, w = 0; for (const s of sockets) { r += s.bytesRead || 0; w += s.bytesWritten || 0; } return { read: r, written: w }; };
