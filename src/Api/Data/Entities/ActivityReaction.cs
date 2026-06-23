namespace Ccusage.Api.Data.Entities;

/// <summary>
/// One "cheer" (👏) a user placed on a single <see cref="ActivityEvent"/> in the social feed. There is at
/// most ONE row per (reactor, event) — the unique index enforces it, and the endpoint TOGGLES it (a second
/// cheer removes the row). It is the feed's analogue of <see cref="ChatMessageReaction"/>, narrowed to a
/// single fixed reaction so there is no emoji column.
///
/// PRIVACY — <see cref="ReactorEmail"/> is the lower-cased reactor email and is the identity/dedup key; it
/// is NEVER serialized to a client. The feed exposes only an aggregate <c>clapCount</c> + the caller's own
/// <c>iReacted</c> flag, and the cheer notification names the reactor by a
/// <see cref="Services.DisplayName"/>-formatted name only (email-privacy).
///
/// A reactor may only cheer an event they can already SEE in the feed (their own, or a sharing contact's
/// when they've opted to view) — the endpoint re-runs the same circle/visibility check the feed read uses.
/// </summary>
public class ActivityReaction
{
    public long Id { get; set; }

    /// <summary>The reacting user's lower-cased email — the dedup key. NEVER serialized to a client.</summary>
    public string ReactorEmail { get; set; } = "";

    /// <summary>FK to the cheered <see cref="ActivityEvent"/>. Cascade-deletes with the event.</summary>
    public long ActivityEventId { get; set; }

    public DateTime CreatedUtc { get; set; }
}
