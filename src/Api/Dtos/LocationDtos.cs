namespace Ccusage.Api.Dtos;

/// <summary>Body of <c>POST /api/location</c> — record one fix for the caller. The client sends its own
/// browser/agent-resolved coordinates; the server clamps them and best-effort reverse-geocodes the city.</summary>
public sealed class RecordLocationRequest
{
    public double Lat { get; set; }
    public double Lng { get; set; }
    /// <summary>Reported GPS accuracy radius in metres (optional).</summary>
    public double? AccuracyM { get; set; }
    /// <summary>How this fix was captured: login | periodic | manual | agent. Unknown values normalize to "manual".</summary>
    public string? Source { get; set; }
}

/// <summary>One location fix returned to its OWNER (own history) or to an admin. Carries the precise
/// lat/lng — only ever returned to the sharer themselves (their own history) or an admin holding
/// <c>location.view-all</c>; coarse household-sharing only ever surfaces the city.</summary>
public sealed class LocationDto
{
    public int Id { get; set; }
    public double Lat { get; set; }
    public double Lng { get; set; }
    public double? AccuracyM { get; set; }
    public string Source { get; set; } = "";
    public string? City { get; set; }
    public string? Region { get; set; }
    public string? Country { get; set; }
    public DateTime CapturedUtc { get; set; }
}

/// <summary>Body of <c>PATCH /api/location/settings</c> — the per-user opt-in toggles. Each is optional
/// (null = leave unchanged) so the client can flip one without resending the other.</summary>
public sealed class LocationSettingsRequest
{
    /// <summary>Opt in / out of location capture. Turning it off does NOT delete history (use DELETE /me).</summary>
    public bool? LocationEnabled { get; set; }
    /// <summary>Share the coarse latest city with household members.</summary>
    public bool? ShareHousehold { get; set; }
}

/// <summary>The caller's current location settings (echoed after a PATCH and on the settings read).</summary>
public sealed class LocationSettingsDto
{
    public bool LocationEnabled { get; set; }
    public bool ShareHousehold { get; set; }
}

/// <summary>
/// One household member's latest pin on the family-finder map (<c>GET /api/family/locations</c>).
/// Identity is userId + display NAME only — an email is NEVER on the wire. The precise lat/lng is present
/// because, for the family-finder, the member's <see cref="AppUser.LocationShareHousehold"/> opt-in IS the
/// consent to show their exact latest location to the household (distinct from the coarse-city presence).
/// The CALLER always sees their own latest pin (<see cref="IsSelf"/> = true); other members appear only
/// when they share AND have a recent fix.
/// </summary>
public sealed class FamilyMemberLocationDto
{
    public int UserId { get; set; }
    public string Name { get; set; } = "";
    /// <summary>True for the caller's own pin (always included if they have any history, regardless of sharing).</summary>
    public bool IsSelf { get; set; }
    public double Lat { get; set; }
    public double Lng { get; set; }
    public string? City { get; set; }
    public string? Region { get; set; }
    public string? Country { get; set; }
    public double? AccuracyM { get; set; }
    public DateTime CapturedUtc { get; set; }
}

/// <summary>One user's entry on the admin location map (<c>GET /api/location/admin</c>): identity by id+name
/// (admin page is admin-gated, but we still prefer userId+name over email), the latest pin, and a short
/// recent history. The precise coordinates are visible here ONLY because the endpoint is admin-gated.</summary>
public sealed class AdminUserLocationDto
{
    public int? UserId { get; set; }
    public string Name { get; set; } = "";
    /// <summary>The most recent fix (null only in the degenerate case the user has no rows — they're omitted then).</summary>
    public LocationDto? Latest { get; set; }
    /// <summary>A short window of recent fixes (newest-first), for drawing a trail on the map.</summary>
    public List<LocationDto> Recent { get; set; } = new();
}
