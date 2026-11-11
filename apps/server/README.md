# Streamix — the server

The small server behind the Streamix website and app: an About page, the legal
pages, error reports, remote config, live-caption keys, an optional demo
playlist and a small admin. It holds no channels and no one's provider
credentials.

Everything about running it — environment variables, Postgres, pm2 and Docker,
TLS, filling in the publisher details — is in [`docs/SERVER.md`](../../docs/SERVER.md).

```bash
pnpm install
cp .env.example .env     # fill it in
pnpm migrate             # create the tables
pnpm start
pnpm test && pnpm typecheck
```
