using System.Globalization;
using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Ccusage.Api.Endpoints;

/// <summary>
/// Family Hub F5 — household FINANCE from a Rocket Money CSV import (/api/family/finance). Finance is the
/// most sensitive corner of the hub, so EVERY route here is gated by BOTH <see cref="Permissions.FamilyUse"/>
/// AND <see cref="Permissions.FamilyFinance"/> (the extra money gate) on top of <c>.RequireAuthorization()</c>,
/// and obeys the Family Hub privacy rules:
///
/// <list type="bullet">
///   <item>Everything is private to the owning HOUSEHOLD; a cross-household id is a 404 (existence is never
///   leaked). Finance data is NOT shareable to outside contacts — there is no FamilyShare path here.</item>
///   <item>People are exposed by AppUser id + display name ONLY — an email is NEVER put on the wire.</item>
/// </list>
///
/// The importer parses a Rocket Money export (see <see cref="RocketMoneyCsv"/>), find-or-creates a
/// <see cref="FinanceAccount"/> per distinct (Account Name, Institution) — never assuming whose account it
/// is (every account starts owner="unassigned"; the family LABELS each one afterward via PUT /accounts/{id},
/// which is how the two SoFi accounts get told apart) — and inserts DEDUPED <see cref="FinanceTransaction"/>
/// rows so re-importing the same/overlapping export adds nothing. Spending math is EXPENSE-only; income and
/// transfers (incl. credit-card payments) are separated so moving money between your own accounts never
/// looks like spending.
/// </summary>
public static class FamilyFinanceEndpoints
{
    // ---- DTOs (people by userId + name; never email) ----

    public sealed record ImportRequest(string? FileName, string? Content);

    public sealed record AccountSummaryDto(int Id, string Name, string? Institution, string Owner, string Kind);

    public sealed record ImportResultDto(
        long ImportId, int RowCount, int Imported, int Skipped, IReadOnlyList<AccountSummaryDto> Accounts);

    public sealed record AccountDto(
        int Id, string Name, string? Institution, string Owner, string Kind,
        int TxnCount, decimal TotalSpentMagnitude);

    public sealed record AccountPatchRequest(string? Owner, string? Kind, string? Name);

    public sealed record TransactionDto(
        long Id, string Date, string Merchant, string? Category,
        decimal Magnitude, decimal RawAmount, string Kind,
        int AccountId, string AccountName, string Owner);

    public sealed record TransactionsPageDto(
        int Page, int PageSize, int Total, IReadOnlyList<TransactionDto> Items);

    public sealed record CategoryAmountDto(string Category, decimal Amount, double Pct);
    public sealed record AccountAmountDto(int AccountId, string Name, string Owner, decimal Amount);
    public sealed record OwnerAmountDto(string Owner, decimal Amount);
    public sealed record TrendPointDto(string Month, decimal Spent, decimal Income);

    public sealed record SummaryDto(
        string Month, decimal TotalSpent, decimal TotalIncome,
        IReadOnlyList<CategoryAmountDto> ByCategory,
        IReadOnlyList<AccountAmountDto> ByAccount,
        IReadOnlyList<OwnerAmountDto> ByOwner,
        IReadOnlyList<TrendPointDto> MonthlyTrend);

    public sealed record ImportBatchDto(
        long Id, string FileName, int RowCount, int ImportedCount, int SkippedCount,
        int ImportedByUserId, string ImportedByName, DateTime CreatedUtc);

    /// <summary>
    /// The finance "Explain this month" read-only AI summary: a warm 2–4 sentence <see cref="Narrative"/> of
    /// where the money went plus up to 5 short <see cref="Insights"/>, both NARRATED from the same
    /// server-computed numbers GET /summary returns (the model invents nothing). <see cref="FellBackToPlain"/>
    /// is true when Gemini was unconfigured/errored (or the month is empty) and the deterministic plain
    /// floor was returned instead. This endpoint ALWAYS returns 200 — the plain text is the floor — never a
    /// 503/500, and it writes NOTHING.
    /// </summary>
    public sealed record FinanceAiSummaryDto(
        string Narrative, IReadOnlyList<string> Insights, bool FellBackToPlain);

    /// <summary>One detected recurring charge (a subscription/bill that recurs monthly): its display
    /// <see cref="Merchant"/>, the <see cref="TypicalAmount"/> (median of its occurrences), the
    /// <see cref="Cadence"/> ("monthly"), <see cref="MonthsSeen"/> distinct months it appeared in, and the
    /// <see cref="LastDate"/> it was last seen. Computed DETERMINISTICALLY server-side; this list + the
    /// monthly total are the AUTHORITATIVE floor (they work with Gemini off).</summary>
    public sealed record RecurringChargeDto(
        string Merchant, decimal TypicalAmount, string Cadence, int MonthsSeen, string LastDate);

    /// <summary>
    /// The finance "money coach" result. The <see cref="Recurring"/> list + <see cref="MonthlyRecurringTotal"/>
    /// are the DETERMINISTIC, authoritative FLOOR (computed server-side from the household's recent expenses;
    /// they're present whether Gemini is on or off). When Gemini is configured it ALSO NARRATES those facts
    /// into a warm <see cref="Narrative"/> + up to 5 actionable <see cref="Tips"/>; otherwise those are
    /// empty/null and <see cref="FellBackToPlain"/> is true. The coach NEVER cancels or edits anything — advice
    /// only. This endpoint ALWAYS returns 200 (the recurring list is the floor), never a 503/500, and writes
    /// NOTHING.
    /// </summary>
    public sealed record MoneyCoachDto(
        IReadOnlyList<RecurringChargeDto> Recurring, decimal MonthlyRecurringTotal,
        string? Narrative, IReadOnlyList<string> Tips, bool FellBackToPlain);

    private static readonly string[] Owners = { "his", "hers", "joint", "unassigned" };
    private static readonly string[] Kinds = { "bank", "credit", "other" };

    // Cap the uploaded CSV at a sane size (a Rocket Money export of many years is well under this).
    private const int MaxContentBytes = 8 * 1024 * 1024; // 8 MiB
    private const int DefaultPageSize = 50;
    private const int MaxPageSize = 200;

    public static void MapFamilyFinanceEndpoints(this WebApplication app)
    {
        // BOTH gates: family.use AND family.finance. Chaining two RequirePermission filters ANDs them — a
        // caller must clear both to reach any finance route.
        var g = app.MapGroup("/api/family/finance")
            .RequireAuthorization()
            .RequirePermission(Permissions.FamilyUse)
            .RequirePermission(Permissions.FamilyFinance);

        MapImport(g);
        MapAccounts(g);
        MapTransactions(g);
        MapSummary(g);
        MapImportsList(g);
        MapAiSummary(g);
        MapMoneyCoach(g);
    }

    // =====================================================================================
    // IMPORT — parse a Rocket Money CSV, find-or-create accounts, insert deduped transactions
    // =====================================================================================

    private static void MapImport(RouteGroupBuilder g)
    {
        g.MapPost("/import", async (
            ImportRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var content = req.Content ?? "";
            if (string.IsNullOrWhiteSpace(content))
                return Results.BadRequest(new { message = "Paste or upload the Rocket Money CSV to import." });
            if (System.Text.Encoding.UTF8.GetByteCount(content) > MaxContentBytes)
                return Results.BadRequest(new { message = "That CSV is too large to import." });

            var fileName = Clamp(string.IsNullOrWhiteSpace(req.FileName) ? "import.csv" : req.FileName!, 260);

            var parsed = RocketMoneyCsv.Parse(content);

            var now = DateTime.UtcNow;

            // Write the import batch first so transactions can carry its id.
            var batch = new FinanceImport
            {
                HouseholdId = household.Id,
                FileName = fileName,
                RowCount = parsed.RowCount,
                ImportedCount = 0,
                SkippedCount = parsed.SkippedCount,
                ImportedByUserId = caller.Id,
                CreatedUtc = now,
            };
            db.FinanceImports.Add(batch);
            await db.SaveChangesAsync(ct);

            // Find-or-create an account per distinct (name, institution). Load the household's existing
            // accounts once and key them the same way the CSV groups (lower-cased name|institution).
            var existingAccounts = await db.FinanceAccounts
                .Where(a => a.HouseholdId == household.Id)
                .ToListAsync(ct);
            var byKey = existingAccounts.ToDictionary(
                a => RocketMoneyCsv.AccountKey(a.Name, a.Institution ?? ""), a => a);

            // The set of account keys touched by this import (for the response).
            var touched = new HashSet<string>(StringComparer.Ordinal);

            // Pre-load this household's existing dedup hashes so we can skip in-memory and also guard the
            // unique index (a concurrent or overlapping import). We additionally de-dup WITHIN this file.
            var existingHashes = await db.FinanceTransactions
                .Where(t => t.HouseholdId == household.Id)
                .Select(t => t.DedupHash)
                .ToListAsync(ct);
            var seenHashes = new HashSet<string>(existingHashes, StringComparer.Ordinal);

            var imported = 0;
            // Track a running skip count seeded from unparseable rows; dedup hits add to it.
            var skipped = parsed.SkippedCount;

            foreach (var row in parsed.Rows)
            {
                var key = RocketMoneyCsv.AccountKey(row.AccountName, row.Institution);
                touched.Add(key);

                if (!byKey.TryGetValue(key, out var account))
                {
                    account = new FinanceAccount
                    {
                        HouseholdId = household.Id,
                        Name = Clamp(string.IsNullOrWhiteSpace(row.AccountName) ? "Unnamed account" : row.AccountName, 200),
                        // Normalize a missing institution to null on the entity, but key on "" so two rows
                        // with no institution collapse to one account.
                        Institution = string.IsNullOrWhiteSpace(row.Institution) ? null : Clamp(row.Institution, 200),
                        Owner = "unassigned",
                        Kind = RocketMoneyCsv.AccountKind(row.AccountTypeRaw),
                        CreatedUtc = now,
                    };
                    db.FinanceAccounts.Add(account);
                    // Persist immediately so the account gets an Id we can FK the transactions to, and so a
                    // later row for the same account reuses it.
                    await db.SaveChangesAsync(ct);
                    byKey[key] = account;
                }

                var hash = RocketMoneyCsv.DedupHash(key, row.Date, row.RawAmount, row.Merchant, row.Description);
                if (!seenHashes.Add(hash))
                {
                    skipped++; // already present (prior import) or a duplicate within this file
                    continue;
                }

                db.FinanceTransactions.Add(new FinanceTransaction
                {
                    HouseholdId = household.Id,
                    AccountId = account.Id,
                    Date = row.Date,
                    Merchant = row.Merchant,
                    Description = row.Description,
                    Magnitude = row.Magnitude,
                    RawAmount = row.RawAmount,
                    Kind = KindString(row.Kind),
                    Category = row.Category,
                    Note = row.Note,
                    DedupHash = hash,
                    ImportId = batch.Id,
                    CreatedUtc = now,
                });
                imported++;
            }

            // Update the batch's final counts, then persist the transactions.
            batch.ImportedCount = imported;
            batch.SkippedCount = skipped;
            await db.SaveChangesAsync(ct);

            var accounts = byKey.Values
                .Where(a => touched.Contains(RocketMoneyCsv.AccountKey(a.Name, a.Institution ?? "")))
                .OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ThenBy(a => a.Id)
                .Select(a => new AccountSummaryDto(a.Id, a.Name, a.Institution, a.Owner, a.Kind))
                .ToList();

            return Results.Ok(new ImportResultDto(batch.Id, parsed.RowCount, imported, skipped, accounts));
        });
    }

    // =====================================================================================
    // ACCOUNTS — list + relabel (his/hers/joint, kind, name)
    // =====================================================================================

    private static void MapAccounts(RouteGroupBuilder g)
    {
        g.MapGet("/accounts", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var accounts = await db.FinanceAccounts.AsNoTracking()
                .Where(a => a.HouseholdId == household.Id)
                .ToListAsync(ct);

            // Per-account txn count + total EXPENSE magnitude (spending), computed in one grouped read.
            var stats = await db.FinanceTransactions.AsNoTracking()
                .Where(t => t.HouseholdId == household.Id)
                .GroupBy(t => t.AccountId)
                .Select(grp => new
                {
                    AccountId = grp.Key,
                    Count = grp.Count(),
                    Spent = grp.Where(t => t.Kind == "expense").Sum(t => (decimal?)t.Magnitude) ?? 0m,
                })
                .ToListAsync(ct);
            var statByAccount = stats.ToDictionary(s => s.AccountId, s => s);

            var dtos = accounts
                .OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ThenBy(a => a.Id)
                .Select(a =>
                {
                    statByAccount.TryGetValue(a.Id, out var s);
                    return new AccountDto(a.Id, a.Name, a.Institution, a.Owner, a.Kind,
                        s?.Count ?? 0, s?.Spent ?? 0m);
                })
                .ToList();

            return Results.Ok(dtos);
        });

        g.MapPut("/accounts/{id:int}", async (
            int id, AccountPatchRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var account = await db.FinanceAccounts.FirstOrDefaultAsync(a => a.Id == id, ct);
            if (account is null || account.HouseholdId != household.Id) return NotFound();

            if (req.Owner is not null)
            {
                var owner = req.Owner.Trim().ToLowerInvariant();
                if (!Owners.Contains(owner))
                    return Results.BadRequest(new { message = "Owner must be his, hers, joint, or unassigned." });
                account.Owner = owner;
            }
            if (req.Kind is not null)
            {
                var kind = req.Kind.Trim().ToLowerInvariant();
                if (!Kinds.Contains(kind))
                    return Results.BadRequest(new { message = "Kind must be bank, credit, or other." });
                account.Kind = kind;
            }
            if (req.Name is not null)
            {
                var name = req.Name.Trim();
                if (name.Length == 0)
                    return Results.BadRequest(new { message = "An account name is required." });
                account.Name = Clamp(name, 200);
            }

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException) // renamed onto an existing (household, name, institution)
            {
                return Results.BadRequest(new { message = "Another account already uses that name." });
            }

            return Results.Ok(new AccountSummaryDto(
                account.Id, account.Name, account.Institution, account.Owner, account.Kind));
        });
    }

    // =====================================================================================
    // TRANSACTIONS — paged, filterable by month/account/category/owner/kind
    // =====================================================================================

    private static void MapTransactions(RouteGroupBuilder g)
    {
        g.MapGet("/transactions", async (
            string? month, int? accountId, string? category, string? owner, string? kind, int? page,
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var q = db.FinanceTransactions.AsNoTracking()
                .Where(t => t.HouseholdId == household.Id);

            if (TryParseMonth(month, out var from, out var toExclusive))
                q = q.Where(t => t.Date >= from && t.Date < toExclusive);
            if (accountId is int aId)
                q = q.Where(t => t.AccountId == aId);
            if (!string.IsNullOrWhiteSpace(category))
                q = q.Where(t => t.Category == category);
            if (!string.IsNullOrWhiteSpace(kind))
            {
                var k = kind.Trim().ToLowerInvariant();
                q = q.Where(t => t.Kind == k);
            }
            if (!string.IsNullOrWhiteSpace(owner))
            {
                var o = owner.Trim().ToLowerInvariant();
                // Owner lives on the account; filter via a join to the household's accounts.
                var ownerAccountIds = db.FinanceAccounts
                    .Where(a => a.HouseholdId == household.Id && a.Owner == o)
                    .Select(a => a.Id);
                q = q.Where(t => ownerAccountIds.Contains(t.AccountId));
            }

            var total = await q.CountAsync(ct);

            var pageNum = page is int p && p > 0 ? p : 1;
            var skip = (pageNum - 1) * DefaultPageSize;

            var rows = await q
                .OrderByDescending(t => t.Date).ThenByDescending(t => t.Id)
                .Skip(skip).Take(DefaultPageSize)
                .Select(t => new { t.Id, t.Date, t.Merchant, t.Category, t.Magnitude, t.RawAmount, t.Kind, t.AccountId })
                .ToListAsync(ct);

            // Resolve account name + owner for the page in one read.
            var acctIds = rows.Select(r => r.AccountId).Distinct().ToList();
            var accounts = await db.FinanceAccounts.AsNoTracking()
                .Where(a => a.HouseholdId == household.Id && acctIds.Contains(a.Id))
                .Select(a => new { a.Id, a.Name, a.Owner })
                .ToListAsync(ct);
            var acctById = accounts.ToDictionary(a => a.Id, a => a);

            var items = rows.Select(r =>
            {
                acctById.TryGetValue(r.AccountId, out var acct);
                return new TransactionDto(
                    r.Id, r.Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                    r.Merchant, r.Category, r.Magnitude, r.RawAmount, r.Kind,
                    r.AccountId, acct?.Name ?? "Unknown account", acct?.Owner ?? "unassigned");
            }).ToList();

            return Results.Ok(new TransactionsPageDto(pageNum, DefaultPageSize, total, items));
        });
    }

    // =====================================================================================
    // SUMMARY — totals + byCategory/byAccount/byOwner + a multi-month trend (expense-only spending)
    // =====================================================================================

    private static void MapSummary(RouteGroupBuilder g)
    {
        g.MapGet("/summary", async (
            string? month, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // The summary month: the requested YYYY-MM, else the most recent month with data, else now.
            DateOnly from, toExclusive;
            if (!TryParseMonth(month, out from, out toExclusive))
            {
                var maxDate = await db.FinanceTransactions.AsNoTracking()
                    .Where(t => t.HouseholdId == household.Id)
                    .OrderByDescending(t => t.Date)
                    .Select(t => (DateOnly?)t.Date)
                    .FirstOrDefaultAsync(ct);
                var anchor = maxDate ?? DateOnly.FromDateTime(DateTime.UtcNow);
                from = new DateOnly(anchor.Year, anchor.Month, 1);
                toExclusive = from.AddMonths(1);
            }
            var monthLabel = from.ToString("yyyy-MM", CultureInfo.InvariantCulture);

            // Accounts (for owner/name resolution).
            var accounts = await db.FinanceAccounts.AsNoTracking()
                .Where(a => a.HouseholdId == household.Id)
                .Select(a => new { a.Id, a.Name, a.Owner })
                .ToListAsync(ct);
            var acctById = accounts.ToDictionary(a => a.Id, a => a);

            // The month's transactions (we shape totals in memory — a month is small).
            var monthTxns = await db.FinanceTransactions.AsNoTracking()
                .Where(t => t.HouseholdId == household.Id && t.Date >= from && t.Date < toExclusive)
                .Select(t => new { t.AccountId, t.Magnitude, t.Kind, t.Category })
                .ToListAsync(ct);

            var expenses = monthTxns.Where(t => t.Kind == "expense").ToList();
            var totalSpent = expenses.Sum(t => t.Magnitude);
            var totalIncome = monthTxns.Where(t => t.Kind == "income").Sum(t => t.Magnitude);

            var byCategory = expenses
                .GroupBy(t => string.IsNullOrWhiteSpace(t.Category) ? "Uncategorized" : t.Category!)
                .Select(grp => new { Category = grp.Key, Amount = grp.Sum(x => x.Magnitude) })
                .OrderByDescending(x => x.Amount).ThenBy(x => x.Category, StringComparer.OrdinalIgnoreCase)
                .Select(x => new CategoryAmountDto(
                    x.Category, x.Amount, totalSpent > 0 ? Math.Round((double)(x.Amount / totalSpent) * 100.0, 1) : 0.0))
                .ToList();

            var byAccount = expenses
                .GroupBy(t => t.AccountId)
                .Select(grp =>
                {
                    acctById.TryGetValue(grp.Key, out var acct);
                    return new AccountAmountDto(grp.Key, acct?.Name ?? "Unknown account",
                        acct?.Owner ?? "unassigned", grp.Sum(x => x.Magnitude));
                })
                .OrderByDescending(x => x.Amount).ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            var byOwner = expenses
                .GroupBy(t => acctById.TryGetValue(t.AccountId, out var acct) ? acct.Owner : "unassigned")
                .Select(grp => new OwnerAmountDto(grp.Key, grp.Sum(x => x.Magnitude)))
                .OrderByDescending(x => x.Amount).ThenBy(x => x.Owner, StringComparer.OrdinalIgnoreCase)
                .ToList();

            // A rolling 12-month trend ending on the summary month (spent + income per month, expense-only spending).
            var trendStart = from.AddMonths(-11);
            var trendTxns = await db.FinanceTransactions.AsNoTracking()
                .Where(t => t.HouseholdId == household.Id && t.Date >= trendStart && t.Date < toExclusive)
                .Select(t => new { t.Date, t.Magnitude, t.Kind })
                .ToListAsync(ct);

            var trendByMonth = trendTxns
                .GroupBy(t => new DateOnly(t.Date.Year, t.Date.Month, 1))
                .ToDictionary(
                    grp => grp.Key,
                    grp => (Spent: grp.Where(x => x.Kind == "expense").Sum(x => x.Magnitude),
                            Income: grp.Where(x => x.Kind == "income").Sum(x => x.Magnitude)));

            var monthlyTrend = new List<TrendPointDto>(12);
            for (var i = 0; i < 12; i++)
            {
                var m = trendStart.AddMonths(i);
                trendByMonth.TryGetValue(m, out var pair);
                monthlyTrend.Add(new TrendPointDto(
                    m.ToString("yyyy-MM", CultureInfo.InvariantCulture), pair.Spent, pair.Income));
            }

            return Results.Ok(new SummaryDto(
                monthLabel, totalSpent, totalIncome, byCategory, byAccount, byOwner, monthlyTrend));
        });
    }

    // =====================================================================================
    // IMPORTS — recent import batches (importer by userId + name; never email)
    // =====================================================================================

    private static void MapImportsList(RouteGroupBuilder g)
    {
        g.MapGet("/imports", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var imports = await db.FinanceImports.AsNoTracking()
                .Where(i => i.HouseholdId == household.Id)
                .OrderByDescending(i => i.CreatedUtc).ThenByDescending(i => i.Id)
                .Take(100)
                .ToListAsync(ct);

            var names = await NamesAsync(db, imports.Select(i => i.ImportedByUserId), ct);

            var dtos = imports.Select(i => new ImportBatchDto(
                i.Id, i.FileName, i.RowCount, i.ImportedCount, i.SkippedCount,
                i.ImportedByUserId, Name(names, i.ImportedByUserId), i.CreatedUtc)).ToList();

            return Results.Ok(dtos);
        });
    }

    // =====================================================================================
    // AI — "Explain this month" (READ-ONLY narration of the server's OWN summary numbers)
    // =====================================================================================

    /// <summary>Max top categories fed to the model / named in the plain floor.</summary>
    private const int TopCategoriesForAi = 4;

    private static void MapAiSummary(RouteGroupBuilder g)
    {
        // GET /ai/summary?month=YYYY-MM — a warm, read-only "where the money went" narration of the SAME
        // server-computed numbers GET /summary returns. ALWAYS 200: when Gemini is unconfigured/errors (or
        // the month is empty) the GUARANTEED deterministic plain summary is returned with fellBackToPlain=true,
        // NEVER a 503/500. Writes NOTHING. CACHED per (household, month) for a few hours. Rate-limited. Still
        // gated by BOTH family.use AND family.finance (inherited from the group). No email (none in finance).
        g.MapGet("/ai/summary", async (
            string? month, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, IMemoryCache cache, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var facts = await ComputeMonthFactsAsync(db, household.Id, month, ct);

            // Empty month → a friendly empty narrative, WITHOUT calling the model.
            if (!facts.HasAny)
            {
                var empty = $"No spending recorded for {facts.MonthLabel}.";
                return Results.Ok(new FinanceAiSummaryDto(empty, Array.Empty<string>(), true));
            }

            var plain = PlainFinanceSummary(facts);

            // Plain summary is the floor. Prefer the warm AI narrative when configured (cached per month).
            if (!gemini.IsConfigured)
                return Results.Ok(new FinanceAiSummaryDto(plain, Array.Empty<string>(), true));

            var cacheKey = $"family:finance-summary:{household.Id}:{facts.MonthLabel}";
            if (cache.TryGetValue(cacheKey, out FinanceAiSummaryDto? cached) && cached is not null)
                return Results.Ok(cached);

            FinanceSummaryResult? ai;
            try
            {
                ai = await gemini.FinanceSummaryAsync(FinanceFacts(facts), ct);
            }
            catch
            {
                ai = null;
            }

            if (ai is null || string.IsNullOrWhiteSpace(ai.Narrative))
                return Results.Ok(new FinanceAiSummaryDto(plain, Array.Empty<string>(), true)); // floor

            var dto = new FinanceAiSummaryDto(ai.Narrative, ai.Insights, false);
            cache.Set(cacheKey, dto, TimeSpan.FromHours(6));
            return Results.Ok(dto);
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);
    }

    /// <summary>The server-computed facts for ONE month, mirroring GET /summary's math exactly (expense-only
    /// spending; transfers excluded). Carries the prior-month spent total so the narrative/floor can state a
    /// vs-last-month delta. Nothing here comes from the client beyond the requested month string.</summary>
    private sealed record MonthFacts(
        string MonthLabel, decimal TotalSpent, decimal TotalIncome,
        IReadOnlyList<CategoryAmountDto> TopCategories,
        IReadOnlyList<OwnerAmountDto> ByOwner,
        decimal? PriorMonthSpent, bool HasAny);

    private static async Task<MonthFacts> ComputeMonthFactsAsync(
        UsageDbContext db, int householdId, string? month, CancellationToken ct)
    {
        // Resolve the month window the SAME way GET /summary does: the requested YYYY-MM, else the most
        // recent month with data, else now.
        DateOnly from, toExclusive;
        if (!TryParseMonth(month, out from, out toExclusive))
        {
            var maxDate = await db.FinanceTransactions.AsNoTracking()
                .Where(t => t.HouseholdId == householdId)
                .OrderByDescending(t => t.Date)
                .Select(t => (DateOnly?)t.Date)
                .FirstOrDefaultAsync(ct);
            var anchor = maxDate ?? DateOnly.FromDateTime(DateTime.UtcNow);
            from = new DateOnly(anchor.Year, anchor.Month, 1);
            toExclusive = from.AddMonths(1);
        }
        var monthLabel = from.ToString("yyyy-MM", CultureInfo.InvariantCulture);

        var accounts = await db.FinanceAccounts.AsNoTracking()
            .Where(a => a.HouseholdId == householdId)
            .Select(a => new { a.Id, a.Owner })
            .ToListAsync(ct);
        var ownerByAccount = accounts.ToDictionary(a => a.Id, a => a.Owner);

        var monthTxns = await db.FinanceTransactions.AsNoTracking()
            .Where(t => t.HouseholdId == householdId && t.Date >= from && t.Date < toExclusive)
            .Select(t => new { t.AccountId, t.Magnitude, t.Kind, t.Category })
            .ToListAsync(ct);

        var expenses = monthTxns.Where(t => t.Kind == "expense").ToList();
        var totalSpent = expenses.Sum(t => t.Magnitude);
        var totalIncome = monthTxns.Where(t => t.Kind == "income").Sum(t => t.Magnitude);

        var topCategories = expenses
            .GroupBy(t => string.IsNullOrWhiteSpace(t.Category) ? "Uncategorized" : t.Category!)
            .Select(grp => new { Category = grp.Key, Amount = grp.Sum(x => x.Magnitude) })
            .OrderByDescending(x => x.Amount).ThenBy(x => x.Category, StringComparer.OrdinalIgnoreCase)
            .Take(TopCategoriesForAi)
            .Select(x => new CategoryAmountDto(
                x.Category, x.Amount, totalSpent > 0 ? Math.Round((double)(x.Amount / totalSpent) * 100.0, 1) : 0.0))
            .ToList();

        var byOwner = expenses
            .GroupBy(t => ownerByAccount.TryGetValue(t.AccountId, out var o) ? o : "unassigned")
            .Select(grp => new OwnerAmountDto(grp.Key, grp.Sum(x => x.Magnitude)))
            .OrderByDescending(x => x.Amount).ThenBy(x => x.Owner, StringComparer.OrdinalIgnoreCase)
            .ToList();

        // Prior-month spending (expense-only) for the vs-last-month delta — same window math, one month back.
        var priorFrom = from.AddMonths(-1);
        var priorSpentRaw = await db.FinanceTransactions.AsNoTracking()
            .Where(t => t.HouseholdId == householdId && t.Kind == "expense"
                && t.Date >= priorFrom && t.Date < from)
            .Select(t => (decimal?)t.Magnitude)
            .SumAsync(ct);
        var priorSpent = priorSpentRaw is decimal ps && ps > 0 ? ps : (decimal?)null;

        var hasAny = monthTxns.Count > 0;

        return new MonthFacts(monthLabel, totalSpent, totalIncome, topCategories, byOwner, priorSpent, hasAny);
    }

    /// <summary>Pre-format the server-computed <paramref name="f"/> numbers as a tight DATA block the model
    /// NARRATES (it never recomputes). Owners are the his/hers/joint/unassigned labels; amounts are the
    /// authoritative totals from the same math as GET /summary.</summary>
    private static string FinanceFacts(MonthFacts f)
    {
        var cats = f.TopCategories.Count > 0
            ? string.Join("; ", f.TopCategories.Select(c =>
                $"{c.Category} {Money(c.Amount)} ({c.Pct.ToString("0.#", CultureInfo.InvariantCulture)}%)"))
            : "(none)";
        var owners = f.ByOwner.Count > 0
            ? string.Join("; ", f.ByOwner.Select(o => $"{o.Owner} {Money(o.Amount)}"))
            : "(none)";
        var delta = f.PriorMonthSpent is decimal prior
            ? $"last_month_spent: {Money(prior)} ({PctChange(prior, f.TotalSpent)})"
            : "last_month_spent: (no prior month data)";

        return
            $"month: {f.MonthLabel}\n" +
            $"total_spent: {Money(f.TotalSpent)}\n" +
            $"total_income: {Money(f.TotalIncome)}\n" +
            $"top_categories: {cats}\n" +
            $"spending_by_owner: {owners}\n" +
            delta;
    }

    /// <summary>The GUARANTEED deterministic plain floor: a one-liner stating the month total, the top
    /// category, and the vs-last-month direction. Used when Gemini is unconfigured/errors — it NEVER 503s.</summary>
    private static string PlainFinanceSummary(MonthFacts f)
    {
        var s = $"You spent {Money(f.TotalSpent)} in {f.MonthLabel}";
        if (f.TopCategories.Count > 0)
            s += $"; top category {f.TopCategories[0].Category} {Money(f.TopCategories[0].Amount)}";
        if (f.PriorMonthSpent is decimal prior)
        {
            var dir = f.TotalSpent > prior ? "up" : f.TotalSpent < prior ? "down" : "about the same";
            s += f.TotalSpent == prior
                ? $"; {dir} vs last month"
                : $"; {dir} {PctChange(prior, f.TotalSpent)} vs last month";
        }
        return s + ".";
    }

    private static string Money(decimal amount) =>
        "$" + amount.ToString("0.##", CultureInfo.InvariantCulture);

    /// <summary>A signed percent-change label from <paramref name="prior"/> to <paramref name="current"/>
    /// (prior is guaranteed &gt; 0 by the caller). E.g. "+12%" or "-8%".</summary>
    private static string PctChange(decimal prior, decimal current)
    {
        var pct = (double)((current - prior) / prior) * 100.0;
        var rounded = Math.Round(pct, 0, MidpointRounding.AwayFromZero);
        var sign = rounded > 0 ? "+" : "";
        return $"{sign}{rounded.ToString("0", CultureInfo.InvariantCulture)}%";
    }

    // =====================================================================================
    // AI — "Money coach" (DETERMINISTIC recurring-charge detector + read-only narration)
    // =====================================================================================

    /// <summary>How many months of expense history the recurring detector scans (the spec's "last ~4 months").</summary>
    private const int MoneyCoachLookbackMonths = 4;

    private static void MapMoneyCoach(RouteGroupBuilder g)
    {
        // GET /ai/money-coach — FIRST a DETERMINISTIC, authoritative recurring-charge detector (server-side),
        // THEN an OPTIONAL warm narration + tips from Gemini. ALWAYS 200: the recurring list + monthly total
        // are the FLOOR (present whether Gemini is on or off); when Gemini is unconfigured/errors, narrative is
        // null + tips empty + fellBackToPlain=true, NEVER a 503/500. Writes NOTHING (advice only — the coach
        // never cancels/edits anything). CACHED per (household, month). Rate-limited. Still gated by BOTH
        // family.use AND family.finance (inherited). No email (none in finance).
        g.MapGet("/ai/money-coach", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, IMemoryCache cache, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            // The anchor month: the most recent month with data, else now. The detector scans the lookback
            // window ending at that month. (No client month param — the coach is always "recent activity".)
            var maxDate = await db.FinanceTransactions.AsNoTracking()
                .Where(t => t.HouseholdId == household.Id)
                .OrderByDescending(t => t.Date)
                .Select(t => (DateOnly?)t.Date)
                .FirstOrDefaultAsync(ct);
            var anchor = maxDate ?? DateOnly.FromDateTime(DateTime.UtcNow);
            var monthLabel = new DateOnly(anchor.Year, anchor.Month, 1)
                .ToString("yyyy-MM", CultureInfo.InvariantCulture);
            var windowStart = new DateOnly(anchor.Year, anchor.Month, 1).AddMonths(-(MoneyCoachLookbackMonths - 1));
            var windowEnd = new DateOnly(anchor.Year, anchor.Month, 1).AddMonths(1); // exclusive

            // Load the window's EXPENSE rows (transfers/income never recur as "bills"). Merchant + amount +
            // date are all we need; nothing here comes from the client.
            var expenses = await db.FinanceTransactions.AsNoTracking()
                .Where(t => t.HouseholdId == household.Id && t.Kind == "expense"
                    && t.Date >= windowStart && t.Date < windowEnd)
                .Select(t => new ExpenseRow(t.Merchant, t.Magnitude, t.Date))
                .ToListAsync(ct);

            // The DETERMINISTIC, authoritative floor.
            var recurring = DetectRecurring(expenses);
            var monthlyTotal = recurring.Sum(r => r.TypicalAmount);
            var recurringDtos = recurring
                .Select(r => new RecurringChargeDto(
                    r.Merchant, r.TypicalAmount, "monthly", r.MonthsSeen,
                    r.LastDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)))
                .ToList();

            // No recurring charges found → return the empty floor without calling the model.
            if (recurringDtos.Count == 0)
                return Results.Ok(new MoneyCoachDto(recurringDtos, 0m, null, Array.Empty<string>(), true));

            // Recurring list is the floor. Prefer the warm AI narration when configured (cached per month).
            if (!gemini.IsConfigured)
                return Results.Ok(new MoneyCoachDto(recurringDtos, monthlyTotal, null, Array.Empty<string>(), true));

            var cacheKey = $"family:money-coach:{household.Id}:{monthLabel}";
            if (cache.TryGetValue(cacheKey, out MoneyCoachDto? cached) && cached is not null)
                return Results.Ok(cached);

            MoneyCoachResult? ai;
            try
            {
                ai = await gemini.MoneyCoachAsync(MoneyCoachFacts(recurringDtos, monthlyTotal), ct);
            }
            catch
            {
                ai = null;
            }

            if (ai is null || string.IsNullOrWhiteSpace(ai.Narrative))
                return Results.Ok(new MoneyCoachDto(recurringDtos, monthlyTotal, null, Array.Empty<string>(), true)); // floor

            var dto = new MoneyCoachDto(recurringDtos, monthlyTotal, ai.Narrative, ai.Tips, false);
            cache.Set(cacheKey, dto, TimeSpan.FromHours(6));
            return Results.Ok(dto);
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);
    }

    /// <summary>One expense row fed to the recurring detector (merchant + positive magnitude + date).</summary>
    public sealed record ExpenseRow(string Merchant, decimal Magnitude, DateOnly Date);

    /// <summary>One detected recurring charge (pre-DTO): the display merchant, the median amount, the count of
    /// distinct months it appeared in, and the last date seen.</summary>
    public sealed record RecurringCharge(string Merchant, decimal TypicalAmount, int MonthsSeen, DateOnly LastDate);

    /// <summary>How close two amounts must be to count as "the same charge" (relative tolerance) — a
    /// subscription that drifts a little (tax/price change) still groups.</summary>
    private const decimal RecurringAmountTolerance = 0.15m; // 15%

    /// <summary>
    /// The DETERMINISTIC, authoritative recurring-charge detector. Groups expenses by NORMALIZED merchant, then
    /// keeps a merchant when its charges recur in &gt;= 2 DISTINCT calendar months with a stable-ish amount
    /// (the per-month median is within <see cref="RecurringAmountTolerance"/> of the overall median, i.e.
    /// monthly cadence at a consistent price). Returns one row per recurring merchant — typical amount = the
    /// median occurrence, monthsSeen = distinct months, lastDate = the latest occurrence — ordered by amount
    /// desc. Pure + DB-free so it is unit-testable: 3 monthly Netflix charges -&gt; 1 row; a one-off -&gt;
    /// excluded.
    /// </summary>
    public static IReadOnlyList<RecurringCharge> DetectRecurring(IReadOnlyList<ExpenseRow> expenses)
    {
        var result = new List<RecurringCharge>();

        var groups = expenses
            .Where(e => e.Magnitude > 0 && !string.IsNullOrWhiteSpace(e.Merchant))
            .GroupBy(e => NormalizeMerchant(e.Merchant));

        foreach (var grp in groups)
        {
            var rows = grp.ToList();

            // Distinct calendar months this merchant was charged in — the cadence signal.
            var monthsSeen = rows.Select(r => new DateOnly(r.Date.Year, r.Date.Month, 1)).Distinct().Count();
            if (monthsSeen < 2) continue; // not recurring (a one-off, or twice in the same month only)

            var overallMedian = Median(rows.Select(r => r.Magnitude).ToList());
            if (overallMedian <= 0) continue;

            // Stable-ish amount: most occurrences sit within tolerance of the median (filters out a merchant
            // you happen to shop at irregularly for wildly different amounts — that's not a subscription).
            var withinTolerance = rows.Count(r =>
                Math.Abs(r.Magnitude - overallMedian) <= overallMedian * RecurringAmountTolerance);
            if (withinTolerance < monthsSeen) continue; // need at least one stable charge per recurring month

            // Display name: the most common raw merchant string in the group (nicest casing/spelling).
            var display = rows
                .GroupBy(r => r.Merchant.Trim())
                .OrderByDescending(d => d.Count()).ThenBy(d => d.Key, StringComparer.OrdinalIgnoreCase)
                .First().Key;

            result.Add(new RecurringCharge(
                Merchant: display,
                TypicalAmount: decimal.Round(overallMedian, 2),
                MonthsSeen: monthsSeen,
                LastDate: rows.Max(r => r.Date)));
        }

        return result
            .OrderByDescending(r => r.TypicalAmount)
            .ThenBy(r => r.Merchant, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>Normalize a merchant for grouping: lower-case, drop a trailing transaction/store id, collapse
    /// whitespace, and strip surrounding punctuation so "Netflix.com", "NETFLIX #123", and "Netflix" all
    /// group. Conservative — it never merges distinct brands.</summary>
    private static string NormalizeMerchant(string merchant)
    {
        var s = merchant.Trim().ToLowerInvariant();
        // Cut at the first store/transaction marker ("#", "*", or a long digit run) — POS noise after the name.
        s = System.Text.RegularExpressions.Regex.Replace(s, @"\s*[#*].*$", "");
        s = System.Text.RegularExpressions.Regex.Replace(s, @"\s+\d{3,}.*$", "");
        // Drop a common ".com"/".net" suffix and any non-alphanumeric trailing/leading punctuation runs.
        s = System.Text.RegularExpressions.Regex.Replace(s, @"\.(com|net|org|io)\b", "");
        s = System.Text.RegularExpressions.Regex.Replace(s, @"[^a-z0-9]+", " ").Trim();
        return s.Length == 0 ? merchant.Trim().ToLowerInvariant() : s;
    }

    /// <summary>The median of a non-empty decimal list (average of the two middles for an even count).</summary>
    private static decimal Median(List<decimal> values)
    {
        if (values.Count == 0) return 0m;
        var sorted = values.OrderBy(v => v).ToList();
        var mid = sorted.Count / 2;
        return sorted.Count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2m;
    }

    /// <summary>Pre-format the DETERMINISTIC recurring charges as a tight DATA block the model NARRATES (it
    /// never recomputes). Amounts are the authoritative server medians.</summary>
    private static string MoneyCoachFacts(IReadOnlyList<RecurringChargeDto> recurring, decimal monthlyTotal)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append("monthly_recurring_total: ").Append(Money(monthlyTotal)).Append('\n');
        sb.Append("recurring_charges:\n");
        foreach (var r in recurring)
            sb.Append("- ").Append(r.Merchant).Append(": ").Append(Money(r.TypicalAmount))
              .Append("/mo, seen ").Append(r.MonthsSeen).Append(" months, last ").Append(r.LastDate).Append('\n');
        return sb.ToString();
    }

    // =====================================================================================
    // HELPERS
    // =====================================================================================

    private static string KindString(RocketMoneyCsv.ParsedKind kind) => kind switch
    {
        RocketMoneyCsv.ParsedKind.Income => "income",
        RocketMoneyCsv.ParsedKind.Transfer => "transfer",
        _ => "expense",
    };

    /// <summary>Parse a "YYYY-MM" month into a [from, toExclusive) date window; false if blank/invalid.</summary>
    private static bool TryParseMonth(string? month, out DateOnly from, out DateOnly toExclusive)
    {
        from = default;
        toExclusive = default;
        if (string.IsNullOrWhiteSpace(month)) return false;
        if (!DateTime.TryParseExact(month.Trim(), "yyyy-MM", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var dt))
            return false;
        from = new DateOnly(dt.Year, dt.Month, 1);
        toExclusive = from.AddMonths(1);
        return true;
    }

    private static async Task<Dictionary<int, string>> NamesAsync(
        UsageDbContext db, IEnumerable<int> userIds, CancellationToken ct)
    {
        var ids = userIds.Distinct().ToList();
        if (ids.Count == 0) return new Dictionary<int, string>();
        return await db.Users.AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .ToDictionaryAsync(
                u => u.Id,
                u => string.IsNullOrEmpty(u.Name) ? "Unknown user" : u.Name, ct);
    }

    private static string Name(Dictionary<int, string> names, int userId) =>
        names.TryGetValue(userId, out var n) ? n : "Unknown user";

    private static string Clamp(string? s, int max)
    {
        s = (s ?? "").Trim();
        return s.Length > max ? s[..max] : s;
    }

    private static IResult NotFound() =>
        Results.NotFound(new { message = "That account doesn't exist." });
}
