import fs from 'node:fs';
import path from 'node:path';
const env=fs.existsSync('.env.local')?fs.readFileSync('.env.local','utf8'):'';
const m=env.match(/^FINANCE_DATA_DIR=(.*)$/m);
if(!m?.[1]?.trim()){console.error('FINANCE_DATA_DIR is not configured. Run INSTALL-SOLIVY-LOCAL.bat first.');process.exit(1)}
const dir=m[1].trim().replace(/^\"|\"$/g,'');
fs.mkdirSync(path.resolve(dir),{recursive:true});
console.log('FINANCE_DATA_DIR:',path.resolve(dir));
console.log('Environment OK');
