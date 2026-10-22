# Automatic TDS Decision Engine

This build uses a rule-driven TDS assistant for common resident-payee cases. It is deliberately conservative: when facts cannot safely be inferred, it shows REVIEW instead of inventing a deduction.

## Inputs used
- Payment/credit date
- Party nature: Goods Vendor, Contractor, Professional, Commission/Brokerage, Interest, Rent, Other
- Resident/non-resident status
- PAN availability/status
- Company deductor type
- Preceding financial-year turnover
- FY aggregate amount recorded for the party
- Exemption/lower/nil deduction configuration

## 2026 transition
For sums credited/paid on or before 31 March 2026, the Income-tax Act, 1961 applies. For sums credited/paid on or after 1 April 2026, the Income-tax Act, 2025 applies. Post-1-Apr-2026 TDS reporting should use the relevant Section 393 table item rather than old section numbers.

## Common rules implemented
- Goods purchase: checks the buyer turnover > INR 10 crore condition and the INR 50 lakh aggregate purchase threshold; rate 0.1% when applicable, with a higher-rate review when PAN is unavailable/invalid.
- Contractor: checks INR 30,000 single-payment and INR 1,00,000 aggregate thresholds; rate 1% for individual/HUF payee and 2% for other payees when the payer is a specified person.
- Commission/brokerage: checks INR 20,000 annual threshold; rate 2% when applicable.
- Professional fee: checks INR 50,000 annual threshold; rate 10% when applicable.
- Interest: uses a conservative configurable resident-payee rule and flags payer/payee-specific cases for review.
- Rent: always flags for review because property type, payer category and transaction facts affect the rule.

## Important
This is compliance assistance, not a statutory filing engine or CA substitute. Certificates, declarations, special exemptions, non-resident payments, lower/nil deduction certificates and other special cases can change the result. The payment screen shows the exact rule/reason and whether review is required.
