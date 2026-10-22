#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const args=process.argv.slice(2), command=args.shift();
function arg(n,d=''){const i=args.indexOf(n);return i>=0?(args[i+1]||''):d}
function b64url(x){return Buffer.from(x).toString('base64url')}
function usage(){console.log(`SOLIVY License Tool
keygen --out C:\SOLIVY-Keys
issue --private-key C:\SOLIVY-Keys\private.pem --customer "Customer" --company-ids 1 --days 365 --edition professional --features core,purchase,payments --out .\customer-license.txt
issue --private-key C:\SOLIVY-Keys\private.pem --customer "Customer" --company-ids 1 --perpetual --edition professional --features '*' --out .\customer-perpetual-license.txt
self-test
Never distribute the private key. Wildcard company IDs are only for dedicated single-customer installs. A perpetual offline license cannot be remotely revoked.`)}
if(command==='keygen'){const out=path.resolve(arg('--out','./license-authority'));fs.mkdirSync(out,{recursive:true});const k=crypto.generateKeyPairSync('ed25519');fs.writeFileSync(path.join(out,'private.pem'),k.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});fs.writeFileSync(path.join(out,'public.pem'),k.publicKey.export({type:'spki',format:'pem'}));fs.writeFileSync(path.join(out,'public-key-base64.txt'),k.publicKey.export({type:'spki',format:'der'}).toString('base64')+'\n');console.log('Keys created. Keep private.pem offline and secret. Public key must be installed in middleware.ts.')} 
else if(command==='issue'){
 const kp=path.resolve(arg('--private-key')),customer=arg('--customer'),ids=arg('--company-ids'),perpetual=args.includes('--perpetual'),days=Number(arg('--days','365')),edition=arg('--edition','standard'),features=arg('--features','core'),out=path.resolve(arg('--out','./customer-license.txt'));
 if(!fs.existsSync(kp)||!customer||!ids||(!perpetual&&(!Number.isFinite(days)||days<1||days>3650))){console.error('Invalid arguments. Use --days 1..3650, or --perpetual for a no-expiry license.');process.exit(2)}
 const key=crypto.createPrivateKey(fs.readFileSync(kp));if(key.asymmetricKeyType!=='ed25519'){console.error('Expected Ed25519 private key.');process.exit(2)}
 const now=new Date(), companyIds=ids.trim()==='*'?['*']:ids.split(',').map(x=>Number(x.trim())).filter(Number.isInteger);if(!companyIds.length){console.error('Provide valid company IDs.');process.exit(2)}
 const payload={product:'SOLIVY_FINANCE',licenseId:crypto.randomUUID(),customer,companyIds,edition,features:[...new Set(features.split(',').map(x=>x.trim()).filter(Boolean))],issuedAt:now.toISOString(),perpetual,expiresAt:perpetual?null:new Date(now.getTime()+days*86400000).toISOString()};
 const part=b64url(JSON.stringify(payload)),sig=crypto.sign(null,Buffer.from(part),key).toString('base64url');fs.writeFileSync(out,part+'.'+sig+'\n',{mode:0o600});console.log(`Issued ${payload.licenseId} ${perpetual?'as a perpetual license (no expiry)':'through '+payload.expiresAt}. Send only the token; never send the private key.`)
}
else if(command==='self-test'){const k=crypto.generateKeyPairSync('ed25519');for(const payload of [{product:'SOLIVY_FINANCE',licenseId:'self-test-time-limited',customer:'test',companyIds:[1],issuedAt:new Date().toISOString(),perpetual:false,expiresAt:new Date(Date.now()+60000).toISOString()},{product:'SOLIVY_FINANCE',licenseId:'self-test-perpetual',customer:'test',companyIds:[1],issuedAt:new Date().toISOString(),perpetual:true,expiresAt:null}]){const p=b64url(JSON.stringify(payload)),sig=crypto.sign(null,Buffer.from(p),k.privateKey);if(!crypto.verify(null,Buffer.from(p),k.publicKey,sig))process.exit(1);const decoded=JSON.parse(Buffer.from(p,'base64url').toString());if(decoded.perpetual && decoded.expiresAt!==null)process.exit(1)}console.log('PASS Ed25519 time-limited and perpetual sign/verify self-tests')}
else {usage();if(command)process.exit(2)}
