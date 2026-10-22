# SOLIVY Finance v2.5.9

Fixes included:
- Purchase CSV can create a financing receivable with Receivable Party Name, Receivable After (Days), Receivable Due Date and Receivable Notes.
- Purchase edit now loads and preserves financing-receivable party/date/notes.
- Money In and Interest Paid reversal buttons receive the database mode correctly; removes the `mode is not defined` browser error.
- Money In imports can resolve the bank/cash account from Account Name or Party Name and record the incoming account entry as DEBIT; party-linked imports also create the party ledger debit entry.
- Account balance calculation recognizes MONEY_IN debit entries as inflows while preserving existing payment/interest semantics.
- Active Funding has an Edit action; loan start/first payment date and interest terms can be changed. If interest has already been paid, changing schedule-affecting terms is blocked until the paid interest is reversed.
