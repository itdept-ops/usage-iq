# Cloud hosting

By default the API reads the JSONL logs off local disk. To run the **API and database in the cloud**
instead, host them somewhere always-on and let a [reporter](reporter.md) on each workstation push usage
in. Nothing but parsed token counts/metadata leaves your machines.

```
┌─────────── your machines ───────────┐        ┌──────────────── cloud ────────────────┐
│  ~/.claude/projects   ~/.codex       │        │   TLS proxy (nginx/Caddy/Traefik/LB)   │
│        └─► usage-iq-reporter ──HTTPS──┼────────┼─► Usage IQ API (:8080) ─► PostgreSQL   │
│             (parses locally)         │        │     prices · resolves · de-dupes       │
└──────────────────────────────────────┘        └────────────────────────────────────────┘
```

## 1. Provision

- **Database** — a managed PostgreSQL 16 (or the bundled `db` compose service on a VM). Keep it on a
  private network; never expose 5432 publicly.
- **Compute** — a small VM or container host. The full stack is `web` (nginx serving the SPA + proxying
  `/api`), `api` (.NET 9), and `db`.

## 2. Configure secrets

Secrets live in `src/Api/appsettings.Local.json` (git-ignored, baked into the API image at build) — or
inject them as environment variables. At minimum:

```jsonc
{
  "Jwt": { "Key": "<a strong 32+ byte random string>", "Issuer": "usage-iq", "Audience": "usage-iq" },
  "Google": { "ClientId": "<oauth-client-id>.apps.googleusercontent.com", "ClientSecret": "<secret>" },
  "Auth": { "AdminEmails": ["you@example.com"], "AllowedEmails": [] },
  "ConnectionStrings": { "Default": "Host=db;Port=5432;Database=ccusage;Username=ccusage;Password=<pw>" }
}
```

The API **refuses to start** with a missing/weak `Jwt:Key`. Add your dashboard's public origin to the
Google OAuth client's *Authorized JavaScript origins*. See [Configuration](configuration.md) for the
full list.

## 3. Deploy

```bash
docker compose --profile full up -d --build
```

Cloud-specific settings (env vars on the `api` service):

| Setting | Why |
| --- | --- |
| `ConnectionStrings__Default` | Point at your managed Postgres. |
| `Cors__AllowedOrigin` | Your dashboard's public origin, e.g. `https://usage.example.com`. |
| `AutoSync__Enabled=false` | There are no local logs to sync in the cloud — reporters do the ingest. (Harmless if left on; it just finds nothing.) |

## 4. TLS + reverse proxy

Terminate HTTPS at a proxy (nginx, Caddy, Traefik, or a cloud load balancer) and forward to the stack.
The API already honors `X-Forwarded-For`/`X-Forwarded-Proto` from the proxy hop (trusting the private
container networks), so per-IP rate limits and the logged client IP reflect the real caller. Example
Caddy:

```caddyfile
usage.example.com {
    reverse_proxy localhost:4200   # the web container (SPA + /api proxy)
}
```

HTTPS matters for reporters: the ingest key is a bearer credential. Over `http://` to a non-local host
it travels in cleartext (the reporter warns), so always use `https://` for a remote server.

## 5. Connect reporters

1. Sign in, open **Reporter**, generate an ingest key per machine (or per person).
2. On each workstation, run the reporter against your public URL — see [Reporter](reporter.md).

## Security checklist

- [ ] Strong, unique `Jwt:Key`; rotate if it was ever shared.
- [ ] HTTPS everywhere; HTTP only for `localhost`.
- [ ] Database on a private network; strong password; backups on.
- [ ] Google OAuth origins limited to your real dashboard URL(s).
- [ ] Bootstrap admin set via `Auth:AdminEmails`; manage everyone else from the **Users** page.
- [ ] One ingest key per machine, so you can revoke a single machine without disrupting others.
- [ ] Ingest keys and webhook URLs are stored hashed/masked and redacted from the action log — keep the
      raw values (and `reporter.key` / `appsettings.Local.json`) private.

See also: [Reporter](reporter.md) · [Ingest API](ingest-api.md) · [Configuration](configuration.md).
