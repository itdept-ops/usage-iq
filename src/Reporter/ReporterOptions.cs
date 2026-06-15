namespace Ccusage.Reporter;

/// <summary>
/// Reporter configuration, resolved from (lowest→highest precedence): appsettings.json next to the
/// executable, environment variables prefixed <c>REPORTER_</c>, then command-line switches.
/// </summary>
public sealed class ReporterOptions
{
    /// <summary>Base URL of the Usage IQ API, e.g. <c>https://usage.example.com</c>.</summary>
    public string? Url { get; set; }

    /// <summary>The ingest key (generated in Settings → Ingest keys). Treat as a secret.</summary>
    public string? Key { get; set; }

    /// <summary>Label this machine reports under. Defaults to the OS machine name.</summary>
    public string? Machine { get; set; }

    /// <summary>Claude Code projects directory. Defaults to <c>~/.claude/projects</c>.</summary>
    public string? ClaudePath { get; set; }

    /// <summary>OpenAI Codex sessions directory. Defaults to <c>~/.codex</c>.</summary>
    public string? CodexPath { get; set; }

    /// <summary>Where the per-file sync state is persisted. Defaults to <c>~/.usage-iq/reporter-state.json</c>.</summary>
    public string? StatePath { get; set; }

    /// <summary>Rows per HTTP request. The server caps batches at 5000.</summary>
    public int BatchSize { get; set; } = 500;

    /// <summary>Watch-mode poll interval in seconds.</summary>
    public int IntervalSeconds { get; set; } = 60;

    public string ResolvedMachine => string.IsNullOrWhiteSpace(Machine) ? Environment.MachineName : Machine!.Trim();

    public string ResolvedClaudePath => string.IsNullOrWhiteSpace(ClaudePath)
        ? Path.Combine(Home, ".claude", "projects") : ClaudePath!;

    public string ResolvedCodexPath => string.IsNullOrWhiteSpace(CodexPath)
        ? Path.Combine(Home, ".codex") : CodexPath!;

    public string ResolvedStatePath => string.IsNullOrWhiteSpace(StatePath)
        ? Path.Combine(Home, ".usage-iq", "reporter-state.json") : StatePath!;

    public int ResolvedBatchSize => Math.Clamp(BatchSize, 1, 5000);
    public int ResolvedIntervalSeconds => Math.Clamp(IntervalSeconds, 5, 3600);

    private static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    /// <summary>Null when valid; otherwise a human-readable reason the config is unusable.</summary>
    public string? Validate()
    {
        if (string.IsNullOrWhiteSpace(Url)) return "Missing --url (the Usage IQ API base URL).";
        if (!Uri.TryCreate(Url, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https"))
            return $"--url must be an absolute http(s) URL (got '{Url}').";
        if (string.IsNullOrWhiteSpace(Key)) return "Missing --key (an ingest key from Settings → Ingest keys).";
        return null;
    }
}
