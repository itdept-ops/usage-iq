namespace Ccusage.Api.Dtos;

// ===================================================================================
// Bill Splitter — owner CRUD + receipt-AI + public claim DTOs
// ===================================================================================

/// <summary>Create a bill (owner-scoped). Items are added/edited via the items endpoints.</summary>
public sealed class CreateBillRequest
{
    public string? Title { get; set; }
    public decimal? TaxAmount { get; set; }
    public decimal? TipAmount { get; set; }
}

/// <summary>Update a bill's title/tax/tip/status (owner-scoped). Null fields are left unchanged-ish per
/// the handler's clamp rules; Status is "open" or "settled".</summary>
public sealed class UpdateBillRequest
{
    public string? Title { get; set; }
    public decimal? TaxAmount { get; set; }
    public decimal? TipAmount { get; set; }
    public string? Status { get; set; }
}

/// <summary>Add or edit a line item (owner-scoped).</summary>
public sealed class BillItemRequest
{
    public string? Name { get; set; }
    public decimal Amount { get; set; }
}

/// <summary>Pre-assign an item to a contact (a mutual ChatContact of the owner), or clear with null.</summary>
public sealed class AssignItemRequest
{
    public int? AssignedToUserId { get; set; }
}

/// <summary>Mark an item settled/unsettled (owner-scoped).</summary>
public sealed class SettleItemRequest
{
    public bool Settled { get; set; }
}

/// <summary>Enable/disable the public claim link (owner-scoped). Enabling mints a token on first use.</summary>
public sealed class ShareToggleRequest
{
    public bool Enabled { get; set; }
}

// ---- Owner-facing read DTOs ----

public sealed class BillItemDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Amount { get; set; }
    public int? AssignedToUserId { get; set; }
    public string? AssignedToName { get; set; }
    public string? ClaimedByName { get; set; }
    public int? ClaimedByUserId { get; set; }
    public DateTime? ClaimedUtc { get; set; }
    public bool Settled { get; set; }
    /// <summary>True when no one is assigned or has claimed it.</summary>
    public bool Open { get; set; }
}

/// <summary>One person's roll-up: their claimed/assigned item total plus a proportional share of tax+tip.</summary>
public sealed class PersonTotalDto
{
    public string Name { get; set; } = "";
    public decimal ItemsTotal { get; set; }
    public decimal TaxTipShare { get; set; }
    public decimal Total { get; set; }
}

/// <summary>The owner's full view of a bill (includes the share path + token when a link is live).</summary>
public sealed class BillDto
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
    public decimal? TaxAmount { get; set; }
    public decimal? TipAmount { get; set; }
    public string Status { get; set; } = "open";
    public bool ShareEnabled { get; set; }
    /// <summary>The public claim path (/bill/{token}) when a link is live; null otherwise.</summary>
    public string? SharePath { get; set; }
    public IReadOnlyList<BillItemDto> Items { get; set; } = Array.Empty<BillItemDto>();
    public IReadOnlyList<PersonTotalDto> PersonTotals { get; set; } = Array.Empty<PersonTotalDto>();
    public decimal UnclaimedTotal { get; set; }
    public PaymentHandlesDto Payments { get; set; } = new();
}

// ---- Receipt AI ----

/// <summary>One AI-extracted receipt line (amount clamped 0..100000). The owner reviews before saving.</summary>
public sealed class ReceiptItemDto
{
    public string Name { get; set; } = "";
    public decimal Amount { get; set; }
}

/// <summary>The AI receipt breakdown the owner reviews then saves. Nothing is persisted by the AI call.</summary>
public sealed class ReceiptBreakdownDto
{
    public IReadOnlyList<ReceiptItemDto> Items { get; set; } = Array.Empty<ReceiptItemDto>();
    public decimal? Tax { get; set; }
    public decimal? Tip { get; set; }
}

// ---- Payment handles (owner's intentionally-public pay-me links, from config) ----

/// <summary>The owner's payment handles read from the Payments config section. Shown to people who owe.
/// Any handle may be null/blank (the frontend hides the link). NEVER carries a secret — these are public
/// pay-me URLs by design.</summary>
public sealed class PaymentHandlesDto
{
    public string? CashApp { get; set; }
    public string? PayPal { get; set; }
    public string? Venmo { get; set; }
}

// ---- Public (anonymous) claim view ----

/// <summary>An item as seen on the PUBLIC claim page — NO assignee/claimer ids, just whether it's open and
/// (when claimed) the claimer's display name. No owner email, no other private data.</summary>
public sealed class PublicBillItemDto
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public decimal Amount { get; set; }
    public bool Open { get; set; }
    public string? ClaimedByName { get; set; }
    public bool Settled { get; set; }
}

/// <summary>The PUBLIC, anonymous claim view of a bill: the title, items + per-person totals, the owner's
/// payment handles, and which items are open — and NOTHING that identifies the owner or other users.</summary>
public sealed class PublicBillDto
{
    public string Title { get; set; } = "";
    public string Status { get; set; } = "open";
    public decimal? TaxAmount { get; set; }
    public decimal? TipAmount { get; set; }
    public IReadOnlyList<PublicBillItemDto> Items { get; set; } = Array.Empty<PublicBillItemDto>();
    public IReadOnlyList<PersonTotalDto> PersonTotals { get; set; } = Array.Empty<PersonTotalDto>();
    public decimal UnclaimedTotal { get; set; }
    public PaymentHandlesDto Payments { get; set; } = new();
}

/// <summary>Claim an open item on the public page under a display name (anonymous).</summary>
public sealed class ClaimItemRequest
{
    public int ItemId { get; set; }
    public string? Name { get; set; }
}
