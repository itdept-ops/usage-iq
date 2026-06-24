using System.IO;
using Ccusage.Reporter.Core;

namespace UsageIq.Agent.Services;

/// <summary>High-level run state of the agent, surfaced in the header + tray tooltip.</summary>
public enum AgentState
{
    /// <summary>No valid config yet (missing URL or key) — nothing is running.</summary>
    Unconfigured,
    /// <summary>Configured but the watch loop is not running (user paused, or never started).</summary>
    Paused,
    /// <summary>The watch loop is running; between passes it idles until the next scan.</summary>
    Running,
    /// <summary>A scan/post pass is actively in progress.</summary>
    Syncing,
    /// <summary>The engine stopped on a fatal condition (e.g. a rejected ingest key).</summary>
    Error,
}

/// <summary>Immutable snapshot of agent status for the header/tooltip. Raised on every change.</summary>
public sealed record AgentStatus
{
    public AgentState State { get; init; } = AgentState.Unconfigured;
    public string? ServerUrl { get; init; }
    public string Machine { get; init; } = Environment.MachineName;

    /// <summary>Combined tokens synced this session (sum of inserted-token deltas).</summary>
    public long SessionTokens { get; init; }
    /// <summary>Rows inserted this session.</summary>
    public int SessionRows { get; init; }
    /// <summary>Best-effort running session cost, if the server reports it.</summary>
    public decimal SessionCost { get; init; }

    public DateTime? LastSyncAt { get; init; }
    public DateTime? NextRunAt { get; init; }
    public int IntervalSeconds { get; init; }
    public string? LastError { get; init; }

    /// <summary>A short, human one-liner for the tray tooltip (≤ 63 chars to satisfy the WinForms limit).</summary>
    public string ToTooltip()
    {
        var head = State switch
        {
            AgentState.Unconfigured => "Usage IQ — not configured",
            AgentState.Paused => "Usage IQ — paused",
            AgentState.Running => $"Usage IQ — synced {FormatTokens(SessionTokens)} tokens",
            AgentState.Syncing => "Usage IQ — syncing…",
            AgentState.Error => "Usage IQ — error (see window)",
            _ => "Usage IQ",
        };
        return head.Length <= 63 ? head : head[..63];
    }

    /// <summary>Compact token formatting: 842, 12.3K, 4.21M, 1.05B (mirrors the console HUD).</summary>
    public static string FormatTokens(long n)
    {
        if (n < 1000) return n.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (n < 1_000_000) return (n / 1000.0).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture) + "K";
        if (n < 1_000_000_000) return (n / 1_000_000.0).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + "M";
        return (n / 1_000_000_000.0).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + "B";
    }
}

/// <summary>
/// One ingest source's at-a-glance state for the desktop UI: which tool, where it reads from, whether
/// that path exists on THIS machine, and how many rows it has contributed this session. Surfaced in the
/// main window's "Data sources" panel so Claude, Codex and Gemini/Antigravity are each visible + auditable.
/// </summary>
public sealed record SourceInfo(string Kind, string Display, string Path, bool Present, int RowsThisSession)
{
    /// <summary>A short human status: the absent reason, or this source's live row contribution.</summary>
    public string Status => !Present
        ? "not found on this machine"
        : RowsThisSession > 0
            ? $"{RowsThisSession.ToString("N0", System.Globalization.CultureInfo.InvariantCulture)} rows this session"
            : "ready — watching for new logs";
}

/// <summary>
/// Owns the <see cref="ReporterEngine"/> lifecycle for the desktop agent: start/stop the watch loop,
/// pause/resume, and an on-demand single pass ("Sync now"). It runs the engine on a background task,
/// subscribes to its <see cref="ReporterEvent"/>s, and re-raises two coarse signals — <see cref="Log"/>
/// (one line per event) and <see cref="StatusChanged"/> (an <see cref="AgentStatus"/> snapshot) — that
/// the UI marshals onto the Dispatcher. It never surfaces the ingest key. The controller itself does no
/// UI threading; callers are responsible for marshaling (see MainWindow).
/// </summary>
public sealed class AgentController : IDisposable
{
    private readonly object _gate = new();

    private ReporterOptions? _options;
    private ReporterEngine? _engine;
    private CancellationTokenSource? _loopCts;
    private Task? _loopTask;

    // 0 until the one-time GpsLocator.FixAcquired hook is installed (guards against re-subscribing per build).
    private int _gpsHookInstalled;

    // Guards against two passes overlapping (e.g. "Sync now" while the watch loop is mid-pass).
    private readonly SemaphoreSlim _passLock = new(1, 1);

    private AgentStatus _status = new();

    // Rows each source (claude/codex/gemini) has contributed this session, keyed by kind. Guarded by _gate.
    private readonly Dictionary<string, int> _sessionRowsBySource = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>One log line per reporter event. Raised on a background thread — marshal before touching UI.</summary>
    public event Action<LogLine>? Log;

    /// <summary>A new status snapshot. Raised on a background thread — marshal before touching UI.</summary>
    public event Action<AgentStatus>? StatusChanged;

    /// <summary>The per-source breakdown changed (paths/presence, or a source's session rows). Background thread.</summary>
    public event Action<IReadOnlyList<SourceInfo>>? SourcesChanged;

    /// <summary>The latest status snapshot (thread-safe read).</summary>
    public AgentStatus Status { get { lock (_gate) return _status; } }

    public bool IsRunning { get { lock (_gate) return _loopTask is { IsCompleted: false }; } }

    /// <summary>
    /// Snapshot the three ingest sources (Claude, Codex, Gemini/Antigravity) with their resolved paths,
    /// whether each exists on THIS machine, and the rows each has contributed this session. Cheap (three
    /// directory probes); safe to call from the UI on any refresh.
    /// </summary>
    public IReadOnlyList<SourceInfo> GetSources()
    {
        ReporterOptions opt;
        Dictionary<string, int> rows;
        lock (_gate)
        {
            opt = _options ?? new ReporterOptions();
            rows = new Dictionary<string, int>(_sessionRowsBySource, StringComparer.OrdinalIgnoreCase);
        }

        SourceInfo Make(string kind, string display, string path)
        {
            var present = !string.IsNullOrWhiteSpace(path) && Directory.Exists(path);
            rows.TryGetValue(kind, out var n);
            return new SourceInfo(kind, display, path, present, n);
        }

        return new[]
        {
            Make("claude", "Claude Code", opt.ResolvedClaudePath),
            Make("codex", "Codex", opt.ResolvedCodexPath),
            Make("gemini", "Gemini / Antigravity", opt.ResolvedGeminiPath),
        };
    }

    private void EmitSources() => SourcesChanged?.Invoke(GetSources());

    /// <summary>
    /// (Re)load configuration from disk and rebuild the engine. Stops any running loop first. Does NOT
    /// auto-start watching — call <see cref="Start"/>. Returns the resolved options so the UI can show
    /// whether the config validates.
    /// </summary>
    public ReporterOptions Reload()
    {
        Stop();

        // valuedArgs empty: the desktop app is driven entirely by config.json + reporter.key, not CLI.
        // A corrupt/unreadable config.json must never take the agent down — fall back to empty defaults
        // (the app shows "not configured" and Settings can fix it) rather than throwing out of startup.
        ReporterOptions opt;
        try
        {
            opt = ReporterConfig.Load(Array.Empty<string>());
        }
        catch (Exception ex)
        {
            opt = new ReporterOptions();
            Emit(LogLine.Warn($"could not load configuration ({ex.Message}) — open Settings to reconfigure"));
        }

        // This is the WPF tray app: report machineInfo.agent = "desktop" (the console leaves the default).
        opt.ClientKind = "desktop";

        lock (_gate)
        {
            _options = opt;
            DisposeEngine();

            var invalid = opt.Validate();
            if (invalid is null)
                _engine = BuildEngine(opt);

            _status = _status with
            {
                State = invalid is null ? AgentState.Paused : AgentState.Unconfigured,
                ServerUrl = opt.Url,
                Machine = opt.ResolvedMachine,
                IntervalSeconds = opt.ResolvedIntervalSeconds,
                NextRunAt = null,
                LastError = invalid is null ? null : invalid,
            };
        }
        EmitStatus();
        Emit(LogLine.Info(_options is { } o && o.Validate() is null
            ? $"configuration loaded — {o.Url} as {o.ResolvedMachine}"
            : "configuration incomplete — open Settings to add the server URL and ingest key"));
        EmitSources(); // publish the now-resolved source paths + presence to the UI
        return opt;
    }

    private ReporterEngine BuildEngine(ReporterOptions opt)
    {
        // Inject the desktop agent's precise-GPS provider (Windows.Devices.Geolocation, consented +
        // graceful-null). It is NON-BLOCKING: the first invoke returns null and gathers in the background,
        // so constructing the engine on the UI thread never stalls (a sync GPS wait there deadlocks the
        // dispatcher and freezes the app). When a fix lands we rebuild the engine so its MachineInfo carries
        // the coordinates. On denial/failure the provider stays null and the server uses coarse IP-geo.
        ReporterEngine.GpsProvider = GpsLocator.TryGetFix;
        if (Interlocked.Exchange(ref _gpsHookInstalled, 1) == 0)
            GpsLocator.FixAcquired += OnGpsFixAcquired;

        var engine = new ReporterEngine(opt);
        engine.Progress += OnEngineEvent;
        return engine;
    }

    /// <summary>
    /// A deferred GPS fix arrived (on a background thread). Rebuild the engine so its freshly-gathered
    /// MachineInfo now includes the coordinates, preserving the running/paused state. Runs entirely off the
    /// UI thread, so it never re-introduces the startup freeze.
    /// </summary>
    private void OnGpsFixAcquired() => Task.Run(() =>
    {
        ReporterOptions? opt;
        bool wasRunning;
        lock (_gate)
        {
            opt = _options;
            wasRunning = _loopTask is { IsCompleted: false };
        }
        if (opt is null || opt.Validate() is not null) return;

        Stop(keepEngine: false);                  // unwind the loop + dispose the coordinate-less engine
        ReporterEngine.ResetMachineInfoCache();   // forget the GPS-less machine info
        lock (_gate) _engine = BuildEngine(opt);  // rebuild → MachineInfo now carries the cached fix
        if (wasRunning) Start();
        Emit(LogLine.Info("location fix acquired — telemetry now includes precise GPS"));
    });

    /// <summary>Start watching (the engine's RunForever loop) on a background task. No-op if already running.</summary>
    public void Start()
    {
        lock (_gate)
        {
            if (_engine is null || _options is null) { Emit(LogLine.Warn("cannot start — configuration is incomplete")); return; }
            if (_loopTask is { IsCompleted: false }) return;

            _loopCts = new CancellationTokenSource();
            var ct = _loopCts.Token;
            var engine = _engine;

            _status = _status with { State = AgentState.Running, LastError = null };

            _loopTask = Task.Run(() => WatchLoopAsync(engine, ct), ct);
        }
        EmitStatus();
        Emit(LogLine.Info("watching started"));
    }

    /// <summary>
    /// The watch loop, reimplemented here (rather than ReporterEngine.RunForeverAsync) so that an
    /// on-demand "Sync now" can interleave with the timed passes under a shared pass lock, and so the
    /// agent reports Running/Syncing transitions cleanly. Honors cancellation in both pass and idle.
    /// </summary>
    private async Task WatchLoopAsync(ReporterEngine engine, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var fatal = await RunPassAsync(engine, once: false, ct);
            if (fatal || ct.IsCancellationRequested) return;

            var interval = engine.Options.ResolvedIntervalSeconds;
            var next = DateTime.Now.AddSeconds(interval);
            SetStatus(s => s with { State = AgentState.Running, NextRunAt = next });

            try { await Task.Delay(TimeSpan.FromSeconds(interval), ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>Run exactly one scan/post pass under the pass lock. Returns true if it ended fatally.</summary>
    private async Task<bool> RunPassAsync(ReporterEngine engine, bool once, CancellationToken ct)
    {
        await _passLock.WaitAsync(ct);
        try
        {
            SetStatus(s => s with { State = AgentState.Syncing });
            await engine.RunOnceAsync(once, ct);
            return false;
        }
        catch (FatalReporterException ex)
        {
            SetStatus(s => s with { State = AgentState.Error, LastError = ex.Message });
            return true; // the watch loop should stop
        }
        catch (OperationCanceledException) { return false; }
        finally { _passLock.Release(); }
    }

    /// <summary>
    /// Run a single pass on demand ("Sync now"). If the watch loop is running, this borrows the same
    /// engine and the pass lock serializes it against the timed pass; if paused, it spins up a one-shot
    /// pass without starting the loop.
    /// </summary>
    public void SyncNow()
    {
        ReporterEngine? engine;
        lock (_gate) engine = _engine;
        if (engine is null) { Emit(LogLine.Warn("cannot sync — configuration is incomplete")); return; }

        Emit(LogLine.Info("manual sync requested"));
        _ = Task.Run(async () =>
        {
            // The manual pass gets its own cancellation source (race-free vs. a concurrent Stop disposing
            // the loop's CTS). The pass lock serializes it against any in-flight timed pass.
            using var localCts = new CancellationTokenSource();
            var wasRunning = IsRunning;
            await RunPassAsync(engine, once: !wasRunning, localCts.Token);
            // If we're not in the watch loop, restore the resting state afterwards.
            if (!wasRunning) SetStatus(s => s with { State = AgentState.Paused });
        });
    }

    /// <summary>Stop the watch loop and wait briefly for it to unwind. Leaves the engine built so Start can resume.</summary>
    public void Pause()
    {
        Stop(keepEngine: true);
        SetStatus(s => s with
        {
            State = s.State == AgentState.Error ? AgentState.Error : AgentState.Paused,
            NextRunAt = null,
        });
        Emit(LogLine.Info("watching paused"));
    }

    /// <summary>Resume watching after a pause.</summary>
    public void Resume() => Start();

    /// <summary>Stop the loop (used by Pause and on shutdown). Optionally keep the engine for a later resume.</summary>
    public void Stop(bool keepEngine = false)
    {
        CancellationTokenSource? cts;
        Task? task;
        lock (_gate)
        {
            cts = _loopCts; _loopCts = null;
            task = _loopTask; _loopTask = null;
        }

        try { cts?.Cancel(); } catch { /* already disposed */ }
        try { task?.Wait(TimeSpan.FromSeconds(5)); } catch { /* canceled / timed out */ }
        cts?.Dispose();

        if (!keepEngine)
            lock (_gate) DisposeEngine();
    }

    // ---- engine event → log line + status snapshot ----

    private void OnEngineEvent(ReporterEvent e)
    {
        // 1) Surface a clean, timestamped log line for the live view (raw key never present in events).
        Emit(LogLine.FromEvent(e));

        // 2) Fold the event into the running status snapshot.
        switch (e.Kind)
        {
            case ReporterEventKind.TokensSynced:
                SetStatus(s => s with
                {
                    SessionTokens = s.SessionTokens + Math.Max(0, e.TokenDelta),
                    SessionCost = s.SessionCost + e.Cost,
                });
                break;

            case ReporterEventKind.BatchPosted:
                SetStatus(s => s with { SessionRows = s.SessionRows + e.Inserted });
                break;

            case ReporterEventKind.RowsFound:
                // Tally this source's discovered rows so the Data Sources panel shows live per-source pull.
                if (!string.IsNullOrEmpty(e.Source) && e.RowsFoundCount > 0)
                {
                    lock (_gate)
                    {
                        _sessionRowsBySource.TryGetValue(e.Source, out var prev);
                        _sessionRowsBySource[e.Source] = prev + e.RowsFoundCount;
                    }
                    EmitSources();
                }
                break;

            case ReporterEventKind.PassCompleted:
                SetStatus(s => s with { LastSyncAt = e.Timestamp });
                break;

            case ReporterEventKind.Idle:
                SetStatus(s => s with { State = AgentState.Running, NextRunAt = e.NextRunAt });
                break;

            case ReporterEventKind.Error:
                SetStatus(s => s with { State = AgentState.Error, LastError = e.Message });
                break;
        }
    }

    // ---- status helpers ----

    private void SetStatus(Func<AgentStatus, AgentStatus> mutate)
    {
        lock (_gate) _status = mutate(_status);
        EmitStatus();
    }

    private void EmitStatus()
    {
        AgentStatus snapshot;
        lock (_gate) snapshot = _status;
        StatusChanged?.Invoke(snapshot);
    }

    private void Emit(LogLine line) => Log?.Invoke(line);

    private void DisposeEngine()
    {
        if (_engine is not null)
        {
            _engine.Progress -= OnEngineEvent;
            _engine.Dispose();
            _engine = null;
        }
    }

    public void Dispose()
    {
        Stop();
        _passLock.Dispose();
    }
}
