# SOLIVY Finance — Client Local Installation

## What the client needs

The client does **not** need Next.js or SQLite pre-installed.

`INSTALL-SOLIVY-LOCAL.bat`:

1. Checks for Node.js.
2. If Node.js is missing and Windows Package Manager (`winget`) is available, installs the Node.js LTS runtime.
3. Installs the application's pinned npm dependencies, including `better-sqlite3` (the SQLite engine is bundled by the native package; no separate SQLite server is required).
4. Asks the client where financial data should be stored.
5. Creates `.env.local` with that persistent location and a production session secret.
6. Runs the Next.js production build.
7. Creates a Desktop shortcut.

## Recommended data location

A default such as:

`C:\Users\<user>\AppData\Roaming\SOLIVY-FINANCE\data`

is suggested. The client can choose another folder, such as a dedicated `D:\SOLIVY-DATA` folder.

**Do not store the database inside the application folder.**

## Default company

Fresh installation creates **SOLIVY** as the initial company. The administrator can then create additional companies and users under Administration.

Default administrator:

- Username: `admin`
- Password: `admin123`

Change this immediately after the first login.

## Starting

After installation, use the Desktop shortcut or `START-SOLIVY-LOCAL.bat`.

The application runs locally at:

`http://localhost:3000`

## Purge

Purge is an administrator-only operation. The confirmation must exactly match:

- `PURGE TEST`
- `PURGE LIVE`

It clears transaction/master financial data from the selected company/environment but keeps the SQLite database file, company/admin configuration and application installation intact.

A purge should only be performed after downloading a backup.
