using System.Globalization;
using System.Text;
using Ccusage.Reporter;
using Microsoft.Extensions.Configuration;

// UTF-8 so box/rule glyphs and arrows render instead of mojibake (the classic "?" / box artifact).
try { Console.OutputEncoding = Encoding.UTF8; } catch { /* some hosts disallow it */ }

const string Version = "v1.0";

// ---- flags (separated so the valued-option parser below never sees a bare flag) ----
var flagSet = new HashSet<string>(args, StringComparer.OrdinalIgnoreCase);
var once = flagSet.Contains("--once");
var noHud = flagSet.Contains("--no-hud");
var wantsHelp = flagSet.Contains("--help") || flagSet.Contains("-h") || args.Length == 0;

if (wantsHelp)
{
    PrintUsage();
    return args.Length == 0 ? 1 : 0;
}

var valued = args.Where(a => a is not ("--once" or "--watch" or "--help" or "-h" or "--no-hud")).ToArray();

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

using var ui = new ReporterConsole(enableHud: !noHud); // disposing releases the reserved HUD row + restores the console

ui.Banner(Version);
ui.Config("Server", opt.Url!);
ui.Config("Machine", opt.ResolvedMachine);
ui.Config("Sources", $"{Pretty(opt.ResolvedClaudePath)} · {Pretty(opt.ResolvedCodexPath)}");
ui.Config("Mode", once ? "one-shot" : $"watch · every {opt.ResolvedIntervalSeconds}s  ·  Ctrl+C to stop");
ui.Rule();

// The ingest key is a bearer secret; over plain http to a non-local host it travels in cleartext.
if (Uri.TryCreate(opt.Url, UriKind.Absolute, out var parsed) && parsed.Scheme == "http" && !parsed.IsLoopback)
    ui.Warn("--url is http:// to a non-local host — the ingest key is sent in cleartext. Use https.");

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); ui.Stamp("stopping…", ConsoleColor.DarkGray); };

using var client = new IngestClient(opt.Url!, opt.Key!, opt.ResolvedMachine);
var store = FileStateStore.Load(opt.ResolvedStatePath);
var scanner = new LogScanner(client, store, opt.ResolvedBatchSize, ui);

if (once)
    return await RunPassAsync();

while (!cts.IsCancellationRequested)
{
    var code = await RunPassAsync();
    if (code == 1) return 1; // fatal (e.g. rejected key) — stop the loop
    if (cts.IsCancellationRequested) break;
    ui.Watching(DateTime.Now.AddSeconds(opt.ResolvedIntervalSeconds));
    try { await Task.Delay(TimeSpan.FromSeconds(opt.ResolvedIntervalSeconds), cts.Token); }
    catch (TaskCanceledException) { break; }
}
return 0;

async Task<int> RunPassAsync()
{
    try
    {
        ui.Live("scanning…");
        var s = await scanner.ScanAsync(opt.ResolvedClaudePath, opt.ResolvedCodexPath, cts.Token);

        if (s.Changed || once)
        {
            var headline = s.Inserted > 0
                ? $"synced {s.Inserted:N0} new row{(s.Inserted == 1 ? "" : "s")} in {s.ElapsedSeconds:0.0}s"
                : $"scanned in {s.ElapsedSeconds:0.0}s — nothing new";
            ui.Stamp(headline, s.Inserted > 0 ? ConsoleColor.Green : ConsoleColor.Gray);
            foreach (var src in s.Sources)
                ui.Detail(src.Source, $"{src.Files:N0} files · {src.Changed:N0} changed");

            var g = ConsoleColor.Gray;
            ui.Summary(new[]
            {
                ("new",         s.Inserted.ToString("N0", CultureInfo.InvariantCulture),    s.Inserted > 0 ? ConsoleColor.Green : g),
                ("new tokens",  ReporterConsole.FormatTokens(s.InsertedTokens) + " combined", s.InsertedTokens > 0 ? ConsoleColor.Green : g),
                ("already had", s.Duplicates.ToString("N0", CultureInfo.InvariantCulture),  g),
                ("redundant",   $"{s.Redundant:N0}  (merged before send)",                  ConsoleColor.DarkGray),
                ("pushed",      $"{s.Sent:N0} rows · {s.Requests:N0} request{(s.Requests == 1 ? "" : "s")}", g),
                ("files",       $"{s.FilesParsed:N0} changed of {s.FilesScanned:N0} scanned", g),
            });

            if (s.Unpriced.Count > 0)
                ui.Warn($"{s.Unpriced.Count} unpriced model(s): {string.Join(", ", s.Unpriced.Take(6))}. " +
                        "Set rates on the Pricing page, then Recompute.");
        }
        return 0;
    }
    catch (OperationCanceledException) { return 0; }
    catch (FatalReporterException ex) { ui.Error(ex.Message); return 1; }
    catch (Exception ex) { ui.Warn($"pass failed: {ex.Message} (will retry)"); return 0; }
}

static string Pretty(string path)
{
    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    return !string.IsNullOrEmpty(home) && path.StartsWith(home, StringComparison.OrdinalIgnoreCase)
        ? "~" + path[home.Length..]
        : path;
}

static void PrintUsage()
{
    Console.WriteLine(
        """
        Usage IQ reporter — pushes locally-parsed Claude Code + Codex usage to a hosted Usage IQ API.

        USAGE:
          usage-iq-reporter --url <api-base-url> --key <ingest-key> [options]

        REQUIRED:
          -u, --url <url>        Usage IQ API base URL (e.g. https://usage.example.com)
          -k, --key <key>        Ingest key (Dashboard -> Reporter -> Generate key). Treat as a secret.

        OPTIONS:
          -m, --machine <name>   Label for this machine (default: OS machine name)
              --claude-path <p>  Claude projects dir (default: ~/.claude/projects)
              --codex-path <p>   Codex sessions dir (default: ~/.codex)
              --state <p>        State file path (default: ~/.usage-iq/reporter-state.json)
              --batch <n>        Rows per request, 1-5000 (default: 500)
              --interval <s>     Watch poll interval seconds, 5-3600 (default: 60)
              --once             Run a single pass and exit (default: watch continuously)
              --no-hud           Disable the top-right token counter (live count stays in the window title)
          -h, --help             Show this help

        Config may also come from REPORTER_*-prefixed env vars or an appsettings.json beside the exe.
        Only parsed token counts/metadata are sent — never prompt or response text.
        """);
}
