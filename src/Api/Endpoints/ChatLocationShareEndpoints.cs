using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Temporary LIVE location share scoped to ONE chat conversation (a channel or DM — both channels). Identity
/// comes from the JWT (.RequireAuthorization()); capability from the chat.* + location.* permissions
/// (DB-checked). Starting/updating/extending/stopping YOUR OWN share needs <c>chat.send</c> AND
/// <c>location.self</c>; reading a conversation's active shares needs <c>chat.read</c>. Every route additionally
/// re-verifies CONVERSATION MEMBERSHIP / OWNERSHIP: you can only share into, and only see shares of, a
/// conversation you belong to; only the sharer can update/extend/stop their own share. A non-member GET returns
/// 404 (never leak that the conversation exists). The sharer is identified on the wire by AppUser id + display
/// name — an email is NEVER on the wire (email-privacy). Broadcasts go through <see cref="ChatLocationShareService"/>
/// to the conversation's SignalR group.
/// </summary>
public static class ChatLocationShareEndpoints
{
    public static void MapChatLocationShareEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/chat").RequireAuthorization();

        // ---- GET active shares for a conversation (so a late-joiner sees an in-progress share) ----
        g.MapGet("/channels/{id:int}/location-shares", async (
            int id, CurrentUserAccessor me, UsageDbContext db, ChatLocationShareService shares, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            // Non-member 404: never leak that the conversation exists.
            if (!await ChatEndpoints.IsMemberAsync(db, id, user.Email, ct)) return Results.NotFound();

            return Results.Ok(await shares.GetActiveAsync(id, ct));
        }).RequirePermission(Permissions.ChatRead);

        // ---- START a share in a conversation the caller belongs to ----
        g.MapPost("/channels/{id:int}/location-share", async (
            int id, StartLocationShareRequest req, CurrentUserAccessor me, UsageDbContext db,
            ChatLocationShareService shares, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            if (!await ChatEndpoints.IsMemberAsync(db, id, user.Email, ct)) return Results.NotFound();
            if (double.IsNaN(req.Lat) || double.IsNaN(req.Lng))
                return Results.BadRequest(new { message = "lat and lng are required." });

            var dto = await shares.StartAsync(id, user.Email, req, ct);
            return Results.Ok(dto);
        }).RequirePermission(Permissions.ChatSend).RequirePermission(Permissions.LocationSelf)
          .RequireRateLimiting("chat");

        // ---- UPDATE the live position (the sharer, while active) ----
        g.MapPut("/location-share/{id:int}/position", async (
            int id, UpdateLocationShareRequest req, CurrentUserAccessor me,
            ChatLocationShareService shares, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            if (double.IsNaN(req.Lat) || double.IsNaN(req.Lng))
                return Results.BadRequest(new { message = "lat and lng are required." });

            var dto = await shares.UpdatePositionAsync(id, user.Email, req, ct);
            // Absent / not owned / no longer active — 404 (never reveal someone else's share exists).
            return dto is null ? Results.NotFound() : Results.Ok(dto);
        }).RequirePermission(Permissions.ChatSend).RequirePermission(Permissions.LocationSelf)
          .RequireRateLimiting("chat");

        // ---- EXTEND the share (the sharer; add minutes) ----
        g.MapPost("/location-share/{id:int}/extend", async (
            int id, ExtendLocationShareRequest req, CurrentUserAccessor me,
            ChatLocationShareService shares, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            if (req.AddMinutes <= 0)
                return Results.BadRequest(new { message = "addMinutes must be positive." });

            var dto = await shares.ExtendAsync(id, user.Email, req.AddMinutes, ct);
            return dto is null ? Results.NotFound() : Results.Ok(dto);
        }).RequirePermission(Permissions.ChatSend).RequirePermission(Permissions.LocationSelf).RequireRateLimiting("chat");

        // ---- STOP the share (the sharer) ----
        g.MapPost("/location-share/{id:int}/stop", async (
            int id, CurrentUserAccessor me, ChatLocationShareService shares, CancellationToken ct) =>
        {
            var user = (await me.GetUserAsync(ct))!;
            var dto = await shares.StopAsync(id, user.Email, ct);
            return dto is null ? Results.NotFound() : Results.Ok(dto);
        }).RequirePermission(Permissions.ChatSend).RequirePermission(Permissions.LocationSelf).RequireRateLimiting("chat");
    }
}
