import fs from 'node:fs';
import path from 'node:path';
const root = path.join(process.cwd(), 'app', 'api');
let routes = 0;
let failures = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name === 'route.ts') {
      const source = fs.readFileSync(file, 'utf8');
      const hasDbImport = /from ['"][^'"]*lib\/db['"]/.test(source);
      const usesBridge = source.includes('withPostgresSQLiteBridge');
      if (hasDbImport && !usesBridge) failures.push(`${path.relative(process.cwd(), file)} imports lib/db but is not wrapped`);
      if (usesBridge) {
        routes++;
        if (!/export const runtime\s*=\s*['\"]nodejs['\"]/.test(source)) failures.push(`${path.relative(process.cwd(), file)} must use Node.js runtime`);
        if (/export async function (GET|POST|PUT|PATCH|DELETE)\s*\(/.test(source) && !/(const __wrapped_|const wrapped\s*=)/.test(source)) failures.push(`${path.relative(process.cwd(), file)} has an unwrapped handler`);
      }
    }
  }
}
walk(root);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Database bridge source audit passed: ${routes} API route files use the bridge.`);
