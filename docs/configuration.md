# Configuration

## API

Set via `.env`, container environment variables, or `src/Api/appsettings.json`. Use a double underscore
(`__`) for nesting in env-var names (e.g. `Ingestion__DisplayTimeZone`).

| Key | Default | Meaning |
| --- | --- | --- |
| `ConnectionStrings__Default` | `Host=localhost;Port=5433;…` | PostgreSQL connection string. |
| `Ingestion__ClaudeProjectsPath` | `<UserProfile>/.claude/projects` | Local Claude Code logs (local sync only). |
| `Ingestion__CodexPath` | `<UserProfile>/.codex` | Local Codex logs (local sync only). |
| `Ingestion__DisplayTimeZone` | `America/New_York` | IANA zone for day/month bucketing. |
| `AutoSync__Enabled` | `true` | Run the background local-file sync on a timer. Set `false` for cloud (reporters ingest). |
| `AutoSync__IntervalSeconds` | `300` | Local auto-sync cadence (min 30). |
| `Cors__AllowedOrigin` | `http://localhost:4200` | The dashboard's web origin. |

### Secrets — `src/Api/appsettings.Local.json` (git-ignored, baked into the image at build)

| Key | Meaning |
| --- | --- |
| `Jwt:Key` | App JWT signing key. **Required, ≥ 32 bytes** — the API refuses to start without a strong one. Also derives the share-token encryption key. |
| `Jwt:Issuer`, `Jwt:Audience` | Token issuer/audience (default `usage-iq`). |
| `Google:ClientId`, `Google:ClientSecret` | Google OAuth client. Add the dashboard origin to the client's *Authorized JavaScript origins*. |
| `Auth:AdminEmails` | Bootstrap admins (full permissions, can't be locked out). Created once if absent. |
| `Auth:AllowedEmails` | Seeded once as dashboard viewers. Manage everyone else from the **Users** page. |

A committed `appsettings.Local.example.json` documents the shape. Never commit the real file.

## Reporter

Resolution order (highest priority last): `appsettings.json` beside the exe → `REPORTER_*` env vars →
command-line flags.

| Flag | Env var | appsettings key | Default |
| --- | --- | --- | --- |
| `--url` | `REPORTER_URL` | `Url` | — (required) |
| `--key` | `REPORTER_KEY` | `Key` | — (required, secret) |
| `--machine` | `REPORTER_MACHINE` | `Machine` | OS hostname |
| `--claude-path` | `REPORTER_CLAUDEPATH` | `ClaudePath` | `~/.claude/projects` |
| `--codex-path` | `REPORTER_CODEXPATH` | `CodexPath` | `~/.codex` |
| `--state` | `REPORTER_STATEPATH` | `StatePath` | `~/.usage-iq/reporter-state.json` |
| `--batch` | `REPORTER_BATCHSIZE` | `BatchSize` | `500` (clamped 1–5000) |
| `--interval` | `REPORTER_INTERVALSECONDS` | `IntervalSeconds` | `60` (clamped 5–3600) |
| `--once` | — | — | off (watches by default) |

Example `appsettings.json` (next to `usage-iq-reporter`):

```json
{ "Url": "https://usage.example.com", "Machine": "build-server", "BatchSize": 1000 }
```

Keep the key out of source control. The Windows [`Run-UsageIqReporter.ps1`](../Run-UsageIqReporter.ps1)
launcher can store it in a `reporter.key` file beside the script instead of passing it on the command
line — treat that file like a password.

See also: [Reporter](reporter.md) · [Cloud hosting](cloud-hosting.md) · [Ingest API](ingest-api.md).
