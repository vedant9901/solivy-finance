const fs=require('node:fs');
const api=fs.readFileSync('app/api/group-mis/route.ts','utf8'),page=fs.readFileSync('app/page.tsx','utf8'),bank=fs.readFileSync('app/api/bank/route.ts','utf8'),data=fs.readFileSync('app/api/data/route.ts','utf8'),css=fs.readFileSync('app/globals.css','utf8'),moneyOut=fs.readFileSync('app/api/money-out/route.ts','utf8'),moneyIn=fs.readFileSync('app/api/money-in/route.ts','utf8'),reverse=fs.readFileSync('app/api/money-out/reverse/route.ts','utf8'),reverseAll=fs.readFileSync('app/api/reverse/route.ts','utf8'),dbSchema=fs.readFileSync('lib/db.ts','utf8');
const checks=[
 ['Group MIS filters selected organizations to authorized companies',api.includes('company_ids')&&api.includes('allowed.some(c=>Number(c.id)===id)')],
 ['Top parties ranked by posted purchase value',api.includes('purchase_volume')&&api.includes('FROM purchases pu JOIN parties p')&&api.includes('ORDER BY purchase_volume DESC')],
 ['Group MIS separates margin, interest, book profit and collected profit',api.includes('gross_book_margin')&&api.includes('interest_paid')&&api.includes('book_profit')&&api.includes('earned_profit')&&api.includes('available_funding')],
 ['Group MIS paid metric is purchase-allocation based',api.includes('FROM payment_allocations pa JOIN payments py ON py.id=pa.payment_id JOIN purchases pu ON pu.id=pa.purchase_id')],
 ['Group MIS organization multi-select and book-profit headroom label',page.includes('Organizations included')&&page.includes('Purchase Cost')&&page.includes('Funding Headroom (book-profit basis)')],
 ['Group MIS translations wired for selected language',page.includes('function GroupMIS({mode,language}')&&page.includes("language==='hi'?hi:language==='gu'?gu:en")],
 ['Bank Matching queries all recorded account transactions',bank.includes('FROM account_transactions t JOIN company_accounts a')&&bank.includes('transactions:rows,unmatched:')],
 ['Bank mismatch metadata is inside JSON body, status only in ResponseInit',bank.includes('difference:diff},{status:409}')],
 ['Bank Matching UI offers matched and unmatched records',page.includes('function BankMatching')&&page.includes('Matched')&&page.includes('Unmatched')],
 ['Money Out creates destination Money In only after mapped-org validation',moneyOut.includes('INTERCOMPANY_RECEIPT')&&moneyOut.includes('destination_company_id')&&moneyOut.includes('Destination organization is not mapped')],
 ['Money In can create matching source Money Out in a mapped organization',moneyIn.includes('source_company_id')&&moneyIn.includes('source_money_out_id')&&moneyIn.includes('INTERCOMPANY_RECEIPT')&&moneyIn.includes('destination_receipt_id')],
 ['Inter-company Money In/Money Out linkage is persisted and reversible',dbSchema.includes("addColumn('money_in','source_company_id'")&&reverseAll.includes('source_money_out_id')&&reverseAll.includes('matching source Money Out')],
 ['Money In form offers mapped source organization and source account',page.includes('Source organization (optional)')&&page.includes('Pay from source organization account')],
 ['Destination selector converts default refund to Other Money Out',page.includes('Route to another mapped organization (optional)')&&page.includes("form.out_type==='REFUND'?{out_type:'OTHER'")],
 ['Money Out reversal includes selected company ID',page.includes('company_id:Number(sessionStorage.getItem(\'aksh-company-id\')||1),id:r.id,reason')],
 ['Inter-company reversal handles destination receipt linkage',reverse.includes('destination_receipt_id')&&reverse.includes('Reversal of inter-company receipt')],
 ['Six accent themes persisted and styled',page.includes('solivy-theme')&&['teal','blue','violet','emerald','amber','rose'].every(x=>css.includes(`data-theme="${x}"`))],
 ['Supported PDF routes accept theme accent',fs.readFileSync('app/api/payment-advice/route.ts','utf8').includes("u.searchParams.get('theme')")&&fs.readFileSync('app/api/purchase-bill/route.ts','utf8').includes("u.searchParams.get('theme')")],
 ['Financing receivables include party name',data.includes('p.name party_name')&&data.includes('FROM financing_receivables r JOIN parties p')]
];let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failed++;}if(failed)process.exit(1);console.log(`Group MIS / bank matching checks passed: ${checks.length}/${checks.length}`);
