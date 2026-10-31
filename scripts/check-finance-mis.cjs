const fs=require('node:fs');let failed=0;function check(name,ok){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failed++;}
const bank=fs.readFileSync('app/api/bank/route.ts','utf8'),mis=fs.readFileSync('app/api/group-mis/route.ts','utf8'),page=fs.readFileSync('app/page.tsx','utf8'),out=fs.readFileSync('app/api/money-out/route.ts','utf8'),targets=fs.readFileSync('app/api/intercompany-targets/route.ts','utf8'),reverse=fs.readFileSync('app/api/money-out/reverse/route.ts','utf8'),layout=fs.readFileSync('app/layout.tsx','utf8'),appearance=fs.readFileSync('app/components/AppearanceSync.tsx','utf8'),pdf=fs.readFileSync('app/api/payment-advice/route.ts','utf8'),middleware=fs.readFileSync('middleware.ts','utf8'),security=fs.readFileSync('lib/security.ts','utf8');
check('Group MIS uses authenticated environment, not query override',mis.includes('mode=sessionMode(req)'));
check('Group MIS supports permission-checked organization multi-select',mis.includes('company_ids')&&mis.includes('allowedIds.has(id)'));
check('Top parties ranked by posted purchase value',mis.includes('ORDER BY purchase_value DESC')&&mis.includes('paid_value')&&mis.includes('outstanding'));
check('MIS includes purchase cost, vendor paid, financing receivable, book profit and available cash',mis.includes('purchase_cost')&&mis.includes('paid_to_vendors')&&mis.includes('financing_receivable')&&mis.includes('book_profit')&&mis.includes('available_cash'));
check('Group MIS computes outstanding loan principal after posted repayments',mis.includes("out_type='LOAN_REPAYMENT' AND o.status='POSTED'")&&mis.includes('funding_principal_outstanding'));
check('Group MIS exposes consolidated book-based funding capacity estimate',mis.includes('funding_capacity_estimate:Math.max(0,fundingPrincipal+bookProfit-interest)')&&page.includes('Total Funding Capacity (estimate)')&&page.includes('Funding position'));
check('Funding transfer screen routes active loan through safe loan transfer endpoint',page.includes("type==='funding_loans'?String(r.status||'ACTIVE').toUpperCase()==='ACTIVE'")&&page.includes("api('/funding/transfer'")&&page.includes('Transfer ${ids.length} selected loan')&&page.includes('for(const loanId of ids)'));
check('Main dashboard bases funding capacity on outstanding principal, not original principal',page.includes("'outstanding_principal'")&&page.includes('Funding capacity · book-based estimate'));
check('Bank matching covers account_transactions, not just purchase payments',bank.includes('FROM account_transactions t')&&bank.includes('bank_transaction_matches')&&page.includes('<BankMatching mode={mode} companyId={companyId} language={language}/>'));
check('Bank mismatch details are response JSON, not invalid ResponseInit properties',bank.includes("{error:`Statement amount differs")&&bank.includes('difference:diff')&&!bank.includes("{status:409,difference:diff}"));
check('Financing receivable party and inter-company narration supported in bank matching',bank.includes('frParty.name')&&bank.includes('INTERCOMPANY_RECEIPT'));
check('Other money out and loan repayment create counterpart Money In',out.includes("type === 'OTHER' || type === 'LOAN_REPAYMENT'")&&out.includes('destination_receipt_id')&&out.includes('INTERCOMPANY_LOAN_REPAYMENT'));
check('Destination organization and account are validated for current environment',targets.includes('user_companies')&&targets.includes('can_test=1')&&targets.includes('can_live=1'));
check('Inter-company reversal also reverses destination receipt and requires mapped access',reverse.includes('destination_receipt_id')&&reverse.includes('must be mapped to the destination organization'));
check('Money-out entitlement matches middleware and server security',middleware.includes("['/api/money-out','money-out']")&&security.includes("['/api/money-out', ['money-out']]"));
// v2.8.0 moved accent reading into app/lib/appearance.ts, so AppearanceSync delegates instead of
// naming the key itself. The property checked is unchanged: the accent is persisted and re-applied
// app-wide on load and across tabs.
check('Theme persists in local storage and app-wide provider',page.includes("localStorage.setItem('solivy-theme',theme)")&&layout.includes('AppearanceSync')&&appearance.includes('applyAppearance')&&fs.readFileSync('app/lib/appearance.ts','utf8').includes("'solivy-theme'"));
check('Payment advice PDF accent follows selected theme',page.includes('&theme=${theme}')&&pdf.includes('themePalette'));
check('Hindi/Gujarati selector is available and preference persists',page.includes('solivy-language')&&page.includes('value="hi"')&&page.includes('value="gu"'));
if(failed)process.exit(1);console.log('Finance MIS, bank matching, inter-company and appearance source checks passed.');
