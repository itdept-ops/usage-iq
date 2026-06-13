namespace Ccusage.Api.Data.Entities;

/// <summary>A person allowed to sign in. Authorization is the set of <see cref="Permissions"/>.</summary>
public class AppUser
{
    public int Id { get; set; }

    /// <summary>Google account email, stored lower-cased; the identity key.</summary>
    public string Email { get; set; } = "";

    public string Name { get; set; } = "";
    public string? Picture { get; set; }

    /// <summary>When false, sign-in and all API access are denied (checked on every request).</summary>
    public bool IsEnabled { get; set; } = true;

    public DateTime CreatedUtc { get; set; }
    public DateTime? LastLoginUtc { get; set; }

    public List<UserPermission> Permissions { get; set; } = new();
}
