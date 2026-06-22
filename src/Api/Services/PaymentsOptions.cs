namespace Ccusage.Api.Services;

/// <summary>
/// Bound from the <c>Payments</c> configuration section. These are the OWNER'S intentionally-PUBLIC pay-me
/// handles (CashApp / PayPal / Venmo URLs), shown by the Bill Splitter to people who owe so they can pay.
/// They are a single global set for the deployment, NOT per-user. They are NOT secrets — but they are
/// still never hardcoded/committed with real values: appsettings.json ships PLACEHOLDERS, real values live
/// only in the git-ignored appsettings.Local.json locally and in AWS SSM (env <c>Payments__CashApp</c> etc.)
/// in prod. They are NEVER logged. Any handle may be blank, in which case that pay-me link is simply hidden.
/// </summary>
public sealed class PaymentsOptions
{
    public const string SectionName = "Payments";

    public string? CashApp { get; set; }
    public string? PayPal { get; set; }
    public string? Venmo { get; set; }

    /// <summary>Trimmed handle or null when blank — placeholders left in appsettings.json read through as-is
    /// (the frontend treats a placeholder like any other handle; only real Local/SSM values are meaningful).</summary>
    private static string? Norm(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    public Ccusage.Api.Dtos.PaymentHandlesDto ToDto() => new()
    {
        CashApp = Norm(CashApp),
        PayPal = Norm(PayPal),
        Venmo = Norm(Venmo),
    };
}
