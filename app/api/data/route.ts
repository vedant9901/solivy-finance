import {NextResponse} from 'next/server';
import {db,Mode,adminDb} from '../../../lib/db';
export const dynamic='force-dynamic';
function today(){return new Date().toISOString().slice(0,10)}
function addDays(date:string,days:number){const d=new Date(date+'T00:00:00');d.setDate(d.getDate()+days);return d.toISOString().slice(0,10)}
function weekEnd(date:string){const d=new Date(date+'T00:00:00');const day=d.getDay();const delta=day===0?0:7-day;d.setDate(d.getDate()+delta);return d.toISOString().slice(0,10)}
export async function GET(req:Request){
 try{
  const u=new URL(req.url); const mode=(u.searchParams.get('mode')||'LIVE') as Mode; const companyId=Number(req.headers.get('x-aksh-company-id')||u.searchParams.get('company_id')||1); const d=await db(mode,companyId); const t=today(); const tomorrow=addDays(t,1); const week=weekEnd(t);
  // Repair legacy/CSV payments that were posted but never allocated to purchase bills.
  // Payments reduce vendor dues even when the original payment record was created without
  // an allocation; allocation is rebuilt FIFO against the vendor's oldest posted bills.
  const reconcilePostedPaymentAllocations = async () => {
    const paymentsToReconcile = await d.prepare(`
      SELECT p.id,p.party_id,p.amount,COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.payment_id=p.id),0) allocated
      FROM payments p WHERE p.status='POSTED' ORDER BY p.payment_date,p.id
    `).all() as any[];
    const insert = d.prepare('INSERT OR IGNORE INTO payment_allocations(payment_id,purchase_id,amount) VALUES(?,?,?)');
    const getPurchases = d.prepare(`
      SELECT p.id, p.net_payable - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.purchase_id=p.id),0) due
      FROM purchases p WHERE p.party_id=? AND p.status='POSTED'
        AND p.net_payable > COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.purchase_id=p.id),0)
      ORDER BY p.purchase_date,p.id
    `);
    const reconcile = d.transaction(async () => {
      for (const pay of paymentsToReconcile) {
        let remain = Math.max(0, Number(pay.amount||0) - Number(pay.allocated||0));
        if (remain <= 0) continue;
        const bills = await getPurchases.all(pay.party_id) as any[];
        for (const bill of bills) {
          if (remain <= 0) break;
          const due = Math.max(0, Number(bill.due||0));
          if (!due) continue;
          const allocation = Math.min(remain, due);
          await insert.run(pay.id, bill.id, allocation);
          remain -= allocation;
        }
      }
    });
    await reconcile();
  };
  await reconcilePostedPaymentAllocations();
  const thirdParties=await d.prepare('SELECT * FROM third_parties WHERE active=1 ORDER BY name').all();
  const parties=await d.prepare(`SELECT p.*,b.bank_name,b.account_holder,b.account_number,b.ifsc,b.branch FROM parties p LEFT JOIN bank_accounts b ON b.id=(SELECT id FROM bank_accounts WHERE party_id=p.id ORDER BY is_primary DESC,id LIMIT 1) ORDER BY p.name`).all();
  const purchases=await d.prepare(`SELECT p.*,x.name party_name, r.party_id receivable_party_id, rp.name receivable_party_name, r.receivable_amount, r.due_days receivable_due_days, r.due_date receivable_due_date, r.notes receivable_notes, COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.purchase_id=p.id),0) paid_amount, p.net_payable-COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.purchase_id=p.id),0) outstanding FROM purchases p JOIN parties x ON x.id=p.party_id LEFT JOIN financing_receivables r ON r.purchase_id=p.id LEFT JOIN parties rp ON rp.id=r.party_id ORDER BY p.id DESC LIMIT 200`).all();
  const payments=await d.prepare('SELECT p.*,x.name party_name,a.account_name company_account_name,(SELECT COALESCE(SUM(amount),0) FROM payment_allocations a2 WHERE a2.payment_id=p.id) allocated FROM payments p JOIN parties x ON x.id=p.party_id LEFT JOIN company_accounts a ON a.id=p.company_account_id ORDER BY p.id DESC LIMIT 200').all();
  const pendingPurchaseBills=await d.prepare(`SELECT p.id,p.purchase_date,p.party_id,x.name party_name,p.invoice_no,p.sample_no,p.net_payable,COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments pay ON pay.id=a.payment_id WHERE a.purchase_id=p.id AND pay.status='POSTED'),0) paid_amount,p.net_payable-COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments pay ON pay.id=a.payment_id WHERE a.purchase_id=p.id AND pay.status='POSTED'),0) outstanding FROM purchases p JOIN parties x ON x.id=p.party_id WHERE p.status='POSTED' AND p.net_payable>COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments pay ON pay.id=a.payment_id WHERE a.purchase_id=p.id AND pay.status='POSTED'),0) ORDER BY p.purchase_date,p.id`).all();
  const outstanding=await d.prepare(`SELECT x.id,x.name,COALESCE((SELECT SUM(net_payable) FROM purchases p WHERE p.party_id=x.id AND p.status='POSTED'),0) purchases,COALESCE((SELECT SUM(amount) FROM payments pay WHERE pay.party_id=x.id AND pay.status='POSTED'),0) payments,COALESCE(x.opening_balance,0)*(CASE WHEN x.opening_balance_type='PAYABLE' THEN 1 ELSE -1 END)+COALESCE((SELECT SUM(net_payable) FROM purchases p WHERE p.party_id=x.id AND p.status='POSTED'),0)-COALESCE((SELECT SUM(amount) FROM payments pay WHERE pay.party_id=x.id AND pay.status='POSTED'),0) outstanding FROM parties x ORDER BY outstanding DESC`).all();
  const ledger=await d.prepare(`SELECT l.*,p.name party_name FROM ledger l JOIN parties p ON p.id=l.party_id ORDER BY l.entry_date DESC,l.id DESC LIMIT 500`).all();
  const unmatched=await d.prepare(`SELECT p.*,x.name party_name FROM payments p JOIN parties x ON x.id=p.party_id LEFT JOIN bank_matches b ON b.payment_id=p.id WHERE b.id IS NULL AND p.status='POSTED' ORDER BY p.id DESC`).all();
  const rawSettings=await d.prepare('SELECT * FROM company_settings WHERE id=1').get() as any;
  let documentSettings:any={}; try{documentSettings={commercial_bill_settings:JSON.parse(rawSettings?.commercial_bill_settings||'{}'),payment_advice_settings:JSON.parse(rawSettings?.payment_advice_settings||'{}')}}catch{}
  const ad=await adminDb(); const users=await ad.prepare('SELECT id,username,name,role,active FROM admin_users ORDER BY username').all(); const companies=await ad.prepare('SELECT id,name,code,email,active FROM companies WHERE active=1 ORDER BY name').all(); const settings={...(rawSettings||{}),...documentSettings}; const sales=await d.prepare('SELECT * FROM sales ORDER BY invoice_date DESC,id DESC LIMIT 200').all(); const receivables=await d.prepare(`SELECT r.*,p.name party_name,pu.sample_no,pu.invoice_no supplier_invoice_no FROM financing_receivables r JOIN parties p ON p.id=r.party_id JOIN purchases pu ON pu.id=r.purchase_id ORDER BY r.bill_date DESC,r.id DESC LIMIT 500`).all();
  const accounts=await d.prepare(`SELECT a.*,a.opening_balance+COALESCE((SELECT SUM(CASE WHEN transaction_type='CREDIT' THEN amount ELSE -amount END) FROM account_transactions t WHERE t.account_id=a.id),0) balance FROM company_accounts a WHERE a.active=1 ORDER BY a.account_name`).all();
  const accountMovements=await d.prepare(`SELECT m.*,fa.account_name from_account_name,ta.account_name to_account_name FROM account_movements m JOIN company_accounts fa ON fa.id=m.from_account_id LEFT JOIN company_accounts ta ON ta.id=m.to_account_id ORDER BY m.movement_date DESC,m.id DESC LIMIT 500`).all();
  const moneyIn=await d.prepare(`SELECT m.*,p.name party_name,a.account_name FROM money_in m LEFT JOIN parties p ON p.id=m.party_id JOIN company_accounts a ON a.id=m.account_id ORDER BY m.receipt_date DESC,m.id DESC LIMIT 300`).all();
  const interestPayments=await d.prepare(`SELECT i.*,p.name party_name,a.account_name FROM interest_payments i LEFT JOIN parties p ON p.id=i.party_id JOIN company_accounts a ON a.id=i.account_id ORDER BY i.payment_date DESC,i.id DESC LIMIT 300`).all();
  const fundingLoans=await d.prepare(`SELECT l.*,p.name lender_party_name,(SELECT MIN(s.due_date) FROM funding_schedule s WHERE s.loan_id=l.id AND s.status IN ('DUE','PARTIAL')) next_due_date,(SELECT COALESCE(SUM(s.interest_amount-s.paid_amount),0) FROM funding_schedule s WHERE s.loan_id=l.id AND s.status IN ('DUE','PARTIAL')) outstanding_interest FROM funding_loans l LEFT JOIN parties p ON p.id=l.lender_party_id ORDER BY l.id DESC`).all();
  const fundingSchedule=await d.prepare(`SELECT s.*,l.loan_no,l.lender_name FROM funding_schedule s JOIN funding_loans l ON l.id=s.loan_id WHERE s.status IN ('DUE','PARTIAL') ORDER BY s.due_date,s.id`).all();
  const duePayables=await d.prepare(`SELECT p.id,p.sample_no,p.invoice_no,p.purchase_date,CASE WHEN COALESCE(p.payment_due_date,'')<>'' THEN p.payment_due_date ELSE date(p.purchase_date,'+'||p.payment_due_days||' days') END payment_due_date,p.net_payable,x.name party_name,COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.purchase_id=p.id),0) paid,p.net_payable-COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.purchase_id=p.id),0) due_amount FROM purchases p JOIN parties x ON x.id=p.party_id WHERE p.status='POSTED' AND p.payment_due_days>0 AND (CASE WHEN COALESCE(p.payment_due_date,'')<>'' THEN p.payment_due_date ELSE date(p.purchase_date,'+'||p.payment_due_days||' days') END) BETWEEN ? AND ? AND p.net_payable>COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.purchase_id=p.id),0) ORDER BY payment_due_date,p.id`).all(t,week);
  const dueReceivables=await d.prepare(`SELECT r.*,p.name party_name,pu.sample_no,pu.invoice_no supplier_invoice_no,CASE WHEN COALESCE(r.due_date,'')<>'' THEN r.due_date ELSE date(r.bill_date,'+'||r.due_days||' days') END due_date,r.receivable_amount-COALESCE(r.received_amount,0) outstanding FROM financing_receivables r JOIN parties p ON p.id=r.party_id JOIN purchases pu ON pu.id=r.purchase_id WHERE r.status='OPEN' AND r.due_days>0 AND (CASE WHEN COALESCE(r.due_date,'')<>'' THEN r.due_date ELSE date(r.bill_date,'+'||r.due_days||' days') END) BETWEEN ? AND ? ORDER BY (CASE WHEN COALESCE(r.due_date,'')<>'' THEN r.due_date ELSE date(r.bill_date,'+'||r.due_days||' days') END),r.id`).all(t,week);
  const todayPayable=duePayables.filter((x:any)=>x.payment_due_date===t); const tomorrowPayable=duePayables.filter((x:any)=>x.payment_due_date===tomorrow); const todayReceivable=dueReceivables.filter((x:any)=>x.due_date===t); const tomorrowReceivable=dueReceivables.filter((x:any)=>x.due_date===tomorrow);
  const stats=await d.prepare(`SELECT (SELECT COUNT(*) FROM parties WHERE active=1) parties,(SELECT COALESCE(SUM(net_payable),0) FROM purchases WHERE status='POSTED') purchases,(SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='POSTED') payments`).get() as any;
  stats.opening=(await d.prepare("SELECT COALESCE(SUM(CASE WHEN opening_balance_type='PAYABLE' THEN opening_balance ELSE -opening_balance END),0) v FROM parties").get() as any).v; const postedPayments=(await d.prepare("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE status='POSTED'").get() as any).v; stats.outstanding=stats.opening+stats.purchases-postedPayments;
  const profit=await d.prepare("SELECT COALESCE(SUM(CASE WHEN received_amount>0 THEN ((discount_amount+other_charges_profit) * received_amount / CASE WHEN receivable_amount=0 THEN 1 ELSE receivable_amount END) ELSE 0 END),0) gross_profit,COALESCE(SUM(CASE WHEN received_amount>0 THEN cost_amount * received_amount / CASE WHEN receivable_amount=0 THEN 1 ELSE receivable_amount END ELSE 0 END),0) cost,COALESCE(SUM(CASE WHEN received_amount>0 THEN received_amount ELSE 0 END),0) sales FROM financing_receivables").get() as any; const interestPaid=(await d.prepare("SELECT COALESCE(SUM(amount),0) v FROM interest_payments WHERE status='POSTED'").get() as any).v;
  const monthlyProfit=await d.prepare(`SELECT substr(r.bill_date,1,7) label,ROUND(SUM(CASE WHEN r.received_amount>0 THEN ((r.discount_amount+r.other_charges_profit)*r.received_amount/CASE WHEN r.receivable_amount=0 THEN 1 ELSE r.receivable_amount END) ELSE 0 END)-COALESCE((SELECT SUM(i.amount) FROM interest_payments i WHERE substr(i.payment_date,1,7)=substr(r.bill_date,1,7) AND i.status='POSTED'),0)) value FROM financing_receivables r GROUP BY substr(r.bill_date,1,7) ORDER BY label`).all();
  const monthlyCashIn=await d.prepare(`SELECT substr(t.transaction_date,1,7) label,ROUND(SUM(CASE WHEN t.transaction_type='CREDIT' THEN t.amount ELSE 0 END)) value FROM account_transactions t GROUP BY substr(t.transaction_date,1,7) ORDER BY label`).all();
  const fundingUpcoming=await d.prepare(`SELECT substr(due_date,1,7) label,ROUND(SUM(interest_amount-paid_amount)) value FROM funding_schedule WHERE status IN ('DUE','PARTIAL') GROUP BY substr(due_date,1,7) ORDER BY label LIMIT 12`).all();
  const fundingToday=fundingSchedule.filter((x:any)=>x.due_date===t); const fundingTomorrow=fundingSchedule.filter((x:any)=>x.due_date===tomorrow); const nextFunding=fundingSchedule[0]||null;
  const averageMonthlyProfit=monthlyProfit.length?Math.round(monthlyProfit.reduce((a:number,x:any)=>a+Number(x.value||0),0)/monthlyProfit.length):0; profit.interest_paid=interestPaid; profit.profit=profit.gross_profit-interestPaid; profit.margin=profit.sales?profit.profit/profit.sales*100:0;
  return NextResponse.json({thirdParties,parties,purchases,pendingPurchaseBills,payments,outstanding,ledger,unmatched,users,companies,sales,receivables,stats,settings,accounts,accountMovements,moneyIn,interestPayments,duePayables,dueReceivables,todayPayable,tomorrowPayable,todayReceivable,tomorrowReceivable,profit,fundingLoans,fundingSchedule,fundingToday,fundingTomorrow,nextFunding,averageMonthlyProfit,monthlyProfit,monthlyCashIn,fundingUpcoming});
 }catch(e:any){return NextResponse.json({error:e.message},{status:500})}
}
