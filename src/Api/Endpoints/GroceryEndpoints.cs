using System.Text.RegularExpressions;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// "Grocery" — the standalone Tools shortcut to the household's single <c>Groceries</c> shopping list
/// (<c>/api/grocery</c>). Gated by <see cref="Permissions.FamilyUse"/> (the household-data group) PLUS the
/// dedicated <see cref="Permissions.GroceryUse"/> so the Tool can be granted independently of the wider Hub.
///
/// This is a THIN wrapper over the same household "Groceries" <see cref="FamilyList"/> that the meal-planner
/// and recipe-breakdown already append to: it find-or-creates that one list (never invents a second), and
/// supports add / toggle-done / delete / reorder of its items. Identity comes from the JWT; the list is
/// HOUSEHOLD-scoped (private to the caller's household, visible to all members) — a solo user transparently
/// gets a one-person household. No email is ever put on the wire (the returned <see cref="FamilyNotesListsEndpoints.ListDto"/>
/// carries only AppUser ids + display names).
///
/// The QUANTITY-AWARE add (<c>POST /api/grocery/items/quantity</c>) is the one behaviour the family list
/// model doesn't have: adding "Milk" when "Milk x2" is already on the list bumps it to "Milk x3" instead of
/// creating a duplicate, by parsing/rewriting a trailing "xN" suffix. Plain adds keep the existing de-dupe.
/// </summary>
public static class GroceryEndpoints
{
    /// <summary>Upper bound on caller-supplied add quantity (keeps a hostile payload from inflating "xN").</summary>
    private const int MaxAddQuantity = 999;

    /// <summary>Matches a trailing " xN" quantity suffix (case-insensitive, optional spaces around the x).</summary>
    private static readonly Regex QtySuffix = new(@"\s*[xX]\s*(\d{1,3})\s*$", RegexOptions.Compiled);

    public sealed record GroceryAddRequest(string? Text);
    public sealed record GroceryQuantityAddRequest(string? Text, int? Quantity);
    public sealed record GroceryToggleRequest(bool? Done);
    public sealed record GroceryReorderRequest(IReadOnlyList<long>? ItemIds);

    public static void MapGroceryEndpoints(this WebApplication app)
    {
        // family.use (the household-data group) + the dedicated grocery.use, so the Tool is independently grantable.
        var g = app.MapGroup("/api/grocery")
            .RequireAuthorization()
            .RequirePermission(Permissions.FamilyUse)
            .RequirePermission(Permissions.GroceryUse);

        // ---- GET /api/grocery : the household's Groceries list (find-or-create) ----
        g.MapGet("/", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var list = await FamilyMealsChoresEndpoints.FindOrCreateGroceriesAsync(db, household.Id, caller.Id, ct);
            return Results.Ok(await FamilyNotesListsEndpoints.LoadListDtoAsync(db, list.Id, caller.Id, household.Id, ct));
        });

        // ---- POST /api/grocery/items : add one item (plain de-dupe against open items) ----
        g.MapPost("/items", async (
            GroceryAddRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var list = await FamilyMealsChoresEndpoints.FindOrCreateGroceriesAsync(db, household.Id, caller.Id, ct);

            var text = (req?.Text ?? "").Trim();
            if (text.Length == 0) return Results.BadRequest(new { message = "Item text is required." });

            await FamilyMealsChoresEndpoints.AppendLinesToListAsync(db, list.Id, new[] { text }, ct);
            return Results.Ok(await FamilyNotesListsEndpoints.LoadListDtoAsync(db, list.Id, caller.Id, household.Id, ct));
        });

        // ---- POST /api/grocery/items/quantity : qty-aware add (increment an existing match's "xN" or append) ----
        // "Milk" + qty 1 onto a list already holding "Milk x2" -> "Milk x3" (no duplicate row). A brand-new item
        // is appended with its "xN" suffix only when qty > 1 (qty 1 stays a plain "Milk"). Matching is on the
        // base NAME (the "xN" stripped), case/space-insensitively — the same normalization the de-dupe uses.
        g.MapPost("/items/quantity", async (
            GroceryQuantityAddRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var list = await FamilyMealsChoresEndpoints.FindOrCreateGroceriesAsync(db, household.Id, caller.Id, ct);

            // The caller passes a clean NAME; if they embed an "xN" we honour it as the add amount.
            var (baseName, suppliedQty) = SplitQuantity((req?.Text ?? "").Trim());
            if (baseName.Length == 0) return Results.BadRequest(new { message = "Item text is required." });
            var addQty = Math.Clamp(req?.Quantity ?? suppliedQty ?? 1, 1, MaxAddQuantity);

            // Find an existing OPEN item whose base name matches (ignoring its own "xN" + case/space).
            var openItems = await db.FamilyListItems
                .Where(i => i.ListId == list.Id && !i.Done)
                .ToListAsync(ct);
            var key = FamilyMealsChoresEndpoints.Normalize(baseName);
            var match = openItems.FirstOrDefault(i =>
                FamilyMealsChoresEndpoints.Normalize(SplitQuantity(i.Text).BaseName) == key);

            var now = DateTime.UtcNow;
            if (match is not null)
            {
                var current = SplitQuantity(match.Text).Quantity ?? 1;
                var next = Math.Clamp(current + addQty, 1, MaxAddQuantity);
                match.Text = ComposeQuantity(SplitQuantity(match.Text).BaseName, next);
            }
            else
            {
                var maxSort = await db.FamilyListItems.Where(i => i.ListId == list.Id)
                    .Select(i => (int?)i.SortOrder).MaxAsync(ct) ?? -1;
                db.FamilyListItems.Add(new FamilyListItem
                {
                    ListId = list.Id,
                    Text = ComposeQuantity(baseName, addQty),
                    SortOrder = maxSort + 1,
                    CreatedUtc = now,
                });
            }
            await db.FamilyLists.Where(l => l.Id == list.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(l => l.UpdatedUtc, now), ct);
            await db.SaveChangesAsync(ct);

            return Results.Ok(await FamilyNotesListsEndpoints.LoadListDtoAsync(db, list.Id, caller.Id, household.Id, ct));
        });

        // ---- PATCH /api/grocery/items/{itemId} : toggle done (stamps/clears who checked it) ----
        g.MapPatch("/items/{itemId:long}", async (
            long itemId, GroceryToggleRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var list = await FamilyMealsChoresEndpoints.FindOrCreateGroceriesAsync(db, household.Id, caller.Id, ct);

            var item = await db.FamilyListItems.FirstOrDefaultAsync(i => i.Id == itemId && i.ListId == list.Id, ct);
            if (item is null) return NotFound();

            var done = req?.Done ?? !item.Done;
            item.Done = done;
            item.DoneByUserId = done ? caller.Id : null;
            list.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await FamilyNotesListsEndpoints.LoadListDtoAsync(db, list.Id, caller.Id, household.Id, ct));
        });

        // ---- DELETE /api/grocery/items/{itemId} : remove an item ----
        g.MapDelete("/items/{itemId:long}", async (
            long itemId, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var list = await FamilyMealsChoresEndpoints.FindOrCreateGroceriesAsync(db, household.Id, caller.Id, ct);

            var existed = await db.FamilyListItems.FirstOrDefaultAsync(i => i.Id == itemId && i.ListId == list.Id, ct);
            if (existed is null) return NotFound();

            await db.FamilyListItems.Where(i => i.Id == itemId && i.ListId == list.Id).ExecuteDeleteAsync(ct);
            list.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await FamilyNotesListsEndpoints.LoadListDtoAsync(db, list.Id, caller.Id, household.Id, ct));
        });

        // ---- PUT /api/grocery/reorder : set the manual order from a full/partial id sequence ----
        // Items named in itemIds take ascending SortOrder in that order; any items NOT named keep their relative
        // order after them. Foreign ids are ignored (the list is the caller's own household Groceries).
        g.MapPut("/reorder", async (
            GroceryReorderRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;
            var list = await FamilyMealsChoresEndpoints.FindOrCreateGroceriesAsync(db, household.Id, caller.Id, ct);

            var items = await db.FamilyListItems.Where(i => i.ListId == list.Id)
                .OrderBy(i => i.SortOrder).ThenBy(i => i.Id).ToListAsync(ct);
            var order = (req?.ItemIds ?? Array.Empty<long>())
                .Distinct()
                .Select((id, idx) => (id, idx))
                .ToDictionary(t => t.id, t => t.idx);

            // Named items first (by the supplied order), then the rest in their current order.
            var ranked = items
                .OrderBy(i => order.TryGetValue(i.Id, out var idx) ? idx : int.MaxValue)
                .ThenBy(i => i.SortOrder).ThenBy(i => i.Id)
                .ToList();
            for (var i = 0; i < ranked.Count; i++) ranked[i].SortOrder = i;

            list.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            return Results.Ok(await FamilyNotesListsEndpoints.LoadListDtoAsync(db, list.Id, caller.Id, household.Id, ct));
        });
    }

    /// <summary>Split an item's text into its base NAME and an optional trailing "xN" quantity. "Milk x2" ->
    /// ("Milk", 2); "Milk" -> ("Milk", null). The quantity is clamped 1..<see cref="MaxAddQuantity"/>.</summary>
    internal static (string BaseName, int? Quantity) SplitQuantity(string text)
    {
        var t = (text ?? "").Trim();
        var m = QtySuffix.Match(t);
        if (!m.Success) return (t, null);
        var baseName = t[..m.Index].Trim();
        if (baseName.Length == 0) return (t, null); // a bare "x2" is a name, not a quantity
        var qty = int.TryParse(m.Groups[1].Value, out var n) ? Math.Clamp(n, 1, MaxAddQuantity) : 1;
        return (baseName, qty);
    }

    /// <summary>Re-compose an item's text from a base name + quantity, clamped (500). Quantity 1 drops the
    /// suffix ("Milk"); quantity &gt;1 appends " xN" ("Milk x3").</summary>
    internal static string ComposeQuantity(string baseName, int quantity)
    {
        var name = (baseName ?? "").Trim();
        var q = Math.Clamp(quantity, 1, MaxAddQuantity);
        var text = q > 1 ? $"{name} x{q}" : name;
        return text.Length > 500 ? text[..500] : text;
    }

    private static IResult NotFound() =>
        Results.NotFound(new { message = "That item doesn't exist." });
}
