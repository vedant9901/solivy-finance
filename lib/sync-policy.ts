/**
 * Conflict policy for synchronization (v2.7.0).
 * Master/reference data keeps the deterministic field-level merge (both sides converge and both
 * values are kept in sync_conflict_history). For tables that carry money, quantities or posting
 * state, a field changed differently on both sides is NOT auto-resolved: it raises a conflict
 * handled by the existing per-record resolution workflow (push / accept online / defer).
 */
export const FINANCIAL_SYNC_TABLES = new Set([
  'purchases', 'payments', 'payment_allocations', 'account_transactions', 'financing_receivables', 'tds_credit_entries',
  'money_in', 'money_out', 'interest_payments', 'sales', 'ledger', 'funding_loans', 'funding_schedule', 'funding_loan_transfers',
  'account_movements', 'company_accounts', 'inventory_lots', 'saudas', 'sauda_allocations', 'bank_matches', 'bank_statement_rows', 'budgets',
]);

export function financialConflictError(table: string, primaryKey: any, base: any, current: any, incoming: any, fieldConflicts: Array<{ field: string }>) {
  const fields = fieldConflicts.map((c) => c.field).join(', ');
  return Object.assign(new Error(`Conflict on ${table}: both sides changed ${fields}. Financial records are never merged automatically — choose which version to keep.`), {
    conflictDetail: { table, primary_key: primaryKey, reason: `Both devices changed the same financial field(s): ${fields}. Choose the correct version (push this device, accept online) or defer.`, base, current, incoming, field_conflicts: fieldConflicts },
  });
}
