using System.Text.Json;

namespace Ccusage.Reporter;

/// <summary>One file's last-seen fingerprint. A change in either field means re-parse + re-push.</summary>
public sealed class FileState
{
    public long Size { get; set; }
    public long MTimeTicks { get; set; }
}

/// <summary>
/// Persists which files have already been reported (by size + last-write time) to a local JSON file,
/// so each pass only re-reads files that changed. Writes are atomic (temp file + replace) so a crash
/// mid-write can't corrupt the state. Re-sending a row that was already ingested is harmless — the
/// server de-dupes on the unique key — so this is an optimization, not a correctness dependency.
/// </summary>
public sealed class FileStateStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = false };

    private readonly string _path;
    private readonly Dictionary<string, FileState> _state;

    private FileStateStore(string path, Dictionary<string, FileState> state)
    {
        _path = path;
        _state = state;
    }

    public static FileStateStore Load(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                var json = File.ReadAllText(path);
                var loaded = JsonSerializer.Deserialize<Dictionary<string, FileState>>(json, Json);
                if (loaded is not null)
                    return new FileStateStore(path, new(loaded, StringComparer.OrdinalIgnoreCase));
            }
        }
        catch { /* unreadable/corrupt state → start fresh; server de-dup keeps it correct */ }
        return new FileStateStore(path, new(StringComparer.OrdinalIgnoreCase));
    }

    /// <summary>True if the file is unchanged since the last successful push (skip it).</summary>
    public bool IsUnchanged(string path, long size, DateTime mtimeUtc) =>
        _state.TryGetValue(path, out var s) && s.Size == size && s.MTimeTicks == mtimeUtc.Ticks;

    public void Record(string path, long size, DateTime mtimeUtc) =>
        _state[path] = new FileState { Size = size, MTimeTicks = mtimeUtc.Ticks };

    public void Save()
    {
        var dir = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_state, Json));
        File.Move(tmp, _path, overwrite: true);
    }
}
