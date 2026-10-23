const fs = require('fs');
const path = require('path');
const root = process.cwd();
const forbiddenExt = new Set(['.exe','.dll','.scr','.msi','.com','.jar','.class','.pyc','.so','.bin']);
const findings = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, {withFileTypes:true})) {
    if (['node_modules','.next','.git'].includes(item.name)) continue;
    const full = path.join(dir,item.name);
    if (item.isDirectory()) walk(full);
    else {
      const rel = path.relative(root,full).replaceAll('\\','/');
      const ext = path.extname(item.name).toLowerCase();
      if (forbiddenExt.has(ext)) findings.push(`unexpected executable/binary: ${rel}`);
      if (/^\.env(?:\.|$)/i.test(item.name) && item.name !== '.env.example') findings.push(`environment secret file: ${rel}`);
      if (/private\.pem$|id_rsa$|customer-licenses?\.json$/i.test(item.name)) findings.push(`private/customer secret file: ${rel}`);
      if (/\.(bat|ps1|cmd)$/i.test(item.name)) findings.push(`installer/launcher script not allowed in safe source package: ${rel}`);
    }
  }
}
walk(root);
if (findings.length) { for (const f of findings) console.error('FAIL '+f); process.exit(1); }
console.log('PASS no executable binaries, environment secrets, private keys, or Windows installer/launcher scripts in source package');
