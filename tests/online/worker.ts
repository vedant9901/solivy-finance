// Child process = one serverless instance. Logs in and posts N parties to org 1.
import { call, login } from '../helpers/app';
(async () => {
  const n = Number(process.argv[2] || 10); const tag = process.argv[3] || 'w';
  const cookie = await login('owner', 1, 'LIVE', 'Correct-Horse-Battery-9');
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await call('/api/parties', { cookie, body: { name: `${tag}-${i}`, party_type: 'GOODS_VENDOR' } })).status);
  process.stdout.write(JSON.stringify(statuses));
  const { postgresPool } = await import('../../lib/postgres');
  await postgresPool().end();
})().catch((e) => { console.error(e); process.exit(1); });
