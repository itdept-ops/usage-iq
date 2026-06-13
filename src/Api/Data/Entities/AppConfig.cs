namespace Ccusage.Api.Data.Entities;

/// <summary>
/// Single-row runtime settings, seeded from configuration on first run and
/// editable via the Settings page.
/// </summary>
public class AppConfig
{
    public int Id { get; set; }

    /// <summary>IANA timezone used to bucket usage into days/months.</summary>
    public string DisplayTimeZone { get; set; } = "America/New_York";

    /// <summary>Absolute path to the Claude Code projects directory (legacy; sources now own paths).</summary>
    public string ClaudeProjectsPath { get; set; } = "";

    /// <summary>Whether the background timer runs incremental syncs.</summary>
    public bool AutoSyncEnabled { get; set; } = true;

    /// <summary>Cadence of the background sync, in seconds (min 30).</summary>
    public int AutoSyncIntervalSeconds { get; set; } = 300;
}
