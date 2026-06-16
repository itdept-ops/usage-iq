using System.Text;
using Ccusage.Reporter;
using Ccusage.Reporter.Core;

// UTF-8 so box/rule glyphs and arrows render instead of mojibake (the classic "?" / box artifact).
try { Console.OutputEncoding = Encoding.UTF8; } catch { /* some hosts disallow it */ }

const string Version = "v1.1";

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

// Config now resolves in the core: appsettings.json → ~/.usage-iq/config.json → reporter.key (key
// only) → REPORTER_* env → CLI. The raw key is never echoed.
ReporterOptions opt;
try
{
    opt = ReporterConfig.Load(valued);
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
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;       // first Ctrl+C: cancel gracefully (the loop/pass unwinds and state is saved)
    cts.Cancel();
    ui.Stamp("stopping… (Ctrl+C again to force quit)", ConsoleColor.DarkGray);
};

using var engine = new ReporterEngine(opt);
engine.Progress += ui.On; // the console is just one listener; a GUI could subscribe to the same engine

if (once)
{
    try
    {
        await engine.RunOnceAsync(once: true, cts.Token);
        return 0;
    }
    catch (FatalReporterException) { return 1; } // key rejected etc. — already rendered as an error
}

try
{
    await engine.RunForeverAsync(cts.Token);
    return 0;
}
catch (FatalReporterException) { return 1; }

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

        Config may also come from ~/.usage-iq/config.json, REPORTER_*-prefixed env vars, or an
        appsettings.json beside the exe. The ingest key may live in ~/.usage-iq/reporter.key (never in
        config.json). Only parsed token counts/metadata are sent — never prompt or response text.
        """);
}
