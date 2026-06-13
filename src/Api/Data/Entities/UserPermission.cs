namespace Ccusage.Api.Data.Entities;

/// <summary>One granted permission for a user (the editable "permission table").</summary>
public class UserPermission
{
    public int Id { get; set; }

    public int UserId { get; set; }
    public AppUser? User { get; set; }

    /// <summary>A permission key from <see cref="Auth.Permissions"/> (e.g. <c>dashboard.view</c>).</summary>
    public string Permission { get; set; } = "";
}
