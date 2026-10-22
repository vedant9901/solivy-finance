# SOLIVY Finance v2.5.37 — Party Aliases Sidebar & Records

- Keeps a persistent desktop sidebar on the Party Aliases route.
- Adds a mobile slide-in navigation drawer so the user can return to existing modules without losing navigation.
- Separates existing Party ledger aliases from the Third Parties directory using tabs.
- Shows existing party names and party types in the alias selector; third-party records are displayed separately.
- Uses the selected company/environment headers for API reads and alias mutations.

Validation note: source changes and ZIP integrity should be checked; a full production build and end-to-end SQLite/PostgreSQL tests are not claimed unless run in the target environment.
