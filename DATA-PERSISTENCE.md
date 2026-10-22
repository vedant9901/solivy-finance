# Data persistence

By default, financial data is stored outside the application folder:

- Windows: `%APPDATA%\AKSH-ENTERPRISE-FINANCE\data\`
- Linux/macOS: `~/.aksh-enterprise-finance/data/`

This means deleting, replacing, or extracting a new application build does **not** delete the database.

For server deployment, set `FINANCE_DATA_DIR` to a persistent mounted volume, for example `/data/finance`.

## First-run migration

If the previous version stored `live.db` / `test.db` inside the application's `data` folder, the first run of this version copies those files to the external persistent location. Keep the old folder until you have verified the migration.

## Backup recommendation

Use the Admin Backup Center before upgrades. For production, keep backups outside the server and test restoration regularly.
