namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One recorded location fix for a user. PRIVATE by default: a row only exists because the user opted in
/// (<see cref="AppUser.LocationEnabled"/>) and explicitly recorded — capture is never automatic. A caller
/// reads only their OWN history (<c>GET /api/location/me</c>); only an admin holding
/// <c>location.view-all</c> can read everyone's. The city/region/country are best-effort reverse-geocoded
/// at record time (may be null) and are the only COARSE form ever shown to household members the user
/// shares with — the precise lat/lng is never exposed to non-admins except the sharer themselves.
/// </summary>
public class UserLocation
{
    public int Id { get; set; }

    /// <summary>The owner, stored lower-cased (the identity key; indexed with <see cref="CapturedUtc"/>).</summary>
    public string UserEmail { get; set; } = "";

    /// <summary>Latitude, clamped to [-90, 90] at the endpoint.</summary>
    public double Lat { get; set; }

    /// <summary>Longitude, clamped to [-180, 180] at the endpoint.</summary>
    public double Lng { get; set; }

    /// <summary>Reported GPS accuracy radius in metres, when the client supplied one.</summary>
    public double? AccuracyM { get; set; }

    /// <summary>How this fix was captured: <c>login</c> | <c>periodic</c> | <c>manual</c> | <c>agent</c>.</summary>
    public string Source { get; set; } = "manual";

    /// <summary>Reverse-geocoded place (best-effort; null when geocoding was unavailable or failed).</summary>
    public string? City { get; set; }
    public string? Region { get; set; }
    public string? Country { get; set; }

    /// <summary>When this fix was recorded (UTC). Indexed with <see cref="UserEmail"/> for newest-first reads.</summary>
    public DateTime CapturedUtc { get; set; }
}
