using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Ccusage.Api.Tests.Integration;

/// <summary>
/// Direct coverage for the consolidated <see cref="ContactGraph"/> service (the one source of truth for
/// the chat contact circle). Drives the service against the real DB through a DI scope:
/// <list type="bullet">
///   <item><see cref="ContactGraph.IsContactAsync"/>: a mutual pair is true in BOTH directions; a
///   one-directional row is true only that way; no edge is false; a self-check is false; emails are
///   matched case-insensitively.</item>
///   <item><see cref="ContactGraph.EnsureMutualAsync"/>: writes BOTH directed rows, is idempotent (no
///   duplicate rows on re-run), and is a no-op for a self-pair.</item>
///   <item><see cref="ContactGraph.SharingUsers"/>: returns only the caller's mutual contacts who share
///   their tracker, never the caller, never a non-sharer, never a one-directional contact.</item>
/// </list>
/// </summary>
[Collection(IntegrationCollection.Name)]
public class ContactGraphTests(WebAppFactory factory)
{
    private async Task<T> InScopeAsync<T>(Func<UsageDbContext, Task<T>> body)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<UsageDbContext>();
        return await body(db);
    }

    private static string Email() => $"cg-{Guid.NewGuid():N}@test.local";

    private static async Task<string> SeedUserAsync(UsageDbContext db, bool enabled = true)
    {
        var email = Email();
        db.Users.Add(new AppUser { Email = email, Name = "", IsEnabled = enabled, CreatedUtc = DateTime.UtcNow });
        await db.SaveChangesAsync();
        return email;
    }

    private static async Task AddEdgeAsync(UsageDbContext db, string owner, string contact)
    {
        db.ChatContacts.Add(new ChatContact
        {
            OwnerEmail = owner, ContactEmail = contact, CreatedUtc = DateTime.UtcNow, AddedByEmail = owner,
        });
        await db.SaveChangesAsync();
    }

    private static async Task SetSharingAsync(UsageDbContext db, string email, bool share)
    {
        db.TrackerProfiles.Add(new TrackerProfile { UserEmail = email, ShareWithContacts = share });
        await db.SaveChangesAsync();
    }

    // ---- IsContactAsync ----

    [Fact]
    public async Task IsContact_is_true_in_both_directions_for_a_mutual_pair()
    {
        await InScopeAsync(async db =>
        {
            var a = await SeedUserAsync(db);
            var b = await SeedUserAsync(db);
            await ContactGraph.EnsureMutualAsync(db, a, b, a);

            (await ContactGraph.IsContactAsync(db, a, b)).Should().BeTrue();
            (await ContactGraph.IsContactAsync(db, b, a)).Should().BeTrue();
            return true;
        });
    }

    [Fact]
    public async Task IsContact_is_only_true_for_the_direction_that_exists_when_one_sided()
    {
        await InScopeAsync(async db =>
        {
            var a = await SeedUserAsync(db);
            var b = await SeedUserAsync(db);
            // ONLY the a->b row (simulate a legacy/partial state, not via EnsureMutual).
            await AddEdgeAsync(db, a, b);

            (await ContactGraph.IsContactAsync(db, a, b)).Should().BeTrue();
            (await ContactGraph.IsContactAsync(db, b, a)).Should().BeFalse();
            return true;
        });
    }

    [Fact]
    public async Task IsContact_is_false_with_no_edge_and_for_a_self_check()
    {
        await InScopeAsync(async db =>
        {
            var a = await SeedUserAsync(db);
            var b = await SeedUserAsync(db);

            (await ContactGraph.IsContactAsync(db, a, b)).Should().BeFalse();
            (await ContactGraph.IsContactAsync(db, a, a)).Should().BeFalse(); // self is never a contact
            return true;
        });
    }

    [Fact]
    public async Task IsContact_matches_case_insensitively()
    {
        await InScopeAsync(async db =>
        {
            var a = await SeedUserAsync(db); // already lower-cased
            var b = await SeedUserAsync(db);
            await ContactGraph.EnsureMutualAsync(db, a, b, a);

            (await ContactGraph.IsContactAsync(db, a.ToUpperInvariant(), b.ToUpperInvariant())).Should().BeTrue();
            return true;
        });
    }

    // ---- EnsureMutualAsync ----

    [Fact]
    public async Task EnsureMutual_writes_both_rows_and_is_idempotent()
    {
        await InScopeAsync(async db =>
        {
            var a = await SeedUserAsync(db);
            var b = await SeedUserAsync(db);

            await ContactGraph.EnsureMutualAsync(db, a, b, a);
            await ContactGraph.EnsureMutualAsync(db, a, b, a); // re-run: must not duplicate
            await ContactGraph.EnsureMutualAsync(db, b, a, b); // reverse arg order: still the same pair

            var rows = await db.ChatContacts.AsNoTracking()
                .Where(c => (c.OwnerEmail == a && c.ContactEmail == b) || (c.OwnerEmail == b && c.ContactEmail == a))
                .ToListAsync();
            rows.Should().HaveCount(2); // exactly the two directed rows, no duplicates
            return true;
        });
    }

    [Fact]
    public async Task EnsureMutual_is_a_no_op_for_a_self_pair()
    {
        await InScopeAsync(async db =>
        {
            var a = await SeedUserAsync(db);
            await ContactGraph.EnsureMutualAsync(db, a, a, a);

            (await db.ChatContacts.AsNoTracking().AnyAsync(c => c.OwnerEmail == a && c.ContactEmail == a))
                .Should().BeFalse();
            return true;
        });
    }

    // ---- SharingUsers ----

    [Fact]
    public async Task SharingUsers_returns_only_mutual_contacts_who_share_their_tracker()
    {
        await InScopeAsync(async db =>
        {
            var caller = await SeedUserAsync(db);
            var sharer = await SeedUserAsync(db);     // mutual contact + sharing  => INCLUDED
            var nonSharer = await SeedUserAsync(db);  // mutual contact + NOT sharing => excluded
            var oneSided = await SeedUserAsync(db);   // only caller->oneSided + sharing => excluded
            var stranger = await SeedUserAsync(db);   // no edge + sharing => excluded

            await ContactGraph.EnsureMutualAsync(db, caller, sharer, caller);
            await ContactGraph.EnsureMutualAsync(db, caller, nonSharer, caller);
            await AddEdgeAsync(db, caller, oneSided); // only caller->oneSided (NOT mutual)
            await SetSharingAsync(db, sharer, true);
            await SetSharingAsync(db, nonSharer, false);
            await SetSharingAsync(db, oneSided, true);
            await SetSharingAsync(db, stranger, true);

            var emails = await ContactGraph.SharingUsers(db, caller).Select(u => u.Email).ToListAsync();

            emails.Should().Contain(sharer);
            emails.Should().NotContain(new[] { caller, nonSharer, oneSided, stranger });
            return true;
        });
    }
}
