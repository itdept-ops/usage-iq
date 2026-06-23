using System.Security.Cryptography;
using System.Text;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// The Bill Splitter (<c>/api/bills</c> owner CRUD + receipt-AI + assign, and the PUBLIC anonymous
/// <c>/api/bill-share/{token}</c> claim surface). Owner endpoints are gated by <see cref="Permissions.BillsUse"/>
/// and scoped to the caller's own bills (by email). The receipt-AI route ADDITIONALLY requires
/// <see cref="Permissions.AiVision"/> and never stores the image. The public claim link MIRRORS the dashboard
/// share-link security VERBATIM: a 256-bit token, the SHA-256 HASH is the lookup key, the token is stored
/// AES-GCM-ENCRYPTED at rest (TokenProtector), per-real-client-IP rate limiting (the "share" policy), and the
/// public routes are kept OUT of the action log (see RequestLoggingMiddleware). The public view exposes ONLY
/// the bill items + per-person totals + the owner's intentionally-public payment handles — never an email,
/// never any other bill or user.
/// </summary>
public static class BillEndpoints
{
    /// <summary>Reuse the per-IP public "share" rate-limit policy (60/min) for the anonymous claim surface.</summary>
    private const string PublicRateLimitPolicy = "share";

    public static void MapBillEndpoints(this WebApplication app)
    {
        // ---- Owner CRUD (authenticated; gated by bills.use; scoped to the caller's own bills) ----
        var bills = app.MapGroup("/api/bills")
            .RequireAuthorization()
            .RequirePermission(Permissions.BillsUse);

        // The owner's payment handles (single global config set) — also returned on each bill DTO, but exposed
        // standalone too so the page can render pay-me links before a bill exists.
        bills.MapGet("/payment-handles", (IOptions<PaymentsOptions> pay) =>
            Results.Ok(pay.Value.ToDto()));

        // List the caller's own bills (newest first).
        bills.MapGet("/", async (
            CurrentUserAccessor me, UsageDbContext db, TokenProtector protector, IOptions<PaymentsOptions> pay,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var rows = await db.Bills.AsNoTracking()
                .Include(b => b.Items)
                .Where(b => b.OwnerEmail == caller.Email)
                .OrderByDescending(b => b.Id)
                .ToListAsync(ct);
            var names = await ResolveAssigneeNamesAsync(db, rows, ct);
            return Results.Ok(rows.Select(b => ToDto(b, protector, pay.Value, names)));
        });

        // Read one of the caller's own bills.
        bills.MapGet("/{id:int}", async (
            int id, CurrentUserAccessor me, UsageDbContext db, TokenProtector protector,
            IOptions<PaymentsOptions> pay, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var bill = await OwnedBillAsync(db, caller.Email, id, ct);
            if (bill is null) return Results.NotFound();
            var names = await ResolveAssigneeNamesAsync(db, new[] { bill }, ct);
            return Results.Ok(ToDto(bill, protector, pay.Value, names));
        });

        // Create a bill.
        bills.MapPost("/", async (
            CreateBillRequest req, CurrentUserAccessor me, UsageDbContext db, TokenProtector protector,
            IOptions<PaymentsOptions> pay, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var bill = new Bill
            {
                OwnerEmail = caller.Email,
                OwnerUserId = caller.Id,
                Title = Clamp(req.Title, 200, "Untitled bill"),
                CreatedUtc = DateTime.UtcNow,
                TaxAmount = ClampMoney(req.TaxAmount),
                TipAmount = ClampMoney(req.TipAmount),
                Status = "open",
                ShareEnabled = false,
            };
            db.Bills.Add(bill);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(bill, protector, pay.Value,
                new Dictionary<int, string>()));
        });

        // Update a bill's title/tax/tip/status.
        bills.MapPut("/{id:int}", async (
            int id, UpdateBillRequest req, CurrentUserAccessor me, UsageDbContext db, TokenProtector protector,
            IOptions<PaymentsOptions> pay, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var bill = await OwnedBillAsync(db, caller.Email, id, ct);
            if (bill is null) return Results.NotFound();

            if (req.Title is not null) bill.Title = Clamp(req.Title, 200, bill.Title);
            bill.TaxAmount = ClampMoney(req.TaxAmount);
            bill.TipAmount = ClampMoney(req.TipAmount);
            if (req.Status is not null)
                bill.Status = req.Status.Trim().ToLowerInvariant() == "settled" ? "settled" : "open";
            await db.SaveChangesAsync(ct);

            var names = await ResolveAssigneeNamesAsync(db, new[] { bill }, ct);
            return Results.Ok(ToDto(bill, protector, pay.Value, names));
        });

        // Delete a bill (cascades its items).
        bills.MapDelete("/{id:int}", async (
            int id, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var n = await db.Bills.Where(b => b.OwnerEmail == caller.Email && b.Id == id)
                .ExecuteDeleteAsync(ct);
            return n > 0 ? Results.NoContent() : Results.NotFound();
        });

        // ---- Items ----

        bills.MapPost("/{id:int}/items", async (
            int id, BillItemRequest req, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var bill = await OwnedBillAsync(db, caller.Email, id, ct);
            if (bill is null) return Results.NotFound();

            var item = new BillItem
            {
                BillId = bill.Id,
                Name = Clamp(req.Name, 200, "Item"),
                Amount = ClampMoney(req.Amount) ?? 0m,
            };
            db.BillItems.Add(item);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { item.Id });
        });

        bills.MapPut("/{id:int}/items/{itemId:int}", async (
            int id, int itemId, BillItemRequest req, CurrentUserAccessor me, UsageDbContext db,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var item = await OwnedItemAsync(db, caller.Email, id, itemId, ct);
            if (item is null) return Results.NotFound();
            item.Name = Clamp(req.Name, 200, item.Name);
            item.Amount = ClampMoney(req.Amount) ?? 0m;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        bills.MapDelete("/{id:int}/items/{itemId:int}", async (
            int id, int itemId, CurrentUserAccessor me, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            // Scope the delete to the caller's own bill (the FK ties the item to the bill).
            var n = await db.BillItems
                .Where(i => i.Id == itemId && i.BillId == id
                    && db.Bills.Any(b => b.Id == id && b.OwnerEmail == caller.Email))
                .ExecuteDeleteAsync(ct);
            return n > 0 ? Results.NoContent() : Results.NotFound();
        });

        // Assign an item to a CONTACT (a mutual ChatContact of the owner), or clear (null).
        bills.MapPost("/{id:int}/items/{itemId:int}/assign", async (
            int id, int itemId, AssignItemRequest req, CurrentUserAccessor me, UsageDbContext db,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var item = await OwnedItemAsync(db, caller.Email, id, itemId, ct);
            if (item is null) return Results.NotFound();

            if (req.AssignedToUserId is null)
            {
                item.AssignedToUserId = null;
            }
            else
            {
                // The target must be a real user AND a mutual contact in the owner's circle (both directions
                // are written when a contact is added, so owner->contact existing is sufficient + correct).
                var target = await db.Users.AsNoTracking()
                    .FirstOrDefaultAsync(u => u.Id == req.AssignedToUserId.Value, ct);
                if (target is null) return Results.NotFound();
                var isContact = await ContactGraph.IsContactAsync(db, caller.Email, target.Email, ct);
                if (!isContact)
                    return Results.Json(new { message = "You can only assign items to your contacts." },
                        statusCode: StatusCodes.Status403Forbidden);
                item.AssignedToUserId = target.Id;
            }
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // Owner marks an item settled/unsettled.
        bills.MapPost("/{id:int}/items/{itemId:int}/settle", async (
            int id, int itemId, SettleItemRequest req, CurrentUserAccessor me, UsageDbContext db,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var item = await OwnedItemAsync(db, caller.Email, id, itemId, ct);
            if (item is null) return Results.NotFound();
            item.Settled = req.Settled;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        // ---- Receipt AI (bills.use AND ai.vision; image never stored; 503 when AI off) ----
        bills.MapPost("/{id:int}/receipt", async (
            int id, ImageRequest body, CurrentUserAccessor me, UsageDbContext db, GeminiService gemini,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var bill = await OwnedBillAsync(db, caller.Email, id, ct);
            if (bill is null) return Results.NotFound();

            // Validate the image FIRST so a bad/oversized upload is a clear 400 regardless of config.
            if (!AiEndpoints.TryValidateImageInternal(body, out var base64, out var mime, out var bad)) return bad;
            if (!gemini.IsConfigured)
                return Results.Problem(
                    title: "AI assistance is not configured.",
                    detail: "AI assistance is not configured.",
                    statusCode: StatusCodes.Status503ServiceUnavailable);

            // The image is digested IN-MEMORY and NEVER stored. The result is returned for the owner to review;
            // nothing is saved here.
            var result = await gemini.ReceiptBreakdownAsync(base64, mime, ct);
            return result is null
                ? Results.Problem(
                    title: "AI receipt read unavailable, enter manually.",
                    detail: "AI receipt read unavailable, enter manually.",
                    statusCode: StatusCodes.Status503ServiceUnavailable)
                : Results.Ok(result);
        }).RequirePermission(Permissions.AiVision).RequireRateLimiting(AiEndpoints.PhotoRateLimitPolicy);

        // ---- Share toggle (owner mints/revokes the public claim link) ----
        bills.MapPost("/{id:int}/share", async (
            int id, ShareToggleRequest req, CurrentUserAccessor me, UsageDbContext db, TokenProtector protector,
            CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var bill = await OwnedBillAsync(db, caller.Email, id, ct);
            if (bill is null) return Results.NotFound();

            if (req.Enabled)
            {
                bill.ShareEnabled = true;
                // Mint a token on first enable (re-enabling keeps the existing token so old links keep working).
                if (string.IsNullOrEmpty(bill.ShareTokenHash))
                {
                    var token = GenerateToken();
                    bill.ShareTokenHash = Hash(token);
                    bill.ShareTokenEnc = protector.Protect(token);
                }
            }
            else
            {
                bill.ShareEnabled = false;
            }
            await db.SaveChangesAsync(ct);

            var token2 = bill.ShareEnabled ? protector.Unprotect(bill.ShareTokenEnc) : null;
            return Results.Ok(new
            {
                shareEnabled = bill.ShareEnabled,
                sharePath = token2 is null ? null : $"/bill/{token2}",
            });
        });

        // ============================================================================
        // PUBLIC, anonymous, rate-limited claim surface (mirrors /api/share/{token})
        // ============================================================================

        // Read a live bill by its public token — NO owner email, NO other private data.
        app.MapGet("/api/bill-share/{token}", async (
            string token, UsageDbContext db, IOptions<PaymentsOptions> pay, CancellationToken ct) =>
        {
            var bill = await db.Bills.AsNoTracking()
                .Include(b => b.Items)
                .FirstOrDefaultAsync(b => b.ShareTokenHash == Hash(token), ct);
            // Disabled or missing — indistinguishable to the caller (404).
            if (bill is null || !bill.ShareEnabled) return Results.NotFound();
            return Results.Ok(ToPublicDto(bill, pay.Value));
        }).AllowAnonymous().RequireRateLimiting(PublicRateLimitPolicy);

        // Claim an OPEN item under a display name (anonymous).
        app.MapPost("/api/bill-share/{token}/claim", async (
            string token, ClaimItemRequest req, UsageDbContext db, IOptions<PaymentsOptions> pay,
            CancellationToken ct) =>
        {
            var bill = await db.Bills
                .Include(b => b.Items)
                .FirstOrDefaultAsync(b => b.ShareTokenHash == Hash(token), ct);
            if (bill is null || !bill.ShareEnabled) return Results.NotFound();
            if (bill.Status == "settled")
                return Results.Json(new { message = "This bill is settled." },
                    statusCode: StatusCodes.Status409Conflict);

            var name = Clamp(req.Name, 80, "");
            if (name.Length == 0)
                return Results.BadRequest(new { message = "A display name is required." });

            var item = bill.Items.FirstOrDefault(i => i.Id == req.ItemId);
            if (item is null) return Results.NotFound();
            // Only an OPEN item may be claimed (not assigned, not already claimed).
            if (item.AssignedToUserId is not null || item.ClaimedByName is not null || item.ClaimedByUserId is not null)
                return Results.Json(new { message = "That item has already been claimed." },
                    statusCode: StatusCodes.Status409Conflict);

            item.ClaimedByName = name;
            item.ClaimedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);

            return Results.Ok(ToPublicDto(bill, pay.Value));
        }).AllowAnonymous().RequireRateLimiting(PublicRateLimitPolicy);
    }

    // ===================================================================================
    // Token helpers (VERBATIM mirror of ShareEndpoints)
    // ===================================================================================

    private static string GenerateToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    private static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    // ===================================================================================
    // Owner-scoped lookups
    // ===================================================================================

    private static Task<Bill?> OwnedBillAsync(UsageDbContext db, string email, int id, CancellationToken ct) =>
        db.Bills.Include(b => b.Items).FirstOrDefaultAsync(b => b.OwnerEmail == email && b.Id == id, ct);

    private static async Task<BillItem?> OwnedItemAsync(
        UsageDbContext db, string email, int billId, int itemId, CancellationToken ct)
    {
        var owns = await db.Bills.AsNoTracking().AnyAsync(b => b.Id == billId && b.OwnerEmail == email, ct);
        if (!owns) return null;
        return await db.BillItems.FirstOrDefaultAsync(i => i.Id == itemId && i.BillId == billId, ct);
    }

    /// <summary>Resolve the {AppUser.Id -> Name} display names for every assigned contact across the bills
    /// (the email is never exposed — only the contact's display name).</summary>
    private static async Task<IReadOnlyDictionary<int, string>> ResolveAssigneeNamesAsync(
        UsageDbContext db, IReadOnlyCollection<Bill> bills, CancellationToken ct)
    {
        var ids = bills.SelectMany(b => b.Items)
            .Where(i => i.AssignedToUserId is not null)
            .Select(i => i.AssignedToUserId!.Value)
            .Concat(bills.SelectMany(b => b.Items).Where(i => i.ClaimedByUserId is not null)
                .Select(i => i.ClaimedByUserId!.Value))
            .Distinct().ToList();
        if (ids.Count == 0) return new Dictionary<int, string>();
        return await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => string.IsNullOrEmpty(u.Name) ? "Unknown user" : u.Name, ct);
    }

    // ===================================================================================
    // Clamps
    // ===================================================================================

    private const decimal MaxMoney = 1_000_000m;

    private static string Clamp(string? s, int max, string fallback)
    {
        var t = (s ?? "").Trim();
        if (t.Length == 0) return fallback;
        return t.Length > max ? t[..max] : t;
    }

    /// <summary>Clamp an optional money amount into [0, MaxMoney] at 2 decimals; null stays null, negatives -> 0.</summary>
    private static decimal? ClampMoney(decimal? v)
    {
        if (v is null) return null;
        var m = Math.Round(Math.Clamp(v.Value, 0m, MaxMoney), 2, MidpointRounding.AwayFromZero);
        return m;
    }

    // ===================================================================================
    // Per-person totals + DTO mapping
    // ===================================================================================

    /// <summary>
    /// Compute each person's total: the sum of their claimed/assigned item amounts PLUS a PROPORTIONAL share
    /// of tax+tip (their assigned-items fraction of the assigned-items grand total). Items with no
    /// assignee/claimer are "open" and excluded from every person's total (rolled up into UnclaimedTotal).
    /// The optional <paramref name="assigneeNames"/> resolves an assigned contact's id to a display name.
    /// </summary>
    private static (List<PersonTotalDto> people, decimal unclaimed) ComputeTotals(
        Bill bill, IReadOnlyDictionary<int, string> assigneeNames)
    {
        var taxTip = (bill.TaxAmount ?? 0m) + (bill.TipAmount ?? 0m);

        // Bucket each NON-open item under a person key (a contact's display name, or a public claimer's name).
        var buckets = new Dictionary<string, decimal>(StringComparer.OrdinalIgnoreCase);
        decimal unclaimed = 0m;
        decimal assignedTotal = 0m;

        foreach (var i in bill.Items)
        {
            string? person = null;
            if (i.AssignedToUserId is { } aid)
                person = assigneeNames.TryGetValue(aid, out var n) ? n : "Unknown user";
            else if (i.ClaimedByUserId is { } cid)
                person = assigneeNames.TryGetValue(cid, out var n) ? n : (i.ClaimedByName ?? "Unknown user");
            else if (!string.IsNullOrEmpty(i.ClaimedByName))
                person = i.ClaimedByName;

            if (person is null) { unclaimed += i.Amount; continue; }

            buckets[person] = buckets.TryGetValue(person, out var cur) ? cur + i.Amount : i.Amount;
            assignedTotal += i.Amount;
        }

        var people = new List<PersonTotalDto>();
        foreach (var (name, itemsTotal) in buckets.OrderByDescending(kv => kv.Value))
        {
            // Proportional tax/tip share: this person's fraction of the assigned-items grand total.
            var share = assignedTotal > 0m
                ? Math.Round(taxTip * (itemsTotal / assignedTotal), 2, MidpointRounding.AwayFromZero)
                : 0m;
            people.Add(new PersonTotalDto
            {
                Name = name,
                ItemsTotal = itemsTotal,
                TaxTipShare = share,
                Total = itemsTotal + share,
            });
        }
        return (people, unclaimed);
    }

    private static BillDto ToDto(
        Bill bill, TokenProtector protector, PaymentsOptions pay,
        IReadOnlyDictionary<int, string> assigneeNames)
    {
        var (people, unclaimed) = ComputeTotals(bill, assigneeNames);
        var token = bill.ShareEnabled ? protector.Unprotect(bill.ShareTokenEnc) : null;

        return new BillDto
        {
            Id = bill.Id,
            Title = bill.Title,
            CreatedUtc = bill.CreatedUtc,
            TaxAmount = bill.TaxAmount,
            TipAmount = bill.TipAmount,
            Status = bill.Status,
            ShareEnabled = bill.ShareEnabled,
            SharePath = token is null ? null : $"/bill/{token}",
            Items = bill.Items.OrderBy(i => i.Id).Select(i => new BillItemDto
            {
                Id = i.Id,
                Name = i.Name,
                Amount = i.Amount,
                AssignedToUserId = i.AssignedToUserId,
                AssignedToName = i.AssignedToUserId is { } aid && assigneeNames.TryGetValue(aid, out var an) ? an : null,
                ClaimedByName = i.ClaimedByName,
                ClaimedByUserId = i.ClaimedByUserId,
                ClaimedUtc = i.ClaimedUtc,
                Settled = i.Settled,
                Open = i.AssignedToUserId is null && i.ClaimedByUserId is null && string.IsNullOrEmpty(i.ClaimedByName),
            }).ToList(),
            PersonTotals = people,
            UnclaimedTotal = unclaimed,
            Payments = pay.ToDto(),
        };
    }

    /// <summary>The PUBLIC view — items + per-person totals + payment handles. NO owner email, NO ids that
    /// could de-anonymize, NO other bill/user data. Per-person buckets reuse the same proportional roll-up,
    /// but here assigned-contact names come from the item's claimer name only (assignees are shown as a
    /// claimed item without leaking the contact's identity beyond the display name already on the bucket).</summary>
    private static PublicBillDto ToPublicDto(Bill bill, PaymentsOptions pay)
    {
        // The public view must not resolve assignee USER names from the Users table (that could leak who a
        // contact is); per-person buckets are built from public claimer names only. Assigned-but-unclaimed
        // items therefore count as "taken" (not open) but contribute to no named bucket — they're neither
        // open for claiming nor attributed to a name on the public page.
        var taxTip = (bill.TaxAmount ?? 0m) + (bill.TipAmount ?? 0m);
        var buckets = new Dictionary<string, decimal>(StringComparer.OrdinalIgnoreCase);
        decimal unclaimed = 0m;
        decimal namedTotal = 0m;

        foreach (var i in bill.Items)
        {
            var open = i.AssignedToUserId is null && i.ClaimedByUserId is null && string.IsNullOrEmpty(i.ClaimedByName);
            if (open) { unclaimed += i.Amount; continue; }
            if (!string.IsNullOrEmpty(i.ClaimedByName))
            {
                buckets[i.ClaimedByName!] = buckets.TryGetValue(i.ClaimedByName!, out var cur)
                    ? cur + i.Amount : i.Amount;
                namedTotal += i.Amount;
            }
        }

        var people = buckets.OrderByDescending(kv => kv.Value).Select(kv =>
        {
            var share = namedTotal > 0m
                ? Math.Round(taxTip * (kv.Value / namedTotal), 2, MidpointRounding.AwayFromZero)
                : 0m;
            return new PersonTotalDto
            {
                Name = kv.Key, ItemsTotal = kv.Value, TaxTipShare = share, Total = kv.Value + share,
            };
        }).ToList();

        return new PublicBillDto
        {
            Title = bill.Title,
            Status = bill.Status,
            TaxAmount = bill.TaxAmount,
            TipAmount = bill.TipAmount,
            Items = bill.Items.OrderBy(i => i.Id).Select(i => new PublicBillItemDto
            {
                Id = i.Id,
                Name = i.Name,
                Amount = i.Amount,
                Open = i.AssignedToUserId is null && i.ClaimedByUserId is null && string.IsNullOrEmpty(i.ClaimedByName),
                ClaimedByName = i.ClaimedByName,
                Settled = i.Settled,
            }).ToList(),
            PersonTotals = people,
            UnclaimedTotal = unclaimed,
            Payments = pay.ToDto(),
        };
    }
}
