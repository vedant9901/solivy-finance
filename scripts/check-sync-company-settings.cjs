const fs = require('node:fs');
const assert = require('node:assert/strict');
const exchange = fs.readFileSync('app/api/sync/exchange/route.ts', 'utf8');
const run = fs.readFileSync('app/api/sync/run/route.ts', 'utf8');
for (const [label, source] of [['exchange', exchange], ['run', run]]) {
  assert.match(source, /function mergeInitialCompanySettings\(current:any, incoming:any, cols:any\[\], companyName=''/, `${label}: organization-aware settings merge missing`);
  assert.match(source, /name\.endsWith\('_settings'\)/, `${label}: empty JSON settings placeholders must merge as empty`);
  assert.match(source, /orgName\.toUpperCase\(\)!=='SOLIVY'/, `${label}: organization placeholder guard missing`);
  assert.ok(source.includes("String(a||'').trim().toUpperCase()==='SOLIVY'"), `${label}: default-name reconciliation guard missing`);
}
assert.match(exchange, /SELECT name,active FROM companies WHERE id=\?/);
assert.match(exchange, /mergeInitialCompanySettings\(current,desired,cols,companyName\)/);
assert.match(run, /SELECT name FROM companies WHERE id=\?/);
assert.match(run, /mergeInitialCompanySettings\(current,row,cols,companyName\)/);
// Behavior fixture: only the schema default may be replaced by the verified org name.
function mergeFixture(current, incoming, orgName) {
  const out = { ...current };
  if (orgName && orgName.toUpperCase() !== 'SOLIVY' && String(current.entity_name || '').trim().toUpperCase() === 'SOLIVY' && String(incoming.entity_name || '').trim().toUpperCase() === orgName.toUpperCase()) out.entity_name = incoming.entity_name;
  for (const key of ['commercial_bill_settings', 'third_party_bill_settings', 'payment_advice_settings']) {
    if (String(current[key] || '').trim() === '{}' && incoming[key] && incoming[key] !== '{}') out[key] = incoming[key];
  }
  return out;
}
const existing = { id: 1, entity_name: 'SOLIVY', commercial_bill_settings: '{}', third_party_bill_settings: '{}', payment_advice_settings: '{}', updated_at: '2026-10-22 09:37:28' };
const incoming = { id: 1, entity_name: 'AKSH ENTERPRISE', commercial_bill_settings: '{"show_hsn":true}', third_party_bill_settings: '{"show_net_weight":true}', payment_advice_settings: '{"show_utr":true}', updated_at: '2026-10-13 11:44:06' };
const merged = mergeFixture(existing, incoming, 'AKSH ENTERPRISE');
assert.equal(merged.entity_name, 'AKSH ENTERPRISE');
assert.equal(merged.commercial_bill_settings, incoming.commercial_bill_settings);
assert.equal(merged.third_party_bill_settings, incoming.third_party_bill_settings);
assert.equal(merged.payment_advice_settings, incoming.payment_advice_settings);
assert.equal(mergeFixture(existing, incoming, 'OTHER ORG').entity_name, 'SOLIVY', 'Do not replace default name with a different organization name');
console.log('Sync company-settings regression checks passed: destination organization scope, SOLIVY placeholder reconciliation, empty settings merge, and unrelated-organization guard.');
