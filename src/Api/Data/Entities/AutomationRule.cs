namespace Ccusage.Api.Data.Entities;

/// <summary>How a rule's optional numeric condition is compared against the triggering event's IntValue.</summary>
public enum RuleConditionOp
{
    /// <summary>No condition — the rule fires whenever its trigger kind occurs (regardless of IntValue).</summary>
    None = 0,
    /// <summary>Fire when the event's IntValue is &gt;= <see cref="AutomationRule.ConditionValue"/>.</summary>
    Gte = 1,
    /// <summary>Fire when the event's IntValue is &lt;= <see cref="AutomationRule.ConditionValue"/>.</summary>
    Lte = 2,
    /// <summary>Fire when the event's IntValue equals <see cref="AutomationRule.ConditionValue"/>.</summary>
    Eq = 3,
}

/// <summary>
/// The FIXED, safe set of actions a rule may run. NO user-supplied endpoints, URLs, or code: each action
/// targets ONLY the owner's own channels (their personal Discord webhook and/or an in-app notification to
/// themselves), resolved server-side by the rule's <see cref="AutomationRule.OwnerEmail"/>.
/// </summary>
public enum RuleAction
{
    /// <summary>Create an in-app notification addressed to the owner (bell + toast + unread).</summary>
    InAppNotify = 0,
    /// <summary>Forward to the owner's OWN encrypted/allowlisted/rate-limited Discord webhook.</summary>
    DiscordDm = 1,
    /// <summary>Both: an in-app self-notification (which also mirrors to Discord when SurfaceDiscord is on).</summary>
    NotifyAndDiscord = 2,
}

/// <summary>
/// A single user-authored automation. A rule belongs to EXACTLY ONE user (<see cref="OwnerEmail"/>) and is
/// strictly self-scoped: it triggers ONLY on that user's OWN activity events (actor == owner) and its action
/// affects ONLY that user's own channels. It can never message another user, read another user's data, or act
/// cross-user. The action is a fixed safe enum — never an arbitrary URL/endpoint/code; the only Discord target
/// is the owner's own stored webhook (resolved by <see cref="OwnerEmail"/>), and the message is a capped,
/// sanitized template (no @everyone/@here), never a URL.
/// </summary>
public class AutomationRule
{
    public int Id { get; set; }

    /// <summary>Owner email, stored lower-cased. The ONLY actor this rule triggers on AND its only recipient.</summary>
    public string OwnerEmail { get; set; } = "";

    /// <summary>A short owner-authored label for the rule (for the management list). Capped.</summary>
    public string Name { get; set; } = "";

    /// <summary>One of <see cref="Services.ActivityEmitter.Kinds"/>' string values (validated on write).</summary>
    public string TriggerKind { get; set; } = "";

    /// <summary>Optional condition over the event's IntValue. <see cref="RuleConditionOp.None"/> => fires always.</summary>
    public RuleConditionOp ConditionOp { get; set; }

    /// <summary>The value compared against the event's IntValue (only meaningful when the op isn't None).</summary>
    public int? ConditionValue { get; set; }

    /// <summary>The FIXED safe action to run when the rule matches.</summary>
    public RuleAction Action { get; set; }

    /// <summary>
    /// Optional owner-authored message, capped + sanitized (no @everyone/@here). The token <c>{value}</c> is
    /// substituted with the event's IntValue server-side. Null/blank => a default per-kind message is used.
    /// NEVER a URL or endpoint.
    /// </summary>
    public string? MessageTemplate { get; set; }

    /// <summary>Whether the rule is active. Disabled rules are skipped by the evaluator.</summary>
    public bool Enabled { get; set; } = true;

    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }
}
