namespace Ccusage.Api.Ingestion;

/// <summary>
/// Derives a stable project identity from a record's <c>cwd</c>. Worktree paths
/// (<c>…\.claude-worktrees\&lt;name&gt;</c>) collapse to their parent repo so ephemeral
/// checkouts don't appear as separate projects.
/// </summary>
public static class ProjectResolver
{
    private const string WorktreeMarker = @"\.claude-worktrees\";
    private static readonly HashSet<string> GenericLeaves =
        new(StringComparer.OrdinalIgnoreCase) { "api", "web", "src", "app", "server", "client", "backend", "frontend" };

    public static (string RepoRoot, string Name) Resolve(string? cwd)
    {
        var path = (cwd ?? "").Trim();
        if (path.Length == 0) return ("(unknown)", "(unknown)");

        var norm = path.Replace('/', '\\').TrimEnd('\\');
        var idx = norm.IndexOf(WorktreeMarker, StringComparison.OrdinalIgnoreCase);
        if (idx >= 0) norm = norm[..idx];
        norm = norm.TrimEnd('\\');

        var segments = norm.Split('\\', StringSplitOptions.RemoveEmptyEntries);
        string name;
        if (segments.Length == 0)
            name = norm;
        else if (segments.Length >= 2 && GenericLeaves.Contains(segments[^1]))
            name = segments[^2] + "/" + segments[^1];   // disambiguate generic leaves (…/Api)
        else
            name = segments[^1];

        return (norm.Length == 0 ? "(unknown)" : norm, name);
    }

    /// <summary>The encoded top-level folder under the projects root (fallback identity).</summary>
    public static string? TopFolder(string filePath, string root)
    {
        try
        {
            var rel = System.IO.Path.GetRelativePath(root, filePath);
            var first = rel.Split(System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar)
                           .FirstOrDefault(s => s.Length > 0 && s != "..");
            return first;
        }
        catch { return null; }
    }
}
