# SOLIVY Finance v2.5.10

## Changes in this release
- Added a dedicated Withdrawal / Transfer module.
- Withdrawal records a DEBIT against the selected company bank/cash account.
- Transfer records a DEBIT from the source account and a CREDIT to the destination account.
- Source-account balance is checked server-side before either movement is posted.
- Added movement history with movement number, type, date, source, destination, amount, reference and narration.
- Added a global API overlay loader for POST/PUT/PATCH/DELETE API actions; it remains visible until the API response returns.
- Added Tailwind/CSS success and error toast feedback for API actions.
- Added inline action feedback near primary buttons in transaction/master modules.
- Existing vendor outstanding, balance, TDS, purchase, payment, receivable, funding and other financial logic from the supplied v2.5.9 balance-fix build is preserved.
