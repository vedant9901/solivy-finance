# Production deployment

## Recommended online architecture

For a small/medium team, run one Next.js process on a VPS with persistent disk and SQLite WAL. Keep exactly one application replica because SQLite is file based.

For horizontal scaling, managed backups, and many concurrent users, migrate the database layer to PostgreSQL before adding multiple application replicas.

Do not deploy the SQLite data directory to a serverless ephemeral filesystem such as a typical Vercel deployment. The database must live on durable storage.

## Required environment variables

```env
NODE_ENV=production
SESSION_SECRET=<long-random-secret>
FINANCE_DATA_DIR=/data
```

Generate a secret with a password manager or a cryptographically secure random generator. Never commit it.

## Docker

```bash
cp .env.example .env
# edit .env and set SESSION_SECRET

docker compose up -d --build
```

The SQLite databases and admin database are stored in the persistent `finance_data` volume.

## Backups

Use the Admin -> Backup / Restore screen and download the **all companies** backup regularly. Keep a copy outside the server. Test restoration procedures before relying on the backup operationally.

## Security

- Use HTTPS at the reverse proxy.
- Set a unique `SESSION_SECRET`.
- Do not expose SQLite files over HTTP.
- Restrict the server firewall to the reverse proxy/required ports.
- Use strong unique passwords and deactivate users when they leave.
- Keep exactly one Node application replica with SQLite.
