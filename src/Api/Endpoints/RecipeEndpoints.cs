using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// "My Recipes" — a per-user recipe book (<c>/api/recipes</c>), gated by <see cref="Permissions.RecipesUse"/>.
/// Identity comes from the JWT; every row is OWNER-SCOPED by the lower-cased caller email.
///
/// VISIBILITY (the privacy core, enforced server-side):
/// <list type="bullet">
///   <item>A caller may always read AND write their OWN recipes.</item>
///   <item>A caller may READ someone else's recipe iff its owner set <c>ShareWithContacts=true</c> AND the
///   caller is in that owner's mutual chat circle (a <see cref="ChatContact"/> row OwnerEmail=owner,
///   ContactEmail=caller). Otherwise 404 — never leak that the recipe exists.</item>
///   <item>WRITES (create/update/delete/share-toggle) are OWNER-ONLY. A foreign or missing id is a 404.</item>
/// </list>
/// No email is ever put on the wire — a shared recipe carries only the owner's user id + display name.
/// Mirrors the tracker's <see cref="Permissions.TrackerSelf"/> + <c>ShareWithContacts</c> + ContactGraph pattern.
/// </summary>
public static class RecipeEndpoints
{
    private const int MaxIngredients = 100;
    private const int MaxSteps = 50;

    public static void MapRecipeEndpoints(this WebApplication app)
    {
        var g = app.MapGroup("/api/recipes").RequireAuthorization().RequirePermission(Permissions.RecipesUse);

        // ---- List the caller's own recipes (newest-first) ----
        g.MapGet("/", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var rows = await db.Recipes.AsNoTracking()
                .Where(r => r.OwnerEmail == caller.Email)
                .OrderByDescending(r => r.Id)
                .Include(r => r.Ingredients)
                .ToListAsync(ct);
            return Results.Ok(rows.Select(r => ToDto(r, owned: true)).ToList());
        });

        // ---- Recipes shared TO the caller by their mutual contacts ----
        // Must precede "/{id}" so "shared" isn't parsed as an id.
        g.MapGet("/shared", async (CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;

            // The owners whose circle includes the caller (mutual edges → owner→caller is sufficient).
            var sharingOwners = db.ChatContacts.AsNoTracking()
                .Where(c => c.ContactEmail == caller.Email)
                .Select(c => c.OwnerEmail);

            var rows = await db.Recipes.AsNoTracking()
                .Where(r => r.ShareWithContacts && r.OwnerEmail != caller.Email
                            && sharingOwners.Contains(r.OwnerEmail))
                .OrderByDescending(r => r.Id)
                .Include(r => r.Ingredients)
                .ToListAsync(ct);

            // Resolve owner emails → {id, display name} server-side (never put email on the wire).
            var ownerEmails = rows.Select(r => r.OwnerEmail).Distinct().ToList();
            var owners = await db.Users.AsNoTracking()
                .Where(u => ownerEmails.Contains(u.Email))
                .Select(u => new { u.Email, u.Id, u.Name, u.DisplayNameMode, u.Nickname })
                .ToListAsync(ct);
            var ownerByEmail = owners.ToDictionary(o => o.Email, StringComparer.OrdinalIgnoreCase);

            var dtos = rows.Select(r =>
            {
                var dto = ToDto(r, owned: false);
                if (ownerByEmail.TryGetValue(r.OwnerEmail, out var o))
                {
                    dto.OwnerUserId = o.Id;
                    dto.OwnerName = DisplayName.Format(o.Name, o.DisplayNameMode, o.Nickname);
                }
                return dto;
            }).ToList();
            return Results.Ok(dtos);
        });

        // ---- A single recipe (own, or one shared by a mutual contact) ----
        g.MapGet("/{id:long}", async (long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var r = await db.Recipes.AsNoTracking()
                .Include(x => x.Ingredients)
                .FirstOrDefaultAsync(x => x.Id == id, ct);
            if (r is null) return Results.NotFound();

            var isOwner = string.Equals(r.OwnerEmail, caller.Email, StringComparison.OrdinalIgnoreCase);
            if (!isOwner)
            {
                // Visible only when shared AND the owner has the caller in their circle. Else 404 (no leak).
                if (!r.ShareWithContacts
                    || !await ContactGraph.IsContactAsync(db, r.OwnerEmail, caller.Email, ct))
                    return Results.NotFound();
            }

            var dto = ToDto(r, owned: isOwner);
            if (!isOwner)
            {
                var o = await db.Users.AsNoTracking()
                    .Where(u => u.Email == r.OwnerEmail)
                    .Select(u => new { u.Id, u.Name, u.DisplayNameMode, u.Nickname })
                    .FirstOrDefaultAsync(ct);
                if (o is not null)
                {
                    dto.OwnerUserId = o.Id;
                    dto.OwnerName = DisplayName.Format(o.Name, o.DisplayNameMode, o.Nickname);
                }
            }
            return Results.Ok(dto);
        });

        // ---- Create a recipe (OWN) ----
        g.MapPost("/", async (
            RecipeUpsertRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            if (string.IsNullOrWhiteSpace(req?.Title))
                return Results.BadRequest(new { message = "A title is required." });

            var now = DateTime.UtcNow;
            var r = new Recipe
            {
                OwnerEmail = caller.Email,
                ShareWithContacts = req.ShareWithContacts ?? false,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            ApplyFields(r, req);
            db.Recipes.Add(r);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(r, owned: true));
        });

        // ---- Save a what-to-eat / recipe-breakdown PROPOSAL as a recipe (the "export a recipe") ----
        g.MapPost("/from-breakdown", async (
            RecipeFromBreakdownRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            if (string.IsNullOrWhiteSpace(req?.Title))
                return Results.BadRequest(new { message = "A title is required." });

            var now = DateTime.UtcNow;
            var r = new Recipe
            {
                OwnerEmail = caller.Email,
                Title = Clamp(req.Title, 200),
                Servings = req.Servings is int s && s >= 1 ? s : 1,
                Calories = Math.Max(0, req.Macros?.Calories ?? 0),
                ProteinG = Math.Max(0, req.Macros?.Protein ?? 0),
                CarbG = Math.Max(0, req.Macros?.Carb ?? 0),
                FatG = Math.Max(0, req.Macros?.Fat ?? 0),
                Steps = JoinSteps(req.Steps),
                ShareWithContacts = false,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            r.Ingredients = BuildIngredients(req.Ingredients?.Select(i => (i.Name, i.Quantity)));
            db.Recipes.Add(r);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(r, owned: true));
        });

        // ---- Update a recipe (OWN; foreign/missing → 404) ----
        g.MapPut("/{id:long}", async (
            long id, RecipeUpsertRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            if (string.IsNullOrWhiteSpace(req?.Title))
                return Results.BadRequest(new { message = "A title is required." });

            var r = await db.Recipes.Include(x => x.Ingredients)
                .FirstOrDefaultAsync(x => x.Id == id && x.OwnerEmail == caller.Email, ct);
            if (r is null) return Results.NotFound();

            ApplyFields(r, req);
            if (req.ShareWithContacts is bool share) r.ShareWithContacts = share;
            r.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(r, owned: true));
        });

        // ---- Toggle share-with-contacts (OWN) ----
        g.MapPut("/{id:long}/share", async (
            long id, RecipeShareRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var r = await db.Recipes
                .FirstOrDefaultAsync(x => x.Id == id && x.OwnerEmail == caller.Email, ct);
            if (r is null) return Results.NotFound();

            r.ShareWithContacts = req?.ShareWithContacts ?? false;
            r.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { r.Id, r.ShareWithContacts });
        });

        // ---- Delete a recipe (OWN; foreign/missing → 404) ----
        g.MapDelete("/{id:long}", async (
            long id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var deleted = await db.Recipes
                .Where(x => x.Id == id && x.OwnerEmail == caller.Email)
                .ExecuteDeleteAsync(ct); // cascade removes the ingredient rows
            return deleted == 0 ? Results.NotFound() : Results.NoContent();
        });
    }

    // ===================================================================================
    // Helpers
    // ===================================================================================

    /// <summary>Apply the editable scalar + ingredient fields from an upsert request (NOT the share flag,
    /// which create/update handle explicitly so a null leaves an existing value unchanged on update).</summary>
    private static void ApplyFields(Recipe r, RecipeUpsertRequest req)
    {
        r.Title = Clamp(req.Title!, 200);
        r.Servings = req.Servings is int s && s >= 1 ? s : 1;
        r.Calories = Math.Max(0, req.Calories ?? 0);
        r.ProteinG = Math.Max(0, req.ProteinG ?? 0);
        r.CarbG = Math.Max(0, req.CarbG ?? 0);
        r.FatG = Math.Max(0, req.FatG ?? 0);
        r.Steps = JoinSteps(req.Steps);
        r.Notes = Clamp(req.Notes ?? "", 2000);
        r.Ingredients = BuildIngredients(req.Ingredients?.Select(i => (i.Name, i.Quantity)));
    }

    private static List<Data.Entities.RecipeIngredient> BuildIngredients(
        IEnumerable<(string? Name, string? Quantity)>? src)
    {
        var list = new List<Data.Entities.RecipeIngredient>();
        if (src is null) return list;
        var order = 0;
        foreach (var (name, qty) in src)
        {
            var n = (name ?? "").Trim();
            if (n.Length == 0) continue; // a blank-named ingredient is dropped
            list.Add(new Data.Entities.RecipeIngredient
            {
                Name = Clamp(n, 200),
                Quantity = Clamp((qty ?? "").Trim(), 100),
                SortOrder = order++,
            });
            if (list.Count >= MaxIngredients) break;
        }
        return list;
    }

    private static string JoinSteps(IReadOnlyList<string>? steps)
    {
        if (steps is null || steps.Count == 0) return "";
        var clean = steps.Select(s => (s ?? "").Trim()).Where(s => s.Length > 0).Take(MaxSteps);
        return Clamp(string.Join("\n", clean), 8000);
    }

    private static string Clamp(string s, int max) => s.Length <= max ? s : s[..max];

    private static RecipeDto ToDto(Recipe r, bool owned) => new()
    {
        Id = r.Id,
        Title = r.Title,
        Servings = r.Servings,
        Calories = r.Calories,
        ProteinG = r.ProteinG,
        CarbG = r.CarbG,
        FatG = r.FatG,
        Steps = string.IsNullOrEmpty(r.Steps)
            ? Array.Empty<string>()
            : r.Steps.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
        Notes = r.Notes,
        ShareWithContacts = r.ShareWithContacts,
        Owned = owned,
        CreatedUtc = r.CreatedUtc,
        UpdatedUtc = r.UpdatedUtc,
        Ingredients = (r.Ingredients ?? new())
            .OrderBy(i => i.SortOrder)
            .Select(i => new RecipeIngredientDto(i.Name, i.Quantity))
            .ToList(),
    };

    // ---- DTOs ----

    /// <summary>One ingredient line on the wire: a name + an optional free-text quantity.</summary>
    public sealed record RecipeIngredientDto(string Name, string Quantity);

    /// <summary>Per-serving macros for the save-from-breakdown payload.</summary>
    public sealed record RecipeMacrosDto(int Calories, double Protein, double Carb, double Fat);

    /// <summary>Create/update body for a recipe. On UPDATE, a null <see cref="ShareWithContacts"/> leaves the
    /// stored share flag unchanged; on CREATE it defaults to false.</summary>
    public sealed class RecipeUpsertRequest
    {
        public string? Title { get; set; }
        public int? Servings { get; set; }
        public int? Calories { get; set; }
        public double? ProteinG { get; set; }
        public double? CarbG { get; set; }
        public double? FatG { get; set; }
        public IReadOnlyList<RecipeIngredientDto>? Ingredients { get; set; }
        public IReadOnlyList<string>? Steps { get; set; }
        public string? Notes { get; set; }
        public bool? ShareWithContacts { get; set; }
    }

    /// <summary>The save-as-recipe ("export") body — the same shape a what-to-eat / recipe-breakdown
    /// PROPOSAL carries (title, servings, per-serving macros, ingredients, optional steps).</summary>
    public sealed class RecipeFromBreakdownRequest
    {
        public string? Title { get; set; }
        public int? Servings { get; set; }
        public RecipeMacrosDto? Macros { get; set; }
        public IReadOnlyList<RecipeIngredientDto>? Ingredients { get; set; }
        public IReadOnlyList<string>? Steps { get; set; }
    }

    /// <summary>Share-toggle body.</summary>
    public sealed class RecipeShareRequest
    {
        public bool ShareWithContacts { get; set; }
    }

    /// <summary>A recipe on the wire. For a recipe shared by a contact, <see cref="Owned"/> is false and
    /// <see cref="OwnerUserId"/>/<see cref="OwnerName"/> identify the owner (by id + display name only —
    /// never email).</summary>
    public sealed class RecipeDto
    {
        public long Id { get; set; }
        public string Title { get; set; } = "";
        public int Servings { get; set; }
        public int Calories { get; set; }
        public double ProteinG { get; set; }
        public double CarbG { get; set; }
        public double FatG { get; set; }
        public IReadOnlyList<RecipeIngredientDto> Ingredients { get; set; } = Array.Empty<RecipeIngredientDto>();
        public IReadOnlyList<string> Steps { get; set; } = Array.Empty<string>();
        public string Notes { get; set; } = "";
        public bool ShareWithContacts { get; set; }
        public bool Owned { get; set; }
        public int? OwnerUserId { get; set; }
        public string? OwnerName { get; set; }
        public DateTime CreatedUtc { get; set; }
        public DateTime UpdatedUtc { get; set; }
    }
}
