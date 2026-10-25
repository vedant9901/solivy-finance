# v2.5.73 — strict sync company binding

- The online pairing token is authorized against the exact online company ID and LIVE/TEST environment stored with that token.
- Before sending pending events, the offline sync route calls the token-authorized remote exchange endpoint and compares its registered company name with the selected local company name. A mismatch stops before pushing changes.
- Company IDs may differ between offline and online installations (for example offline ID 2 and online ID 3).
- `parties.source_company_name` is provenance metadata: `S M corporation` means that particular party record was originally mapped/imported from S M corporation. It does not mean the sync token points to S M corporation, and it must not be rewritten to AKSH ENTERPRISE merely because the record is stored in AKSH ENTERPRISE.
- The existing-party collision is handled separately by ID mapping; both the existing mapped party and incoming party must remain distinct.

This is a source candidate. Run automated checks and a staging test before production use.
