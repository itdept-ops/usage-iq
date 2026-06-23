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

    /// <summary>
    /// How the user's name is shown TO OTHER USERS everywhere a name reaches another person (presence,
    /// chat, family, fleet attribution labels, the 75-Hard leaderboard, etc.). The user controls how
    /// they appear to everyone — see <see cref="Services.DisplayName"/>. Default
    /// <see cref="DisplayNameMode.FirstInitial"/> ("First L."). The admin Users table deliberately ignores
    /// this and shows the real <see cref="Name"/>.
    /// </summary>
    public DisplayNameMode DisplayNameMode { get; set; } = DisplayNameMode.FirstInitial;

    /// <summary>
    /// An optional self-chosen display name, used only when <see cref="DisplayNameMode"/> is
    /// <see cref="DisplayNameMode.Nickname"/> (and falling back to the formatted real name when blank).
    /// Sanitized/length-capped on write. Never an email.
    /// </summary>
    public string? Nickname { get; set; }

    /// <summary>
    /// When true, the user is hidden from the online roster, count, and avatar stack that OTHER users see
    /// (the app still works normally for them; they still see themselves). False by default. Durable, like
    /// the other self-toggles below.
    /// </summary>
    public bool AppearOffline { get; set; }

    /// <summary>
    /// An optional short, free-text status the user broadcasts on the presence roster (e.g. "heads-down",
    /// "in a meeting"). Sanitized/length-capped on write. Null/blank means no status shown.
    /// </summary>
    public string? PresenceStatus { get; set; }

    /// <summary>
    /// Per-user OPT-IN to share lightweight auto-derived context (e.g. coarse city / last-seen-derived
    /// activity) alongside their presence status. False by default — the explicit
    /// <see cref="PresenceStatus"/> is always shown; this gates the optional auto-context section.
    /// </summary>
    public bool ShareAutoContext { get; set; }

    /// <summary>
    /// Per-user OPT-IN to SHARE the user's activity to the social feed (the event spine). False by default:
    /// even with the <c>tracker.self</c> permission, NO action becomes an <see cref="ActivityEvent"/> until
    /// the user flips this on (PATCH /api/auth/profile). The emitter reads this once and NO-OPS when false,
    /// so a private action never becomes an event. This is the real privacy control for the feed.
    /// </summary>
    public bool ShareActivity { get; set; }

    /// <summary>
    /// Per-user OPT-IN to VIEW the social feed (the circle activity feed). False by default. The feed read
    /// is ALSO circle-scoped (you only ever see your own events + a sharing contact's events), so this is a
    /// secondary gate the user controls; when false the feed returns only the user's OWN events.
    /// </summary>
    public bool ViewActivityFeed { get; set; }

    /// <summary>
    /// When true, the user receives NO peer nudges (the canned "log your day"/"close your rings"/etc.
    /// pings). False by default — opt-IN is safe because nudges are circle-gated (only a contact or
    /// fellow household member can send one) AND cooldowned per (sender, target), so they can't be used
    /// to spam/harass. This is the user's escape hatch; the nudge service no-ops when it's true.
    /// </summary>
    public bool NudgesOptOut { get; set; }

    public DateTime CreatedUtc { get; set; }
    public DateTime? LastLoginUtc { get; set; }

    public List<UserPermission> Permissions { get; set; } = new();
}
