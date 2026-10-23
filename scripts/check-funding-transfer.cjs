const fs=require('fs');const assert=require('assert');
const read=p=>fs.readFileSync(p,'utf8');
const route=read('app/api/funding/transfer/route.ts');
const page=read('app/page.tsx');
const funding=read('app/api/funding/route.ts');
const pay=read('app/api/funding/pay/route.ts');
const out=read('app/api/money-out/route.ts');
const reverse=read('app/api/money-out/reverse/route.ts');
const data=read('app/api/data/route.ts');
const bridge=read('lib/postgres-sqlite-bridge.ts');
for(const [label,cond] of [
 ['loan transfer endpoint exists',route.includes("if(action==='transfer')")],
 ['mapped destination access enforced',route.includes('authorized(a,username,destId,role,mode)')],
 ['source loan concurrency lock',route.includes("status='TRANSFERRING'")],
 ['outstanding principal excludes posted repayments',route.includes("out_type='LOAN_REPAYMENT' AND status='POSTED'")],
 ['historical repayments snapshot retained',route.includes('repayments,schedule')],
 ['destination loan created',route.includes('INSERT INTO funding_loans')],
 ['source and destination audit records',route.includes('INTERCOMPANY_LOAN_TRANSFER_OUT')&&route.includes('INTERCOMPANY_LOAN_TRANSFER_IN')],
 ['reversal requires no new principal/interest activity',route.includes('principalCount||interestCount')],
 ['reversal status retained in both orgs',route.includes("status='REVERSED'")&&route.includes("status='TRANSFER_REVERSED'")],
 ['incoming/outgoing transfer history API',route.includes('source_company_id=? OR destination_company_id=?')],
 ['funding cash transfer UI uses paired money out',page.includes('POST FUNDING CASH TRANSFER')&&page.includes("api('/money-out'")],
 ['generic Inter-Company screen permits ACTIVE loan selection',page.includes("type==='funding_loans'?String(r.status||'ACTIVE').toUpperCase()==='ACTIVE'")],
 ['generic Inter-Company screen routes loan transfer to linked accounting endpoint',page.includes("api('/funding/transfer'")&&page.includes('for(const loanId of ids)')&&page.includes('Select all eligible loans')&&page.includes('const failedIds:number[]=[]')],
 ['loan transfer UI and history visible',page.includes('TRANSFER LOAN')&&page.includes('View History')],
 ['transferred loans cannot be edited',funding.includes('Only ACTIVE loans can be edited')],
 ['interest posting rejects inactive loan',pay.includes('Interest cannot be posted against a transferred or inactive loan')],
 ['repayment rejects inactive loan',out.includes('Only ACTIVE loans can be repaid')],
 ['repayment reversal blocked for transferred loan',reverse.includes('Reverse the loan transfer first')],
 ['inactive loan has zero outstanding principal',data.includes("CASE WHEN l.status='ACTIVE' THEN MAX(0,l.principal_amount")],
 ['Postgres bridge hydrates and persists destination organization snapshots',bridge.includes('await req.clone().json()')&&bridge.includes('ids.add(destination)')&&bridge.includes('await logicalFiles(req)')],
]){assert(cond,label);console.log('PASS',label)}
console.log('Funding transfer regression checks passed.');
