using Ccusage.Reporter;
using Microsoft.Extensions.Configuration;

// ---- flags (separated so the valued-option parser below never sees a bare flag) ----
var flagSet = new HashSet<string>(args, StringComparer.OrdinalIgnoreCase);
var once = flagSet.Contains("--once");
var wantsHelp = flagSet.Contains("--help") || flagSet.Contains("-h") || args.Length == 0;

if (wantsHelp)
{
    PrintUsage();
    return args.Length == 0 ? 1 : 0;
}

var valued = args.Where(a => a is not ("--once" or "--watch" or "--help" or "-h")).ToArray();

var switchMappings = new Dictionary<string, string>
{
    ["--url"] = "Url", ["-u"] = "Url",
    ["--key"] = "Key", ["-k"] = "Key",
    ["--machine"] = "Machine", ["-m"] = "Machine",
    ["--claude-path"] = "ClaudePath",
    ["--codex-path"] = "CodexPath",
    ["--state"] = "StatePath",
    ["--batch"] = "BatchSize",
    ["--interval"] = "IntervalSeconds",
};

ReporterOptions opt;
try
{
    var config = new ConfigurationBuilder()
        .AddJsonFile(Path.Combine(AppContext.BaseDirectory, "appsettings.json"), optional: true)
        .AddEnvironmentVariables("REPORTER_")
        .AddCommandLine(valued, switchMappings)
        .Build();
    opt = config.Get<ReporterOptions>() ?? new ReporterOptions();
}
catch (Exception ex)
{
    Console.Error.WriteLine($"Could not read configuration: {ex.Message}");
    PrintUsage();
    return 2;
}

var invalid = opt.Validate();
if (invalid is not null)
{
    Console.Error.WriteLine($"Configuration error: {invalid}");
    PrintUsage();
    return 2;
}

// The ingest key is a bearer secret; over plain http to a non-local host it travels in cleartext.
if (Uri.TryCreate(opt.Url, UriKind.Absolute, out var parsed) && parsed.Scheme == "http" && !parsed.IsLoopback)
    Console.Error.WriteLine("WARNING: --url is http:// to a non-local host — the ingest key is sent in cleartext. Use https.");

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); Log("Shutting down…"); };

Log($"Usage IQ reporter → {opt.Url}  (machine: {opt.ResolvedMachine})");
Log($"  Claude: {opt.ResolvedClaudePath}");
Log($"  Codex:  {opt.ResolvedCodexPath}");
Log($"  State:  {opt.ResolvedStatePath}");
Log(once ? "Mode: one-shot" : $"Mode: watch (every {opt.ResolvedIntervalSeconds}s) — Ctrl+C to stop");

using var client = new IngestClient(opt.Url!, opt.Key!, opt.ResolvedMachine);
var store = FileStateStore.Load(opt.ResolvedStatePath);
var scanner = new LogScanner(client, store, opt.ResolvedBatchSize, Log);

if (once)
    return await RunPassAsync();

while (!cts.IsCancellationRequested)
{
    var code = await RunPassAsync();
    if (code == 1) return 1; // fatal (e.g. rejected key) — stop the loop
    try { await Task.Delay(TimeSpan.FromSeconds(opt.ResolvedIntervalSeconds), cts.Token); }
    catch (TaskCanceledException) { break; }
}
return 0;

async Task<int> RunPassAsync()
{
    try
    {
        var s = await scanner.ScanAsync(opt.ResolvedClaudePath, opt.ResolvedCodexPath, cts.Token);
        var changed = s.FilesParsed > 0 || s.Inserted > 0;
        if (changed || once)
            Log($"Scanned {s.FilesScanned} files ({s.FilesSkipped} unchanged), {s.FilesParsed} parsed → " +
                $"{s.Inserted} new, {s.Duplicates} dup, {s.Skipped} skipped of {s.Received} sent.");
        if (s.Unpriced.Count > 0)
            Log($"  Note: {s.Unpriced.Count} unpriced model(s): {string.Join(", ", s.Unpriced.Take(8))}. " +
                "Set rates on the Pricing page, then Recompute.");
        return 0;
    }
    catch (OperationCanceledException) { return 0; }
    catch (FatalReporterException ex) { Console.Error.WriteLine($"FATAL: {ex.Message}"); return 1; }
    catch (Exception ex) { Log($"Pass failed: {ex.Message}"); return 0; } // transient; try again next interval
}

static void Log(string message) => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {message}");

static void PrintUsage()
{
    Console.WriteLine(
        """
        Usage IQ reporter — pushes locally-parsed Claude Code + Codex usage to a hosted Usage IQ API.

        USAGE:
          usage-iq-reporter --url <api-base-url> --key <ingest-key> [options]

        REQUIRED:
          -u, --url <url>        Usage IQ API base URL (e.g. https://usage.example.com)
          -k, --key <key>        Ingest key (Settings → Ingest keys). Treat as a secret.

        OPTIONS:
          -m, --machine <name>   Label for this machine (default: OS machine name)
              --claude-path <p>  Claude projects dir (default: ~/.claude/projects)
              --codex-path <p>   Codex sessions dir (default: ~/.codex)
              --state <p>        State file path (default: ~/.usage-iq/reporter-state.json)
              --batch <n>        Rows per request, 1–5000 (default: 500)
              --interval <s>     Watch poll interval seconds, 5–3600 (default: 60)
              --once             Run a single pass and exit (default: watch continuously)
          -h, --help             Show this help

        Config may also come from REPORTER_*-prefixed env vars or an appsettings.json beside the exe.
        Only parsed token counts/metadata are sent — never prompt or response text.
        """);
}
