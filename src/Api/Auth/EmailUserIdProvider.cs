using Microsoft.AspNetCore.SignalR;

namespace Ccusage.Api.Auth;

/// <summary>
/// Maps a SignalR connection to a stable per-user key (the JWT <c>email</c> claim) so the server can
/// address a specific user across all their connections via <c>Clients.User(email)</c>. Emails are
/// stored/compared lower-cased everywhere, so normalize here too.
/// </summary>
public sealed class EmailUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection) =>
        connection.User?.FindFirst("email")?.Value?.Trim().ToLowerInvariant();
}
