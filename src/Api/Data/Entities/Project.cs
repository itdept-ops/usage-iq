namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A working directory / repo that produced usage. Derived from each record's
/// <c>cwd</c> (the encoded folder name is lossy, so it is only a fallback).
/// </summary>
public class Project
{
    public int Id { get; set; }

    /// <summary>Human-friendly display name (basename of the repo root).</summary>
    public string Name { get; set; } = "";

    /// <summary>Normalized absolute path used as the stable identity (unique).</summary>
    public string RepoRoot { get; set; } = "";

    /// <summary>The raw encoded projects-folder name, if known (fallback only).</summary>
    public string? FolderName { get; set; }

    public List<UsageRecord> Records { get; set; } = new();
}
