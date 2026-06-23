using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// The People hub (<c>/api/people</c>): the caller's people = their mutual chat contacts ∪ their
/// household members, DE-DUPLICATED over the single <see cref="Ccusage.Api.Data.Entities.AppUser"/>
/// spine and decorated with live presence. This is an ADDITIVE, READ-ONLY aggregation — it composes the
/// SAME building blocks the live surfaces use (the contacts query shape, the household member join,
/// <see cref="PresenceTracker"/>, and the central <see cref="DisplayName"/> formatter) without changing
/// any of their behavior.
///
/// AUTHORIZATION: any-of <see cref="Permissions.ChatRead"/> OR <see cref="Permissions.FamilyUse"/> — the
/// hub is purely the union of two surfaces the caller already has (contacts ⟸ chat.read; household ⟸
/// family.use), so it exposes no new data and warrants no new permission. Each source is included ONLY
/// when the caller holds that source's permission (a chat-only caller sees just contacts; a family-only
/// caller sees just their household).
///
/// PRIVACY (enforced server-side, mirrors the source endpoints):
/// <list type="bullet">
///   <item>The raw email is NEVER put on the wire; every name goes through <see cref="DisplayName.Format"/>.</item>
///   <item>Appear-offline is honored: a person who hides their presence reads as offline to everyone but
///   themselves.</item>
///   <item>City is coarse-only and gated exactly as <see cref="PresenceEndpoints"/> gates it: shown to the
///   caller's own row, or to a fellow household member who shares-to-household.</item>
///   <item><c>CanDm</c> mirrors the chat DM gate (contact, or chat.contacts.manage) so the UI never offers
///   a button that would 403.</item>
/// </list>
/// </summary>
public static class PeopleEndpoints
{
    public static void MapPeopleEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/people").RequireAuthorization();

        g.MapGet("/", async (
                CurrentUserAccessor me, PresenceTracker presence, UsageDbContext db, CancellationToken ct) =>
            {
                var caller = (await me.GetUserAsync(ct))!; // any-of filter guarantees non-null
                var hasChat = caller.Permissions.Contains(Permissions.ChatRead);
                var hasFamily = caller.Permissions.Contains(Permissions.FamilyUse);
                var canManageContacts = caller.Permissions.Contains(Permissions.ChatContactsManage);

                // ---- 1) Contacts (only when the caller holds chat.read) ----
                // The caller's mutual contacts, resolved to AppUser identity — the exact shape of
                // ContactsEndpoints.ContactsForAsync (email-keyed join, enabled-only).
                var people = new Dictionary<int, Acc>();
                if (hasChat)
                {
                    var contacts = await db.ChatContacts.AsNoTracking()
                        .Where(c => c.OwnerEmail == caller.Email)
                        .Join(db.Users.AsNoTracking(), c => c.ContactEmail, u => u.Email, (c, u) => u)
                        .Where(u => u.IsEnabled)
                        .Select(u => new { u.Id, u.Name, u.DisplayNameMode, u.Nickname, u.Picture })
                        .ToListAsync(ct);

                    foreach (var u in contacts)
                    {
                        var p = GetOrAdd(people, u.Id, u.Name, u.DisplayNameMode, u.Nickname, u.Picture);
                        p.IsContact = true;
                    }
                }

                // ---- 2) Household members (only when the caller holds family.use) ----
                // Resolve the caller's household exactly as PresenceEndpoints does (by membership), then
                // join its members to Users. A household is private — only the caller's own is ever read.
                var householdUserIds = new HashSet<int>();
                if (hasFamily)
                {
                    var householdId = await db.HouseholdMembers.AsNoTracking()
                        .Where(m => m.UserId == caller.Id)
                        .Select(m => (int?)m.HouseholdId)
                        .FirstOrDefaultAsync(ct);

                    if (householdId is int hid)
                    {
                        var members = await db.HouseholdMembers.AsNoTracking()
                            .Where(m => m.HouseholdId == hid)
                            .Join(db.Users.AsNoTracking(), m => m.UserId, u => u.Id, (m, u) => new
                            {
                                u.Id, u.Name, u.DisplayNameMode, u.Nickname, u.Picture,
                                u.IsEnabled, m.Role, u.LocationShareHousehold,
                            })
                            .ToListAsync(ct);

                        foreach (var m in members)
                        {
                            householdUserIds.Add(m.Id);
                            // A household member is shown even if disabled? No — keep parity with the
                            // family DTO which joins on the live user; a disabled user simply won't render
                            // a sensible name. We include all members (the family page does), but flag self.
                            var p = GetOrAdd(people, m.Id, m.Name, m.DisplayNameMode, m.Nickname, m.Picture);
                            p.IsHousehold = true;
                            p.Role = m.Role;
                            p.LocationShareHousehold = m.LocationShareHousehold;
                        }
                    }
                }

                // The caller themselves appears via their own household membership (owner). They are never
                // their own contact (self-contacts are never written), so flag self off the household path.
                if (people.TryGetValue(caller.Id, out var selfRow)) selfRow.IsSelf = true;

                if (people.Count == 0) return Results.Ok(new List<PersonDto>());

                // ---- 3) Presence join (reuse the in-memory tracker; honor appear-offline) ----
                // Online emails → AppUser id + the presence prefs, in ONE round-trip (same as the presence
                // endpoint). We only need the rows for people already in the union.
                var online = presence.Online(PresenceTracker.DefaultWindow);
                var onlineByEmail = online.ToDictionary(e => e.Email, StringComparer.OrdinalIgnoreCase);
                var onlineEmails = online.Select(e => e.Email).ToArray();

                var presenceRows = onlineEmails.Length == 0
                    ? new List<PresenceRow>()
                    : await db.Users.AsNoTracking()
                        .Where(u => onlineEmails.Contains(u.Email))
                        .Select(u => new PresenceRow(u.Id, u.Email, u.AppearOffline))
                        .ToListAsync(ct);

                foreach (var row in presenceRows)
                {
                    if (!people.TryGetValue(row.Id, out var p)) continue; // online but not in the caller's people
                    var isSelf = row.Id == caller.Id;

                    // Appear-offline: a person hiding presence reads offline to everyone but themselves.
                    if (row.AppearOffline && !isSelf) continue;

                    p.Online = true;
                    if (onlineByEmail.TryGetValue(row.Email, out var entry))
                    {
                        p.LastSeenUtc = entry.LastSeenUtc;
                        p.City = entry.City;
                    }
                }

                // ---- 4) Status (opt-in, sanitized at write) for everyone in the union, one query ----
                var ids = people.Keys.ToArray();
                var statusById = (await db.Users.AsNoTracking()
                        .Where(u => ids.Contains(u.Id) && u.PresenceStatus != null)
                        .Select(u => new { u.Id, u.PresenceStatus })
                        .ToListAsync(ct))
                    .ToDictionary(x => x.Id, x => x.PresenceStatus);

                // ---- 5) Project, applying the SAME city-privacy + DM gates the source endpoints use ----
                var result = people.Values
                    .Select(p =>
                    {
                        var isSelf = p.UserId == caller.Id;

                        // City is shown to self always; to others only when THEY share-to-household AND are
                        // a fellow member of the caller's household — identical to PresenceEndpoints.
                        var sharesLocation = !isSelf
                            && p.IsHousehold && p.LocationShareHousehold && householdUserIds.Contains(p.UserId);
                        var cityVisible = isSelf || sharesLocation;

                        // DM gate mirror: a non-admin may DM only a contact; chat.contacts.manage bypasses.
                        // Never offer DM-self.
                        var canDm = !isSelf && (p.IsContact || canManageContacts);

                        return new PersonDto
                        {
                            UserId = p.UserId,
                            Name = DisplayName.Format(p.Name, p.DisplayNameMode, p.Nickname),
                            Picture = p.Picture,
                            IsContact = p.IsContact,
                            IsHousehold = p.IsHousehold,
                            Role = p.IsHousehold ? p.Role : null,
                            IsSelf = isSelf,
                            Online = p.Online,
                            Status = statusById.GetValueOrDefault(p.UserId),
                            LastSeenUtc = p.Online ? p.LastSeenUtc : null,
                            City = cityVisible ? p.City : null,
                            CanDm = canDm,
                            SharesLocation = sharesLocation,
                        };
                    })
                    // Self first, then online, then by display name — a stable, useful order.
                    .OrderByDescending(p => p.IsSelf)
                    .ThenByDescending(p => p.Online)
                    .ThenBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                return Results.Ok(result);
            })
            .RequireAnyPermission(Permissions.ChatRead, Permissions.FamilyUse);
    }

    /// <summary>The online-presence row we need from Users to map an online email → id and honor
    /// appear-offline. (No email ever leaves the handler.)</summary>
    private sealed record PresenceRow(int Id, string Email, bool AppearOffline);

    /// <summary>Mutable accumulator while we union contacts + household members by AppUser id.</summary>
    private sealed class Acc
    {
        public int UserId;
        public string? Name;
        public DisplayNameMode DisplayNameMode;
        public string? Nickname;
        public string? Picture;
        public bool IsContact;
        public bool IsHousehold;
        public string? Role;
        public bool IsSelf;
        public bool Online;
        public DateTime? LastSeenUtc;
        public string? City;
        public bool LocationShareHousehold;
    }

    private static Acc GetOrAdd(
        Dictionary<int, Acc> map, int id, string? name,
        DisplayNameMode mode, string? nickname, string? picture)
    {
        if (!map.TryGetValue(id, out var acc))
        {
            acc = new Acc
            {
                UserId = id, Name = name, DisplayNameMode = mode, Nickname = nickname, Picture = picture,
            };
            map[id] = acc;
        }
        return acc;
    }
}
