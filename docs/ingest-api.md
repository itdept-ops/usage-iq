# Ingest API

The reporter is just a client of two endpoints. This is the contract if you want to build your own
pusher (or integrate another tool).

## `POST /api/ingest`

Push a batch of parsed usage rows. Authenticated by an **ingest key**, not a user session.

- **Auth:** header `X-Ingest-Key: <raw key>`. No user JWT. Anonymous to the user-auth layer.
- **Content-Type:** `application/json`
- **Limits:** ≤ 5000 rows per request · ≤ 4 MB body · 600 requests/min per source IP.

### Request body

```jsonc
{
  "source": "claude",          // "claude" | "codex" (anything else → 400)
  "machine": "build-server",   // optional label; groups rows under a synthetic remote "file"
  "reporter": "my-tool/1.0",   // optional, informational
  "rows": [
    {
      "dedupKey":    "msg_abc123|req_def456", // REQUIRED, unique per billed turn
      "timestampUtc":"2026-06-15T17:03:41Z",  // REQUIRED, ISO 8601 UTC
      "model":       "claude-opus-4-8",       // REQUIRED
      "input":       1200,
      "output":      540,
      "cacheRead":   18000,
      "cache5m":     0,
      "cache1h":     0,
      "sessionId":   "ses_…",
      "cwd":         "/home/me/work/my-repo", // server derives the project from this
      "gitBranch":   "main",
      "isSidechain": false,
      "agentId":     null,
      "version":     "1.2.3"
    }
  ]
}
```

Property names are matched case-insensitively. The server is **authoritative and defensive**: it
clamps/validates every field, drops malformed rows (blank `dedupKey`/`model`/timestamp), clamps token
counts to a safe maximum, resolves the project from `cwd`, prices each row from the editable pricing
table, and de-dupes on `dedupKey` — so re-sending the same rows is idempotent.

### Response `200`

```json
{ "received": 1000, "inserted": 12, "duplicates": 980, "skipped": 8, "unpricedModels": ["some-model"] }
```

`received = inserted + duplicates + skipped`. `duplicates` already existed in the DB; `skipped` were
dropped (malformed or collapsed). `unpricedModels` lists models with no pricing row yet (set rates on
the Pricing page).

### Errors

| Status | When |
| --- | --- |
| `401` | Missing, invalid, or revoked ingest key. |
| `400` | Unknown `source`, or batch larger than 5000 rows. |
| `413` | Body larger than 4 MB. |
| `429` | Rate limit exceeded (back off and retry). |

### curl example

```bash
curl -sS https://usage.example.com/api/ingest \
  -H "X-Ingest-Key: uiq_xxxxxxxx…" -H "Content-Type: application/json" \
  -d '{"source":"claude","machine":"laptop","rows":[
        {"dedupKey":"msg_1|req_1","timestampUtc":"2026-06-15T17:03:41Z","model":"claude-opus-4-8",
         "input":1200,"output":540,"cacheRead":18000,"cwd":"/home/me/work/my-repo"}]}'
```

## Ingest key management

Requires a signed-in user with the `settings.manage` permission (managed in the **Reporter** page UI).

| Method | Route | Body / result |
| --- | --- | --- |
| `GET` | `/api/ingest-keys` | List keys: `id, name, prefix, createdUtc, createdByEmail, lastUsedUtc, lastUsedIp, revoked`. |
| `POST` | `/api/ingest-keys` | `{ "name": "laptop" }` → `{ id, name, prefix, key }`. The raw `key` is returned **once**. |
| `DELETE` | `/api/ingest-keys/{id}` | Revoke. Takes effect on the key's next request. |

Only the SHA-256 hash of a key is stored. The create response (and the `/api/ingest` body) are redacted
from the action log; `/api/ingest` is excluded from it entirely.

## Building your own reporter

- Produce rows in the `ParsedUsage` shape above. The shared `Ccusage.Ingestion` library
  (`src/Ingestion`) already parses Claude Code and Codex JSONL — reuse it, or implement your own.
- Make `dedupKey` stable and unique per billed turn (Claude uses `message.id + "|" + requestId`).
- De-dupe locally to save bandwidth (one turn spans several identical-key lines); the server de-dupes
  regardless, so correctness doesn't depend on it.
- Send `X-Ingest-Key`, chunk to ≤ 5000 rows, and stay under 600 requests/min.

See also: [Reporter](reporter.md) · [Cloud hosting](cloud-hosting.md) · [Configuration](configuration.md).
