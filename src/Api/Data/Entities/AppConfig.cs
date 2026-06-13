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

    /// <summary>Absolute path to the Claude Code projects directory (source of JSONL logs).</summary>
    public string ClaudeProjectsPath { get; set; } = "";
}
