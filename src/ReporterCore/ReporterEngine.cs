namespace Ccusage.Reporter.Core;

/// <summary>
/// The headless reporter core: owns one scan/post pass (<see cref="RunOnceAsync"/>) and a watch loop
/// (<see cref="RunForeverAsync"/>) that honors <see cref="ReporterOptions.ResolvedIntervalSeconds"/>
/// and a <see cref="CancellationToken"/>. It RAISES structured <see cref="ReporterEvent"/>s instead of
/// touching the console, so any number of listeners — the console renderer, a GUI, a file logger —
/// can subscribe via the <see cref="Progress"/> event or the <see cref="Subscribe"/> /
/// <see cref="IObservable{T}"/> surface.
///
/// All original behavior is preserved: local de-dup, per-server state file, exponential-backoff retry,
/// batch size, and the exact <c>IngestBatch</c> payload + <c>X-Ingest-Key</c> auth (the raw key is
/// never emitted in any event).
/// </summary>
public sealed class ReporterEngine : IDisposable, IObservable<ReporterEvent>
{
    private readonly ReporterOptions _options;
    private readonly IngestClient _client;
    private readonly FileStateStore _store;
    private readonly LogScanner _scanner;
    private readonly List<IObserver<ReporterEvent>> _observers = new();
    private readonly object _gate = new();

    /// <summary>Raised for every progress event. Multiple handlers may attach (console AND GUI).</summary>
    public event Action<ReporterEvent>? Progress;

    public ReporterEngine(ReporterOptions options)
    {
        _options = options;
        _client = new IngestClient(options.Url!, options.Key!, options.ResolvedMachine);
        _store = FileStateStore.Load(options.ResolvedStatePath);
        _scanner = new LogScanner(_client, _store, options.ResolvedBatchSize, Emit);
    }

    /// <summary>The resolved configuration this engine is running with (no secrets surfaced by listeners).</summary>
    public ReporterOptions Options => _options;

    /// <summary>
    /// Run a single scan/post pass. Returns the <see cref="ScanSummary"/> on success. A fatal condition
    /// (e.g. a rejected ingest key) is surfaced as an <see cref="ReporterEventKind.Error"/> event and
    /// then rethrown as <see cref="FatalReporterException"/> so the caller can stop the loop; transient
    /// failures are surfaced as warnings and the pass returns null (retry next pass).
    /// </summary>
    public async Task<ScanSummary?> RunOnceAsync(bool once, CancellationToken ct)
    {
        Emit(ReporterEvent.PassStarted(once));
        try
        {
            var summary = await _scanner.ScanAsync(_options.ResolvedClaudePath, _options.ResolvedCodexPath, ct);

            if (summary.Unpriced.Count > 0)
                Emit(ReporterEvent.Warning(
                    $"{summary.Unpriced.Count} unpriced model(s): {string.Join(", ", summary.Unpriced.Take(6))}. " +
                    "Set rates on the Pricing page, then Recompute."));

            Emit(ReporterEvent.PassCompleted(summary));
            return summary;
        }
        catch (OperationCanceledException) { return null; }
        catch (FatalReporterException ex)
        {
            Emit(ReporterEvent.Error(ex.Message, ex));
            throw;
        }
        catch (Exception ex)
        {
            Emit(ReporterEvent.Warning($"pass failed: {ex.Message} (will retry)", ex));
            return null;
        }
    }

    /// <summary>
    /// Watch loop: run a pass, then idle for the configured interval, repeating until cancelled. A
    /// fatal pass stops the loop. Honors the token both during the pass and the idle delay.
    /// </summary>
    public async Task RunForeverAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await RunOnceAsync(once: false, ct); }
            catch (FatalReporterException) { return; } // already emitted Error; stop the loop

            if (ct.IsCancellationRequested) break;

            var next = DateTime.Now.AddSeconds(_options.ResolvedIntervalSeconds);
            Emit(ReporterEvent.Idle(next, _options.ResolvedIntervalSeconds));
            try { await Task.Delay(TimeSpan.FromSeconds(_options.ResolvedIntervalSeconds), ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    // ---- event fan-out ----

    private void Emit(ReporterEvent e)
    {
        Progress?.Invoke(e);

        IObserver<ReporterEvent>[] snapshot;
        lock (_gate) snapshot = _observers.ToArray();
        foreach (var o in snapshot)
        {
            try { o.OnNext(e); } catch { /* a misbehaving listener must not break the engine */ }
        }
    }

    /// <summary>IObservable surface so reactive listeners (e.g. a GUI) can subscribe.</summary>
    public IDisposable Subscribe(IObserver<ReporterEvent> observer)
    {
        lock (_gate) _observers.Add(observer);
        return new Unsubscriber(this, observer);
    }

    private sealed class Unsubscriber(ReporterEngine engine, IObserver<ReporterEvent> observer) : IDisposable
    {
        public void Dispose()
        {
            lock (engine._gate) engine._observers.Remove(observer);
        }
    }

    public void Dispose()
    {
        IObserver<ReporterEvent>[] snapshot;
        lock (_gate) { snapshot = _observers.ToArray(); _observers.Clear(); }
        foreach (var o in snapshot)
        {
            try { o.OnCompleted(); } catch { /* ignore */ }
        }
        _client.Dispose();
    }
}
