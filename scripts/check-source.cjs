const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = process.cwd();
const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', '.next', '.git'].includes(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) files.push(full);
  }
}
walk(root);

let failed = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  let result;
  try { result = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
    },
  }); } catch (err) { failed++; console.error(`FAIL ${path.relative(root, file)}: ${err.message}`); continue; }
  const diagnostics = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length) {
    failed++;
    console.error(`FAIL ${path.relative(root, file)}`);
    for (const d of diagnostics) console.error('  ' + ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const required = ['next', 'react', 'react-dom', 'better-sqlite3', 'jspdf', 'xlsx', 'tailwindcss', '@tailwindcss/postcss', 'react-icons'];
for (const dep of required) {
  if (!pkg.dependencies?.[dep]) { console.error(`FAIL missing dependency: ${dep}`); failed++; }
}
if (!fs.readFileSync(path.join(root, 'app', 'globals.css'), 'utf8').includes("@import 'tailwindcss'")) {
  console.error('FAIL Tailwind v4 import missing from app/globals.css'); failed++;
}
console.log(`TypeScript parse audit: ${files.length} files checked`);
if (failed) process.exit(1);
console.log('PASS source/dependency/Tailwind audit');
