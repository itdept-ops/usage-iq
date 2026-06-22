namespace Ccusage.Api.Data.Entities;

/// <summary>
/// A temporary LIVE location share scoped to ONE chat conversation (a <see cref="ChatChannel"/> the sharer
/// belongs to — a named channel or a 1:1 DM, both of which are channels in this model). Unlike a
/// <see cref="UserLocation"/> fix (private, opt-in history), this is an ephemeral, real-time pin pushed to
/// the OTHER participants of that conversation only, for a bounded window.
///
/// Lifecycle: created with a default 15-minute window; the sharer may push <see cref="ExpiresUtc"/> further
/// (extend), update the live position, or stop it. A share is ACTIVE while <c>!Stopped &amp;&amp; now &lt; ExpiresUtc</c>;
/// the server filters expired/stopped shares out of every read, and an active share past its expiry simply
/// reads as ended (no row mutation required). The precise lat/lng is visible to conversation participants
/// because starting the share IS the consent to show your live location to that one conversation — distinct
/// from the coarse-city household presence. Identity on the wire is the sharer's AppUser id + display name,
/// NEVER their email (email-privacy).
/// </summary>
public class ChatLocationShare
{
    public int Id { get; set; }

    /// <summary>The conversation this share is scoped to (a channel id; DMs are channels too). Participants
    /// are resolved by membership of this channel — you only ever see shares in conversations you belong to.</summary>
    public int ChannelId { get; set; }
    public ChatChannel? Channel { get; set; }

    /// <summary>The sharer, stored lower-cased (the identity key; resolved to id+name on the wire).</summary>
    public string SharerEmail { get; set; } = "";

    /// <summary>When the share started (UTC).</summary>
    public DateTime StartUtc { get; set; }

    /// <summary>When the share expires (UTC). Extending pushes this further; an active share past this reads
    /// as ended. Indexed (with <see cref="ChannelId"/>) for the active-shares-per-conversation read.</summary>
    public DateTime ExpiresUtc { get; set; }

    /// <summary>Latest latitude, clamped to [-90, 90] at the endpoint.</summary>
    public double Lat { get; set; }

    /// <summary>Latest longitude, clamped to [-180, 180] at the endpoint.</summary>
    public double Lng { get; set; }

    /// <summary>Reported GPS accuracy radius in metres, when the client supplied one.</summary>
    public double? AccuracyM { get; set; }

    /// <summary>When the latest position was recorded (UTC). Bumped on every update; equals
    /// <see cref="StartUtc"/> at creation.</summary>
    public DateTime LastUpdateUtc { get; set; }

    /// <summary>True once the sharer explicitly stopped the share. A stopped share is never active again.</summary>
    public bool Stopped { get; set; }
}
