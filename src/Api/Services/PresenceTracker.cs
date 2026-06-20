using System.Collections.Concurrent;

namespace Ccusage.Api.Services;

/// <summary>
/// In-memory, ephemeral record of who is currently online. Fed best-effort by the presence
/// middleware on every authenticated request (the SPA already polls /me + /sync/status every
/// ~15-20s, so that request activity doubles as a heartbeat — no dedicated client heartbeat).
/// A process-wide singleton; nothing is persisted (presence resets on restart, by design).
/// </summary>
public sealed class PresenceTracker
{
    /// <summary>How long after a user's last seen request they are still considered "online".
    /// The SPA polls every ~15-20s, so 45s tolerates a single missed poll while clearing a closed or
    /// crashed tab (and a signed-out/force-logged-out user, who is also removed explicitly) fast.</summary>
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromSeconds(45);

    public sealed record Entry(string Email, string Name, string? Picture, DateTime LastSeenUtc);

    // Keyed by lowercased email so re-touches from the same user collapse onto one entry.
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    /// <summary>
    /// Record that <paramref name="email"/> is active right now, refreshing their last-seen time
    /// (and any changed name/picture). No-op for a blank email.
    /// </summary>
    public void Touch(string? email, string? name, string? picture)
    {
        var key = email?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(key)) return;

        var entry = new Entry(key, name?.Trim() ?? "", string.IsNullOrWhiteSpace(picture) ? null : picture, DateTime.UtcNow);
        _entries[key] = entry;
    }

    /// <summary>
    /// Drop <paramref name="email"/> from the live set immediately (used on sign-out and force-logout so a
    /// departed user goes offline at once instead of lingering until their entry ages out of the window).
    /// Keyed by the same lowercased email as <see cref="Touch"/>. No-op for a blank email.
    /// </summary>
    public void Remove(string? email)
    {
        var key = email?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(key)) return;
        _entries.TryRemove(key, out _);
    }

    /// <summary>
    /// Everyone whose last-seen time is within <paramref name="window"/> (default 2 minutes),
    /// ordered by name. Stale entries are dropped from the map as a side effect so it stays bounded.
    /// </summary>
    public IReadOnlyList<Entry> Online(TimeSpan? window = null)
    {
        var cutoff = DateTime.UtcNow - (window ?? DefaultWindow);

        var live = new List<Entry>();
        foreach (var kvp in _entries)
        {
            if (kvp.Value.LastSeenUtc >= cutoff)
                live.Add(kvp.Value);
            else
                // Best-effort prune; if a concurrent Touch re-added it, leave that fresher entry in place.
                _entries.TryRemove(new KeyValuePair<string, Entry>(kvp.Key, kvp.Value));
        }

        return live
            .OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(e => e.Email, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }
}
