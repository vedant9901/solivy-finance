// This module is used only in the Vercel/online build.
// Turbopack aliases ./db-sqlite to this file so SQLite and filesystem code
// are not traced into the online serverless functions.
export function db(): never {
  throw new Error('SQLite is unavailable in online mode. Configure DATABASE_URL and DEPLOYMENT_MODE=online.');
}
export function adminDb(): never {
  throw new Error('SQLite is unavailable in online mode. Configure DATABASE_URL and DEPLOYMENT_MODE=online.');
}
export function databasePath(): never {
  throw new Error('SQLite databasePath is unavailable in online mode.');
}
