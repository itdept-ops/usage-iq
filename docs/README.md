# Usage IQ documentation

Guides for running and extending Usage IQ — a self-hosted dashboard for AI coding-agent
(Claude Code + OpenAI Codex) token usage.

| Guide | What's in it |
| --- | --- |
| [Reporter](reporter.md) | Stream usage from any machine to a hosted dashboard: install, run, flags, the PowerShell launcher, run-as-a-service, and troubleshooting. |
| [Cloud hosting](cloud-hosting.md) | Host the API + database in the cloud — deploy, secrets, reverse proxy + TLS, CORS, and a security checklist. |
| [Ingest API](ingest-api.md) | The `POST /api/ingest` contract and ingest-key management — for building your own reporter. |
| [Configuration](configuration.md) | Every API and reporter setting (env vars, flags, where secrets live). |

New here? Start with the root [README](../README.md) for the architecture and a local quick start.
The two ways data gets in:

- **Local sync** (default) — the API reads `~/.claude/projects` and `~/.codex` off local disk on a timer.
- **Remote reporter** — for cloud hosting: a small console app parses logs on your workstation and
  pushes only parsed usage to the API. See [Reporter](reporter.md) and [Cloud hosting](cloud-hosting.md).
