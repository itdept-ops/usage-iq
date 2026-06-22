namespace Ccusage.Api.Data.Entities;

/// <summary>A person allowed to sign in. Authorization is the set of <see cref="Permissions"/>.</summary>
public class AppUser
{
    public int Id { get; set; }

    /// <summary>Google account email, stored lower-cased; the identity key.</summary>
    public string Email { get; set; } = "";

    /// <summary>
    /// The Google account's immutable subject id (<c>sub</c> claim). Bound on first successful
    /// sign-in; thereafter a login whose email matches but whose Google id differs is rejected,
    /// so a recycled/reassigned email can't inherit another person's access. Null until first login.
    /// </summary>
    public string? GoogleSubject { get; set; }

    public string Name { get; set; } = "";
    public string? Picture { get; set; }

    /// <summary>When false, sign-in and all API access are denied (checked on every request).</summary>
    public bool IsEnabled { get; set; } = true;

    /// <summary>
    /// The page route the user lands on after sign-in (their chosen home). Null means "use the default
    /// first-accessible page" (the original behaviour). A non-null value is always one of the known page
    /// routes the user currently has permission to reach; it is validated server-side on every change,
    /// so a user can never persist a home they cannot access.
    /// </summary>
    public string? HomeRoute { get; set; }

    /// <summary>
    /// Security stamp for session invalidation. Each issued JWT carries this value in its <c>sv</c>
    /// claim; the request pipeline rejects a token whose <c>sv</c> no longer matches. An admin
    /// "force logout" bumps this (+1), invalidating every outstanding token for the user without
    /// disabling the account (they can sign in again to get a fresh token). A MISSING <c>sv</c> claim
    /// is treated as 0, so tokens minted before this field existed stay valid while SessionVersion is
    /// still its default 0 — i.e. no mass-logout on deploy.
    /// </summary>
    public int SessionVersion { get; set; }

    /// <summary>
    /// Per-user OPT-IN for location capture. False by default: even with the <c>location.self</c>
    /// permission, no location is recorded until the user flips this on (PATCH /api/location/settings).
    /// The record endpoint REQUIRES this be true (else 409 "enable location first").
    /// </summary>
    public bool LocationEnabled { get; set; }

    /// <summary>
    /// When true, the user's COARSE latest city (never precise lat/lng) is visible to their household
    /// members. False by default — sharing is an explicit, separate choice from enabling capture.
    /// </summary>
    public bool LocationShareHousehold { get; set; }

    /// <summary>
    /// Per-user OPT-IN to share the user's connected primary calendar EVENTS (title + time only, never an
    /// email) with their household members as a read-only overlay. False by default — mirrors
    /// <see cref="LocationShareHousehold"/>. Only meaningful once the user has connected a calendar; with no
    /// connection it has no effect (the family-events read skips unconnected members regardless).
    /// </summary>
    public bool CalendarShareHousehold { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime? LastLoginUtc { get; set; }

    public List<UserPermission> Permissions { get; set; } = new();
}
