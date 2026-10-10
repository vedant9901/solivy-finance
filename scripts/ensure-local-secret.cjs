/* Local production-start guard. Vercel does not use this npm start script. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = process.cwd();
const envPath = path.join(root, '.env.local');
let lines = [];
if (fs.existsSync(envPath)) {
  lines = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
}
const index = lines.findIndex((line) => /^\s*SESSION_SECRET\s*=/.test(line));
const current = index >= 0 ? lines[index].slice(lines[index].indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') : '';
const isPlaceholder = !current || /^(replace-with|change-me|your-secret|example|placeholder)/i.test(current);
if (isPlaceholder || current.length < 32) {
  const secret = crypto.randomBytes(48).toString('base64url');
  const line = `SESSION_SECRET=${secret}`;
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  const clean = lines.filter((line, i) => i < lines.length - 1 || line !== '');
  fs.writeFileSync(envPath, clean.join('\n').replace(/\n*$/, '\n'), { encoding: 'utf8', mode: 0o600 });
  console.log('SOLIVY: generated a secure local SESSION_SECRET in .env.local (value hidden).');
} else {
  console.log('SOLIVY: local SESSION_SECRET is configured (value hidden).');
}
