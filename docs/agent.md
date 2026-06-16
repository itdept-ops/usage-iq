# Desktop agent (Windows)

The **Usage IQ Agent** (`UsageIq.Agent`) is a distributable Windows desktop app that does everything the
[console reporter](reporter.md) does — parse your Claude Code / Codex logs **locally** and push only the
parsed usage (token counts + metadata, **never** prompt or response text) — but lives quietly in the
**system tray** with a live activity view and a point-and-click Settings screen. It's the friendliest way
to keep usage flowing to a hosted Usage IQ dashboard from a workstation.

It is built on the same `Ccusage.Reporter.Core` engine as the console app and uses the **identical**
ingest contract (`POST /api/ingest` with the `X-Ingest-Key` header), so the two are interchangeable.

## What it gives you

- **System-tray presence.** A tray icon with a right-click menu — **Open**, **Pause/Resume**,
  **Sync now**, **Settings**, **Quit** — and a tooltip that shows live status
  (e.g. *"Usage IQ — synced 14.2M tokens"*). Double-click the icon to open the window.
- **Transparency-first window.** A live, scrolling, timestamped activity log bound to the engine's
  events: what's being scanned, and every POST (endpoint, row count, HTTP status, tokens synced). The
  ingest key is **never** shown. A status header tracks connection state, last sync, session
  tokens + cost, and a next-run countdown, with Pause/Resume + Sync-now buttons.
- **Settings screen.** Edit the server URL, sync interval, Claude/Codex paths, machine-name override,
  *start minimized*, and *run on sign-in* — then **Save**. The ingest key field is masked and writes to
  `~/.usage-iq/reporter.key`; everything else lands in `~/.usage-iq/config.json` (shared with the console
  reporter). *Run on sign-in* toggles the per-user `HKCU\…\Run` registry entry.
- **Minimize to tray.** Closing or minimizing the window hides it to the tray; the agent keeps syncing.
  Quit fully from the tray menu.

## Get your ingest token (self-service)

Each machine reports with its own **ingest key**. To mint one:

1. Open your dashboard and click **Reporter** in the top nav (requires the `settings.manage` permission).
   The agent's Settings screen has a **Reporter page** link that jumps straight there using your configured
   server URL.
2. Click **Generate key** and copy it immediately — it's shown once and stored only as a SHA-256 hash.
3. Paste it into the agent's **Settings → Ingest key** field and **Save**. Revoke anytime from the same
   page; revocation takes effect on the agent's next request.

## Build it

Requires the **.NET 9 SDK** on Windows (the app targets `net9.0-windows` and uses WPF, so it builds and
runs on Windows only).

```powershell
git clone https://github.com/itdept-ops/usage-iq && cd usage-iq
dotnet build src/Agent -c Release
# binary: src/Agent/bin/Release/net9.0-windows/UsageIq.Agent.exe
```

## Publish a distributable build

Produce a single, self-contained executable (no .NET install required on the target machine):

```powershell
dotnet publish src/Agent -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
# output: src/Agent/bin/Release/net9.0-windows/win-x64/publish/UsageIq.Agent.exe
```

Notes:

- The output folder also contains a few **native WPF support DLLs** (`wpfgfx_cor3.dll`,
  `PresentationNative_cor3.dll`, `D3DCompiler_47_cor3.dll`, `PenImc_cor3.dll`, `vcruntime140_cor3.dll`).
  Ship the whole `publish/` folder. To fold those into the single file too, add
  `-p:IncludeNativeLibrariesForSelfExtract=true` (the exe self-extracts them to a temp dir at launch).
- Self-contained builds are large (~140 MB) because they bundle the .NET + WindowsDesktop runtime. For a
  smaller download, drop `--self-contained` (or pass `--self-contained false`) and require the
  [.NET 9 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/9.0) on the target machine.
- Trimming (`-p:PublishTrimmed=true`) is **not** supported for WPF and will break the UI — don't enable it.

## Install & run

1. Copy `UsageIq.Agent.exe` (and its companion DLLs, if any) anywhere, e.g. `C:\Tools\UsageIqAgent\`.
2. Double-click it. On first launch the window opens with *"Not configured"* — click **Settings**.
3. Enter your **Server URL** (e.g. `https://usageiq.online`), paste your **ingest key**, optionally tweak
   the interval/paths/machine name, tick **Run on sign-in** and **Start minimized** if you like, then
   **Save**. The agent starts watching immediately and the live log lights up.
4. Close the window to tuck it into the tray. It keeps syncing; reopen from the tray icon anytime.

### Run at sign-in

Tick **Run on sign-in** in Settings — it writes a per-user entry to
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` that launches the agent with `--tray` (so it starts
hidden in the tray). No admin rights needed. Untick it to remove the entry.

### Command-line flags

The agent is configured through its UI, but two flags help with automation:

| Flag | Meaning |
| --- | --- |
| `--tray` | Start hidden in the tray (used by the run-at-sign-in entry; equivalent to *Start minimized*). |

All other configuration comes from `~/.usage-iq/config.json` + `~/.usage-iq/reporter.key`, exactly as the
console reporter resolves them — so a machine already set up with the console app is ready for the agent,
and vice versa.

## Where things live

| Path | What |
| --- | --- |
| `~/.usage-iq/config.json` | Non-secret settings (URL, interval, paths, machine, start-minimized, run-on-startup). Shared with the console reporter. |
| `~/.usage-iq/reporter.key` | The ingest key — a secret, written by the masked Settings field. Never stored in `config.json`. |
| `~/.usage-iq/reporter-state-*.json` | Per-server, per-file sync state so only changed files are re-read. |
| `HKCU\…\CurrentVersion\Run\UsageIqAgent` | The run-at-sign-in entry (present only when *Run on sign-in* is on). |

## How it works

The agent runs the `ReporterEngine` watch loop on a **background task** and subscribes to its structured
events. Each event is marshaled onto the WPF Dispatcher to update the live log, the status header, and the
tray tooltip — the UI thread is never blocked by a scan or a POST. **Sync now** runs an extra pass that's
serialized against the timed pass, and **Pause** cancels the loop cleanly (state is saved between flushes,
so nothing is lost). See the [Reporter guide](reporter.md#how-it-works) for the underlying scan/de-dup/
batching behavior — it's the same engine.

## Console vs. agent — which should I run?

| | [Console reporter](reporter.md) | Desktop agent |
| --- | --- | --- |
| Best for | servers, CI, headless boxes, cron/systemd | desktops/laptops, non-technical users |
| UI | terminal HUD | tray icon + window |
| Setup | CLI flags / env / config file | point-and-click Settings |
| Run at login | Task Scheduler / systemd | one checkbox |
| Engine + ingest contract | identical | identical |

See also: [Reporter](reporter.md) · [Cloud hosting](cloud-hosting.md) · [Ingest API](ingest-api.md) ·
[Configuration](configuration.md).
