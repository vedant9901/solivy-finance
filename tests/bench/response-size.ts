/**
 * Measures what /api/data module payloads cost on the wire. Next.js compresses responses it
 * serves (next.config.mjs compress:true) and Vercel's edge compresses otherwise, so the gzip and
 * Brotli columns are what a browser actually downloads.
 *   node --require ./tests/setup/register.cjs --import tsx tests/bench/response-size.ts
 */
import zlib from 'node:zlib';
import { call, adminSession, expectOk } from '../helpers/app';
import { seedFinance } from '../helpers/seed-finance';

(async () => {
  const s = await adminSession();
  await seedFinance(s.cookie);
  const data = expectOk(await call('/api/data', { cookie: s.cookie }));
  const party = data.parties[0].id; const account = data.accounts[0].id;
  for (let i = 0; i < 300; i++) {
    expectOk(await call('/api/purchases', { cookie: s.cookie, body: { party_id: party, purchase_date: `2026-0${1 + (i % 6)}-${String(1 + (i % 28)).padStart(2, '0')}`, net_weight: 9000 + i, gross_weight: 9100 + i, rate: 52, freight: 1500, goods_description: 'Cumin seed (jeera) — machine clean', truck_number: `GJ02AB${1000 + i}`, invoice_no: `INV-${i}` } }));
    if (i % 3 === 0) {
      expectOk(await call('/api/money-in', { cookie: s.cookie, body: { receipt_date: '2026-06-01', account_id: account, amount: 400000, receipt_type: 'CAPITAL', narration: 'Funding for bench' } }));
      expectOk(await call('/api/payments', { cookie: s.cookie, body: { party_id: party, payment_date: '2026-06-01', amount: 100000, mode: 'BANK', company_account_id: account } }));
    }
  }
  const rows: Array<Record<string, string | number>> = [];
  for (const modules of ['core,parties,accounts', 'core,parties,accounts,purchases', 'core,parties,accounts,payments,purchases', 'core,parties,accounts,money,payments,purchases,receivables', 'account-history,money,ledger,payments,purchases,receivables']) {
    const r = await call('/api/data', { cookie: s.cookie, query: { modules } });
    const raw = Buffer.from(r.text);
    rows.push({ modules, raw_KB: +(raw.length / 1024).toFixed(1), gzip_KB: +(zlib.gzipSync(raw, { level: 6 }).length / 1024).toFixed(1), brotli_KB: +(zlib.brotliCompressSync(raw).length / 1024).toFixed(1) });
  }
  console.table(rows);
})().catch((e) => { console.error(e); process.exit(1); });
