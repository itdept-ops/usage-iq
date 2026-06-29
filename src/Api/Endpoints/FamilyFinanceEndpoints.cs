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

    // ---- staging (parse → review → commit) DTOs ----

    /// <summary>The caller-supplied column map for a GENERIC bank CSV (mirrors
    /// <see cref="BankImportParsers.ColumnMap"/>): each value is a header NAME in the file (plus the optional
    /// account-name/institution literals + the negate/debit-credit toggles). Ignored for rocketmoney/ofx.</summary>
    public sealed record ColumnMapDto(
        string? Date, string? Amount, string? Debit, string? Credit, bool Negate,
        string? Description, string? Category, string? Account, string? AccountName, string? Institution);

    /// <summary>POST /import/parse body: the file + an optional explicit format ("auto" detects) + the column
    /// map for a generic CSV. Parse + categorize + dedup into a STAGED batch — the live ledger is untouched.</summary>
    public sealed record ParseRequest(
        string? FileName, string? Content, string? Format, ColumnMapDto? ColumnMap);

    /// <summary>One staged (parsed-but-not-committed) row in the review panel.</summary>
    public sealed record StagedRowDto(
        long Id, int RowIndex, string Date, string Merchant, string? Description,
        decimal RawAmount, decimal Magnitude, string Kind,
        string AccountKey, string AccountName, string? Institution,
        string? Category, string? SuggestedCategory, string CategorySource,
        bool IsDuplicate, bool Excluded);

    /// <summary>One account touched by a staged batch (for the review's account grouping).</summary>
    public sealed record StagedAccountDto(string AccountKey, string Name, string? Institution, string Kind, int RowCount);

    /// <summary>The result of POST /import/parse: the staged batch id + counts + the touched accounts + a capped
    /// row preview. duplicateCount = rows flagged IsDuplicate (committed-ledger OR within-batch, FITID-preferred);
    /// skippedCount = unparseable rows the parser dropped.</summary>
    public sealed record StagedImportDto(
        long ImportId, string Format, int RowCount, int ParsedCount, int SkippedCount, int DuplicateCount,
        IReadOnlyList<string> DetectedColumns, IReadOnlyList<StagedAccountDto> Accounts,
        IReadOnlyList<StagedRowDto> Rows);

    /// <summary>A page of staged review rows (GET /import/{id}/staged).</summary>
    public sealed record StagedPageDto(int Page, int PageSize, int Total, IReadOnlyList<StagedRowDto> Items);

    /// <summary>PATCH /import/{id}/rows/{stagedId} body: edit one staged row. <see cref="ApplyToFuture"/> upserts
    /// a household FinanceCategoryRule (equals on the merchant) so the new category sticks for future imports.</summary>
    public sealed record StagedRowPatch(string? Category, bool? Excluded, string? Kind, bool? ApplyToFuture);

    /// <summary>POST /import/{id}/categorize-ai result: how many rows the AI labeled. <see cref="FellBackToPlain"/>
    /// is true when AI is off/unconfigured/errored (rows unchanged) — the commit is never blocked.</summary>
    public sealed record CategorizeAiResultDto(int Classified, int Eligible, bool FellBackToPlain);

    /// <summary>POST /import/{id}/commit body: optional staged-row ids to exclude on top of any already-excluded.</summary>
    public sealed record CommitRequest(IReadOnlyList<long>? ExcludeIds);

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

    // ---- BUDGETS (deterministic spend-vs-budget by pace) ----

    /// <summary>One budget row for GET /budgets: the budget intent (id/category/limit) PLUS the deterministic
    /// server math for the requested month — EXPENSE-only <see cref="Spent"/> (transfers excluded),
    /// <see cref="Remaining"/> (limit − spent), <see cref="Pct"/> spent of limit, the straight-line
    /// <see cref="Projected"/> month-end pace (<c>spent / dayOfMonth * daysInMonth</c>), and a
    /// <see cref="Status"/> "under"|"near"|"over" computed BY PACE. <see cref="Category"/> is null for the
    /// household's OVERALL whole-month budget.</summary>
    public sealed record BudgetDto(
        int Id, string? Category, decimal LimitAmount, decimal Spent, decimal Remaining,
        double Pct, decimal Projected, string Status);

    /// <summary>The unbudgeted-spend rollup: EXPENSE spend this month in categories the household has NO budget
    /// for (the overall budget, if any, does not absorb a per-category gap). Lets the UI show "you also spent
    /// $X outside any budget".</summary>
    public sealed record UnbudgetedDto(decimal Spent, int CategoryCount);

    /// <summary>GET /budgets result: the month, the per-budget rows (overall budget first when present), the
    /// unbudgeted rollup, and the month's total EXPENSE spend (the same figure GET /summary computes).</summary>
    public sealed record BudgetsResponseDto(
        string Month, IReadOnlyList<BudgetDto> Budgets, UnbudgetedDto Unbudgeted, decimal TotalSpent);

    /// <summary>POST/PUT /budgets body: a category (null/blank = the OVERALL budget) + the monthly limit.</summary>
    public sealed record BudgetUpsertRequest(string? Category, decimal? LimitAmount);

    // ---- NET WORTH (signed snapshots; latest per account) ----

    /// <summary>One account's latest balance for GET /net-worth: the account (id/name/owner/kind) + its
    /// most-recent SIGNED <see cref="LatestBalance"/> (bank positive asset, credit/loan negative liability) +
    /// the <see cref="AsOfDate"/> it was entered. <see cref="HasBalance"/> is false when the account has no
    /// snapshot yet (LatestBalance/AsOfDate are 0/null) so the UI can prompt for a first entry.</summary>
    public sealed record AccountBalanceDto(
        int AccountId, string Name, string Owner, string Kind, decimal LatestBalance, string? AsOfDate, bool HasBalance);

    /// <summary>One net-worth-by-month trend point: the month label + the net worth as of that month's end
    /// (sum of each account's most-recent snapshot AT OR BEFORE that month).</summary>
    public sealed record NetWorthTrendPointDto(string Month, decimal NetWorth);

    /// <summary>GET /net-worth result: assets total (sum of positive latest balances), liabilities total (sum
    /// of negative latest balances, returned as a NEGATIVE number), the net worth (assets + liabilities), the
    /// per-account rows, and a net-worth-by-month trend from the snapshot history. MANUAL entry — there is no
    /// bank feed.</summary>
    public sealed record NetWorthDto(
        decimal Assets, decimal Liabilities, decimal NetWorth,
        IReadOnlyList<AccountBalanceDto> Accounts, IReadOnlyList<NetWorthTrendPointDto> Trend);

    /// <summary>POST /accounts/{id}/balance body: today's (or a chosen day's) SIGNED balance for one account.</summary>
    public sealed record BalanceEntryRequest(string? AsOfDate, decimal? Balance, string? Note);

    // ---- SAVINGS GOALS ----

    /// <summary>One savings goal for GET /savings: the goal + its progress (<see cref="Pct"/> saved of target)
    /// and a <see cref="ProjectedFinish"/> date estimated from the contribution pace (null when there's no pace
    /// or it's already met). <see cref="Owner"/> reuses the his/hers/joint/unassigned vocab + colors.</summary>
    public sealed record SavingsGoalDto(
        int Id, string Name, decimal TargetAmount, decimal SavedAmount, double Pct,
        string? TargetDate, string Owner, string? Color, string? Icon, bool Archived, string? ProjectedFinish);

    /// <summary>GET /savings result: the active goals (archived hidden unless asked) + their combined saved/target.</summary>
    public sealed record SavingsResponseDto(
        IReadOnlyList<SavingsGoalDto> Goals, decimal TotalSaved, decimal TotalTarget);

    /// <summary>POST/PUT /savings body: the goal fields (a PUT leaves SavedAmount alone — use /contribute).</summary>
    public sealed record SavingsUpsertRequest(
        string? Name, decimal? TargetAmount, string? TargetDate, string? Owner,
        string? Color, string? Icon, bool? Archived);

    /// <summary>POST /savings/{id}/contribute body: a signed amount to add to SavedAmount (negative withdraws;
    /// SavedAmount floors at 0).</summary>
    public sealed record ContributeRequest(decimal? Amount);

    // ---- AI BUDGET CHECK-IN (floored) ----

    /// <summary>One budget's deterministic status line for the AI budget check floor: category (null = overall),
    /// the limit, paced projection, and the "under"|"near"|"over" verdict.</summary>
    public sealed record BudgetCheckItemDto(string? Category, decimal LimitAmount, decimal Projected, string Status);

    /// <summary>
    /// GET /ai/budget-check result. The deterministic FLOOR is the per-budget over/near/under list
    /// (<see cref="Budgets"/>), the counts (<see cref="OverCount"/>/<see cref="NearCount"/>), and the
    /// net-worth <see cref="NetWorthDirection"/> ("up"|"down"|"flat"|"unknown") — all present whether Gemini is
    /// on or off. When the caller holds finance.ai AND Gemini is configured it ALSO narrates those facts into a
    /// warm <see cref="Narrative"/> + up to 5 <see cref="Tips"/>; otherwise those are empty/null and
    /// <see cref="FellBackToPlain"/> is true. ALWAYS 200 (the floor stands), never a 503/500, and writes
    /// NOTHING.</summary>
    public sealed record BudgetCheckDto(
        string Month, IReadOnlyList<BudgetCheckItemDto> Budgets,
        int OverCount, int NearCount, string NetWorthDirection,
        string? Narrative, IReadOnlyList<string> Tips, bool FellBackToPlain);

    private static readonly string[] Owners = { "his", "hers", "joint", "unassigned" };
    private static readonly string[] Kinds = { "bank", "credit", "other" };

    /// <summary>The "near budget" threshold by PACE: a budget is "near" once its paced projection reaches this
    /// fraction of the limit (and "over" once it exceeds the limit).</summary>
    private const double NearBudgetThreshold = 0.85;

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
        MapBudgets(g);
        MapNetWorth(g);
        MapSavings(g);
        MapBudgetCheck(g);
    }

    // =====================================================================================
    // IMPORT — parse a Rocket Money CSV, find-or-create accounts, insert deduped transactions
    // =====================================================================================

    private static void MapImport(RouteGroupBuilder g)
    {
        // -----------------------------------------------------------------------------
        // POST /import — LEGACY one-shot import. Now routed through the SAME staging flow
        // (parse → stage → commit) for one consistent, reversible path. The Rocket Money
        // format is detected; the staged batch is committed atomically in the same request.
        // -----------------------------------------------------------------------------
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

            // Parse + categorize + dedup into a staged batch (live ledger untouched), then commit it atomically.
            var (batch, _) = await StageAsync(db, household.Id, caller.Id, fileName, "rocketmoney", content, null, ct);
            return await CommitStagedAsync(db, household.Id, batch, excludeIds: null, ct);
        });

        // -----------------------------------------------------------------------------
        // POST /import/parse — parse + rule-categorize + dedup into a STAGED batch. Does NOT
        // touch the live ledger. Returns the staged preview the review UI renders.
        // -----------------------------------------------------------------------------
        g.MapPost("/import/parse", async (
            ParseRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var content = req.Content ?? "";
            if (string.IsNullOrWhiteSpace(content))
                return Results.BadRequest(new { message = "Paste or upload a file to import." });
            if (System.Text.Encoding.UTF8.GetByteCount(content) > MaxContentBytes)
                return Results.BadRequest(new { message = "That file is too large to import." });

            var fileName = Clamp(string.IsNullOrWhiteSpace(req.FileName) ? "import" : req.FileName!, 260);
            var format = DetectFormat(req.Format, fileName, content);

            var map = req.ColumnMap is null ? null : new BankImportParsers.ColumnMap(
                req.ColumnMap.Date, req.ColumnMap.Amount, req.ColumnMap.Debit, req.ColumnMap.Credit,
                req.ColumnMap.Negate, req.ColumnMap.Description, req.ColumnMap.Category,
                req.ColumnMap.Account, req.ColumnMap.AccountName, req.ColumnMap.Institution);

            if (format == "csv" && map is null)
                return Results.BadRequest(new { message = "Map the columns (at least date + amount) to import this CSV." });

            var (batch, parse) = await StageAsync(db, household.Id, caller.Id, fileName, format, content, map, ct);

            // Build the preview DTO from the just-written staged rows.
            var staged = await db.FinanceStagedTransactions.AsNoTracking()
                .Where(s => s.HouseholdId == household.Id && s.ImportId == batch.Id)
                .OrderBy(s => s.RowIndex).ThenBy(s => s.Id)
                .ToListAsync(ct);

            var accounts = staged
                .GroupBy(s => s.AccountKey)
                .Select(grp =>
                {
                    var first = grp.First();
                    return new StagedAccountDto(grp.Key, first.AccountName, first.Institution,
                        RocketMoneyCsv.AccountKind(first.AccountTypeRaw), grp.Count());
                })
                .OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ToList();

            var dupCount = staged.Count(s => s.IsDuplicate);
            var preview = staged.Take(StagedPreviewCap).Select(ToStagedRowDto).ToList();

            return Results.Ok(new StagedImportDto(
                batch.Id, format, parse.RowCount, staged.Count, parse.SkippedCount, dupCount,
                parse.DetectedColumns, accounts, preview));
        });

        // -----------------------------------------------------------------------------
        // GET /import/{importId}/staged?page= — paged review rows for a staged batch.
        // -----------------------------------------------------------------------------
        g.MapGet("/import/{importId:long}/staged", async (
            long importId, int? page, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var batch = await db.FinanceImports.AsNoTracking()
                .FirstOrDefaultAsync(i => i.Id == importId, ct);
            if (batch is null || batch.HouseholdId != household.Id) return ImportNotFound();

            var q = db.FinanceStagedTransactions.AsNoTracking()
                .Where(s => s.HouseholdId == household.Id && s.ImportId == importId);
            var total = await q.CountAsync(ct);

            var pageNum = page is int p && p > 0 ? p : 1;
            var items = await q
                .OrderBy(s => s.RowIndex).ThenBy(s => s.Id)
                .Skip((pageNum - 1) * MaxPageSize).Take(MaxPageSize)
                .ToListAsync(ct);

            return Results.Ok(new StagedPageDto(pageNum, MaxPageSize, total,
                items.Select(ToStagedRowDto).ToList()));
        });

        // -----------------------------------------------------------------------------
        // POST /import/{importId}/categorize-ai — OPTIONAL Gemini classify of still-Uncategorized,
        // non-excluded staged rows, CONSTRAINED to a fixed category enum. Floors to rows-unchanged
        // when AI is off/unconfigured/errors; NEVER 503, NEVER blocks the commit. Extra finance.ai gate.
        // -----------------------------------------------------------------------------
        g.MapPost("/import/{importId:long}/categorize-ai", async (
            long importId, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var batch = await db.FinanceImports.FirstOrDefaultAsync(i => i.Id == importId, ct);
            if (batch is null || batch.HouseholdId != household.Id) return ImportNotFound();
            if (batch.Status != "staged")
                return Results.BadRequest(new { message = "This batch is no longer staged." });

            // Eligible = still Uncategorized AND not excluded.
            var eligible = await db.FinanceStagedTransactions
                .Where(s => s.HouseholdId == household.Id && s.ImportId == importId
                    && !s.Excluded && (s.Category == null || s.Category == ""))
                .OrderBy(s => s.RowIndex)
                .ToListAsync(ct);

            // FLOOR: no eligible rows, or no finance.ai, or Gemini unconfigured → rows unchanged.
            if (eligible.Count == 0
                || !caller.Permissions.Contains(Permissions.FinanceAi) || !gemini.IsConfigured)
                return Results.Ok(new CategorizeAiResultDto(0, eligible.Count, true));

            var allowed = await AllowedCategoriesAsync(db, household.Id, ct);

            IReadOnlyDictionary<int, string>? labels;
            try
            {
                labels = await gemini.ClassifyTransactionsAsync(
                    eligible.Select(s => (s.RowIndex, s.Merchant, (string?)s.Description, s.RawAmount)).ToList(),
                    allowed, ct);
            }
            catch
            {
                labels = null;
            }

            if (labels is null || labels.Count == 0)
                return Results.Ok(new CategorizeAiResultDto(0, eligible.Count, true)); // floor: rows unchanged

            // The fixed enum, validated again here so an off-list category can never be written.
            var allowedSet = new HashSet<string>(allowed, StringComparer.OrdinalIgnoreCase);
            var byIndex = eligible.ToDictionary(s => s.RowIndex);
            var classified = 0;
            foreach (var (idx, cat) in labels)
            {
                if (!byIndex.TryGetValue(idx, out var row)) continue;
                if (string.IsNullOrWhiteSpace(cat) || !allowedSet.Contains(cat)) continue; // reject off-list
                row.SuggestedCategory = Clamp(cat, 120);
                row.Category = row.SuggestedCategory;
                row.CategorySource = "ai";
                classified++;
            }

            await db.SaveChangesAsync(ct);
            return Results.Ok(new CategorizeAiResultDto(classified, eligible.Count, false));
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);

        // -----------------------------------------------------------------------------
        // PATCH /import/{importId}/rows/{stagedId} — edit one staged row. Optionally upsert a
        // household FinanceCategoryRule ("apply to future") so the new category sticks.
        // -----------------------------------------------------------------------------
        g.MapPatch("/import/{importId:long}/rows/{stagedId:long}", async (
            long importId, long stagedId, StagedRowPatch req,
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var batch = await db.FinanceImports.AsNoTracking().FirstOrDefaultAsync(i => i.Id == importId, ct);
            if (batch is null || batch.HouseholdId != household.Id) return ImportNotFound();
            if (batch.Status != "staged")
                return Results.BadRequest(new { message = "This batch is no longer staged." });

            var row = await db.FinanceStagedTransactions
                .FirstOrDefaultAsync(s => s.Id == stagedId && s.ImportId == importId, ct);
            if (row is null || row.HouseholdId != household.Id) return ImportNotFound();

            if (req.Category is not null)
            {
                var cat = req.Category.Trim();
                row.Category = cat.Length == 0 ? null : Clamp(cat, 120);
                row.CategorySource = row.Category is null ? "none" : "file"; // a user edit is authoritative
            }
            if (req.Excluded is bool ex) row.Excluded = ex;
            if (req.Kind is not null)
            {
                var k = req.Kind.Trim().ToLowerInvariant();
                if (k is "expense" or "income" or "transfer") row.Kind = k;
                else return Results.BadRequest(new { message = "Kind must be expense, income, or transfer." });
            }

            // "Apply to future": learn an equals rule on the (lower-cased) merchant for this category.
            if (req.ApplyToFuture == true && !string.IsNullOrWhiteSpace(row.Category)
                && !string.IsNullOrWhiteSpace(row.Merchant))
                await UpsertRuleAsync(db, household.Id, row.Merchant, row.Category!, ct);

            await db.SaveChangesAsync(ct);
            return Results.Ok(ToStagedRowDto(row));
        });

        // -----------------------------------------------------------------------------
        // POST /import/{importId}/commit — atomically materialize a staged batch into the ledger.
        // -----------------------------------------------------------------------------
        g.MapPost("/import/{importId:long}/commit", async (
            long importId, CommitRequest? req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var batch = await db.FinanceImports.FirstOrDefaultAsync(i => i.Id == importId, ct);
            if (batch is null || batch.HouseholdId != household.Id) return ImportNotFound();
            if (batch.Status == "committed")
                return Results.BadRequest(new { message = "This batch was already committed." });
            if (batch.Status != "staged")
                return Results.BadRequest(new { message = "This batch can no longer be committed." });

            return await CommitStagedAsync(db, household.Id, batch, req?.ExcludeIds, ct);
        });

        // -----------------------------------------------------------------------------
        // DELETE /import/{importId} — discard a STAGED batch (committed batches are immutable).
        // -----------------------------------------------------------------------------
        g.MapDelete("/import/{importId:long}", async (
            long importId, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var batch = await db.FinanceImports.FirstOrDefaultAsync(i => i.Id == importId, ct);
            if (batch is null || batch.HouseholdId != household.Id) return ImportNotFound();
            if (batch.Status == "committed")
                return Results.BadRequest(new { message = "A committed import can't be discarded." });

            // Cascade deletes the staged rows; mark the batch discarded (kept as an audit row).
            var staged = await db.FinanceStagedTransactions
                .Where(s => s.HouseholdId == household.Id && s.ImportId == importId)
                .ToListAsync(ct);
            db.FinanceStagedTransactions.RemoveRange(staged);
            batch.Status = "discarded";
            await db.SaveChangesAsync(ct);

            return Results.NoContent();
        });
    }

    /// <summary>Max staged rows returned inline in the parse preview (the rest are paged via /staged).</summary>
    private const int StagedPreviewCap = 200;

    // =====================================================================================
    // STAGING + COMMIT — shared bodies (the legacy /import and /import/parse+/commit reuse these)
    // =====================================================================================

    /// <summary>
    /// Parse a file (by <paramref name="format"/>), DETERMINISTICALLY categorize each row (file → household
    /// rule/default map), flag duplicates (against the committed ledger AND within the batch, FITID-preferred),
    /// and write a FinanceImport(Status='staged') + its staged rows. Does NOT touch the live ledger. Returns the
    /// batch + the raw parse counts.
    /// </summary>
    private static async Task<(FinanceImport Batch, ParseCounts Parse)> StageAsync(
        UsageDbContext db, int householdId, int callerId, string fileName, string format,
        string content, BankImportParsers.ColumnMap? map, CancellationToken ct)
    {
        // Normalize all formats to the common ParsedTxn shape.
        var (rows, rowCount, skippedCount, detected) = ParseToCommon(format, content, map);

        var now = DateTime.UtcNow;
        var batch = new FinanceImport
        {
            HouseholdId = householdId,
            FileName = fileName,
            Format = format,
            Status = "staged",
            RowCount = rowCount,
            ImportedCount = 0,
            SkippedCount = skippedCount,
            ImportedByUserId = callerId,
            CreatedUtc = now,
        };
        db.FinanceImports.Add(batch);
        await db.SaveChangesAsync(ct);

        // The household's deterministic categorizer rules (learned + seeded).
        var rules = await db.FinanceCategoryRules.AsNoTracking()
            .Where(r => r.HouseholdId == householdId).ToListAsync(ct);

        // Dedup context: every committed CONTENT HASH + every committed FITID for this household. FITID is now
        // PERSISTED on the ledger, so a re-imported OFX file dedups by its stable bank id (not by content) — this
        // is what lets two genuinely-distinct same-day/amount/merchant txns (different FITIDs) BOTH import while
        // re-importing the same file still adds nothing.
        var committedHashes = await db.FinanceTransactions
            .Where(t => t.HouseholdId == householdId)
            .Select(t => t.DedupHash).ToListAsync(ct);
        var ledgerHashes = new HashSet<string>(committedHashes, StringComparer.Ordinal);
        var committedFitids = await db.FinanceTransactions
            .Where(t => t.HouseholdId == householdId && t.Fitid != null)
            .Select(t => t.Fitid!).ToListAsync(ct);
        var ledgerFitids = new HashSet<string>(committedFitids, StringComparer.Ordinal);

        var batchHashes = new HashSet<string>(StringComparer.Ordinal);
        var batchFitids = new HashSet<string>(StringComparer.Ordinal);

        foreach (var row in rows)
        {
            var key = RocketMoneyCsv.AccountKey(row.AccountName, row.Institution);
            var hash = RocketMoneyCsv.DedupHash(key, row.Date, row.RawAmount, row.Merchant, row.Description);

            // Dedup verdict, FITID-authoritative:
            //  - A row WITH a FITID is a duplicate if that FITID is already committed OR collides within this
            //    batch, OR its content hash is already in the COMMITTED ledger (the cross-format bridge: the same
            //    txn came in earlier via a non-FITID format that committed a null FITID). It is NEVER content-
            //    deduped WITHIN this batch — a distinct FITID is a distinct txn even when (date|amount|merchant|
            //    memo) match exactly (e.g. two $4.50 coffees the same day, the HIGH under-count bug).
            //  - A row with NO FITID falls back to the content hash (committed ledger OR within-batch).
            bool isDup;
            if (!string.IsNullOrWhiteSpace(row.Fitid))
            {
                var fitid = row.Fitid!;
                isDup = ledgerFitids.Contains(fitid)       // same FITID already in the committed ledger
                    || ledgerHashes.Contains(hash);        // same content already committed (cross-format bridge)
                if (!batchFitids.Add(fitid)) isDup = true; // same FITID twice in this file
            }
            else
            {
                isDup = ledgerHashes.Contains(hash);       // already in the committed ledger (content)
                if (!batchHashes.Add(hash)) isDup = true;  // duplicate within this batch (content)
            }

            var cat = FinanceCategorizer.Categorize(row.Category, row.Merchant, rules);

            db.FinanceStagedTransactions.Add(new FinanceStagedTransaction
            {
                HouseholdId = householdId,
                ImportId = batch.Id,
                RowIndex = row.RowIndex,
                Date = row.Date,
                Merchant = row.Merchant,
                Description = row.Description,
                RawAmount = row.RawAmount,
                Magnitude = row.Magnitude,
                Kind = KindString(row.Kind),
                AccountKey = Clamp(key, 420),
                AccountName = Clamp(string.IsNullOrWhiteSpace(row.AccountName) ? "Unnamed account" : row.AccountName, 200),
                Institution = string.IsNullOrWhiteSpace(row.Institution) ? null : Clamp(row.Institution, 200),
                AccountTypeRaw = Clamp(row.AccountTypeRaw, 120),
                Category = cat.Category is null ? null : Clamp(cat.Category, 120),
                SuggestedCategory = null,
                CategorySource = cat.Source,
                Fitid = string.IsNullOrWhiteSpace(row.Fitid) ? null : Clamp(row.Fitid!, 255),
                DedupHash = hash,
                IsDuplicate = isDup,
                Excluded = false,
                CreatedUtc = now,
            });
        }

        await db.SaveChangesAsync(ct);
        return (batch, new ParseCounts(rowCount, skippedCount, detected));
    }

    /// <summary>The shared, ATOMIC commit body. Find-or-creates a FinanceAccount per AccountKey, inserts deduped
    /// FinanceTransaction rows from the non-excluded, non-duplicate staged rows (carrying the reviewed Category +
    /// Kind), flips the batch to 'committed' with final counts + CommittedUtc, and deletes the staged rows — all
    /// in ONE SaveChanges so a unique-index race rolls the whole thing back (retryable 409). Returns the existing
    /// <see cref="ImportResultDto"/>.</summary>
    private static async Task<IResult> CommitStagedAsync(
        UsageDbContext db, int householdId, FinanceImport batch, IReadOnlyList<long>? excludeIds, CancellationToken ct)
    {
        var excluded = excludeIds is { Count: > 0 }
            ? new HashSet<long>(excludeIds) : new HashSet<long>();

        var staged = await db.FinanceStagedTransactions
            .Where(s => s.HouseholdId == householdId && s.ImportId == batch.Id)
            .OrderBy(s => s.RowIndex).ThenBy(s => s.Id)
            .ToListAsync(ct);

        var now = DateTime.UtcNow;

        // Find-or-create accounts (in-memory; persisted with the transactions in one atomic save).
        var existingAccounts = await db.FinanceAccounts
            .Where(a => a.HouseholdId == householdId).ToListAsync(ct);
        var byKey = existingAccounts.ToDictionary(
            a => RocketMoneyCsv.AccountKey(a.Name, a.Institution ?? ""), a => a);

        // Existing committed hashes + FITIDs guard against an overlapping commit landing between stage + commit.
        // The guard is FITID-aware to match the stage verdict: a FITID row is guarded by its (persisted) bank id,
        // a no-FITID row by its content hash. (A FITID row must NOT be dropped by the content guard — two
        // distinct same-content txns with different FITIDs legitimately share a DedupHash.)
        var existingHashes = await db.FinanceTransactions
            .Where(t => t.HouseholdId == householdId)
            .Select(t => t.DedupHash).ToListAsync(ct);
        var seenHashes = new HashSet<string>(existingHashes, StringComparer.Ordinal);
        var existingFitids = await db.FinanceTransactions
            .Where(t => t.HouseholdId == householdId && t.Fitid != null)
            .Select(t => t.Fitid!).ToListAsync(ct);
        var seenFitids = new HashSet<string>(existingFitids, StringComparer.Ordinal);

        var touched = new HashSet<string>(StringComparer.Ordinal);
        var imported = 0;
        var skipped = batch.SkippedCount; // seed from the unparseable rows recorded at parse time

        foreach (var s in staged)
        {
            // Skip excluded + already-flagged duplicates so nothing double-counts into the ledger.
            if (s.Excluded || excluded.Contains(s.Id) || s.IsDuplicate) { skipped++; continue; }

            var key = s.AccountKey;
            touched.Add(key);

            if (!byKey.TryGetValue(key, out var account))
            {
                account = new FinanceAccount
                {
                    HouseholdId = householdId,
                    Name = Clamp(string.IsNullOrWhiteSpace(s.AccountName) ? "Unnamed account" : s.AccountName, 200),
                    Institution = string.IsNullOrWhiteSpace(s.Institution) ? null : Clamp(s.Institution, 200),
                    Owner = "unassigned",
                    Kind = RocketMoneyCsv.AccountKind(s.AccountTypeRaw),
                    CreatedUtc = now,
                };
                db.FinanceAccounts.Add(account);
                byKey[key] = account;
            }

            // Final in-memory dedup guard (a row the flagger missed — e.g. a concurrent commit landed between
            // stage + commit). FITID-aware to mirror the stage verdict:
            //  - A FITID row is dropped if its bank id is already seen, OR (cross-format bridge) its content hash
            //    is already in the COMMITTED ledger — but two distinct FITIDs that collide on content WITHIN this
            //    batch both commit (the content guard never sinks a fresh FITID). seenFitids + the filtered unique
            //    index on (HouseholdId, Fitid) are the DB backstop.
            //  - A no-FITID row is guarded by its content hash (seenHashes + the (HouseholdId, DedupHash) index).
            if (!string.IsNullOrWhiteSpace(s.Fitid))
            {
                if (!seenFitids.Add(s.Fitid!) || seenHashes.Contains(s.DedupHash)) { skipped++; continue; }
            }
            else
            {
                if (!seenHashes.Add(s.DedupHash)) { skipped++; continue; }
            }

            db.FinanceTransactions.Add(new FinanceTransaction
            {
                HouseholdId = householdId,
                Account = account, // EF fixes up the FK after the account gets its Id in the same save
                Date = s.Date,
                Merchant = s.Merchant,
                Description = s.Description,
                Magnitude = s.Magnitude,
                RawAmount = s.RawAmount,
                Kind = s.Kind,
                Category = s.Category,
                Note = null,
                DedupHash = s.DedupHash,
                Fitid = s.Fitid,
                ImportId = batch.Id,
                CreatedUtc = now,
            });
            imported++;
        }

        // Flip the batch + remove the staged rows in the SAME atomic save as the inserts.
        batch.Status = "committed";
        batch.ImportedCount = imported;
        batch.SkippedCount = skipped;
        batch.CommittedUtc = now;
        db.FinanceStagedTransactions.RemoveRange(staged);

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            // A concurrent/overlapping commit won an insert race on a unique index (account, DedupHash, or the
            // filtered (HouseholdId, Fitid) index) — the whole transaction rolled back. Clean retryable 409
            // (the batch stays 'staged').
            return ImportConflict();
        }

        var accounts = byKey.Values
            .Where(a => touched.Contains(RocketMoneyCsv.AccountKey(a.Name, a.Institution ?? "")))
            .OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ThenBy(a => a.Id)
            .Select(a => new AccountSummaryDto(a.Id, a.Name, a.Institution, a.Owner, a.Kind))
            .ToList();

        return Results.Ok(new ImportResultDto(batch.Id, batch.RowCount, imported, skipped, accounts));
    }

    /// <summary>The raw parse counts surfaced from <see cref="StageAsync"/> (the detected columns drive the
    /// review's column hints).</summary>
    private readonly record struct ParseCounts(int RowCount, int SkippedCount, IReadOnlyList<string> DetectedColumns);

    /// <summary>Normalize any supported format to the common <see cref="BankImportParsers.ParsedTxn"/> shape.</summary>
    private static (IReadOnlyList<BankImportParsers.ParsedTxn> Rows, int RowCount, int SkippedCount, IReadOnlyList<string> Detected)
        ParseToCommon(string format, string content, BankImportParsers.ColumnMap? map)
    {
        switch (format)
        {
            case "ofx":
            {
                var r = BankImportParsers.ParseOfx(content);
                return (r.Rows, r.RowCount, r.SkippedCount, r.DetectedColumns);
            }
            case "csv":
            {
                var r = BankImportParsers.ParseGenericCsv(content, map ?? new BankImportParsers.ColumnMap());
                return (r.Rows, r.RowCount, r.SkippedCount, r.DetectedColumns);
            }
            default: // rocketmoney
            {
                var rm = RocketMoneyCsv.Parse(content);
                var detected = RocketMoneyCsv.ReadRecordsShared(content) is { Count: > 0 } recs
                    ? recs[0].Select(h => h.Trim()).Where(h => h.Length > 0).ToList()
                    : new List<string>();
                var idx = 0;
                var rows = rm.Rows.Select(p => new BankImportParsers.ParsedTxn(
                    idx++, p.AccountName, p.Institution, p.AccountTypeRaw, p.Date, p.Merchant, p.Description,
                    p.RawAmount, p.Magnitude, p.Kind, p.Category, Fitid: null)).ToList();
                return (rows, rm.RowCount, rm.SkippedCount, detected);
            }
        }
    }

    /// <summary>Pick the import format: an explicit "rocketmoney"/"csv"/"ofx" honored; otherwise AUTO-detect from
    /// the extension + content (OFX markers → ofx; a Rocket-Money header → rocketmoney; else a generic csv).</summary>
    private static string DetectFormat(string? requested, string fileName, string content)
    {
        var r = (requested ?? "auto").Trim().ToLowerInvariant();
        if (r is "rocketmoney" or "csv" or "ofx") return r;

        var lowerName = fileName.ToLowerInvariant();
        if (lowerName.EndsWith(".ofx") || lowerName.EndsWith(".qfx")) return "ofx";

        // Content sniff: OFX statements carry these markers.
        if (content.Contains("<OFX>", StringComparison.OrdinalIgnoreCase)
            || content.Contains("<STMTTRN>", StringComparison.OrdinalIgnoreCase)
            || content.Contains("OFXHEADER", StringComparison.OrdinalIgnoreCase))
            return "ofx";

        // A Rocket Money export has this signature header (Account Name + Institution Name columns).
        var firstLine = content.Split('\n', 2)[0];
        if (firstLine.Contains("Institution Name", StringComparison.OrdinalIgnoreCase)
            && firstLine.Contains("Account Name", StringComparison.OrdinalIgnoreCase)
            && firstLine.Contains("Amount", StringComparison.OrdinalIgnoreCase))
            return "rocketmoney";

        return "csv"; // a generic CSV needs a column map (the parse endpoint enforces this)
    }

    /// <summary>The FIXED category enum the AI classifier is constrained to: the deterministic defaults PLUS any
    /// category already present on the household's committed ledger (so the household's own vocabulary is kept).
    /// </summary>
    private static async Task<IReadOnlyList<string>> AllowedCategoriesAsync(
        UsageDbContext db, int householdId, CancellationToken ct)
    {
        var ledgerCats = await db.FinanceTransactions.AsNoTracking()
            .Where(t => t.HouseholdId == householdId && t.Category != null && t.Category != "")
            .Select(t => t.Category!)
            .Distinct()
            .ToListAsync(ct);

        return FinanceCategorizer.DefaultCategories
            .Concat(ledgerCats)
            .Select(c => c.Trim())
            .Where(c => c.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>Upsert an "equals" household category rule on the (lower-cased) merchant — auto-learned when a
    /// user fixes a category at review with "apply to future". Idempotent: an existing equals rule for the same
    /// merchant has its category updated.</summary>
    private static async Task UpsertRuleAsync(
        UsageDbContext db, int householdId, string merchant, string category, CancellationToken ct)
    {
        var pattern = merchant.Trim().ToLowerInvariant();
        if (pattern.Length == 0) return;
        if (pattern.Length > 200) pattern = pattern[..200];

        var existing = await db.FinanceCategoryRules
            .FirstOrDefaultAsync(r => r.HouseholdId == householdId
                && r.MatchType == "equals" && r.Pattern == pattern, ct);
        if (existing is not null)
        {
            existing.Category = Clamp(category, 120);
            return;
        }
        db.FinanceCategoryRules.Add(new FinanceCategoryRule
        {
            HouseholdId = householdId,
            MatchType = "equals",
            Pattern = pattern,
            Category = Clamp(category, 120),
            CreatedUtc = DateTime.UtcNow,
        });
    }

    private static StagedRowDto ToStagedRowDto(FinanceStagedTransaction s) => new(
        s.Id, s.RowIndex, s.Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        s.Merchant, s.Description, s.RawAmount, s.Magnitude, s.Kind,
        s.AccountKey, s.AccountName, s.Institution,
        s.Category, s.SuggestedCategory, s.CategorySource, s.IsDuplicate, s.Excluded);

    private static IResult ImportNotFound() =>
        Results.NotFound(new { message = "That import doesn't exist." });

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

            // Plain summary is the floor. Prefer the warm AI narrative ONLY when the caller holds finance.ai
            // (the gated, token-spending capability) AND Gemini is configured — a family.finance caller without
            // finance.ai always gets the deterministic plain summary (never spends tokens).
            if (!caller.Permissions.Contains(Permissions.FinanceAi) || !gemini.IsConfigured)
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

            // Recurring list is the floor. Prefer the warm AI narration ONLY when the caller holds finance.ai
            // (the gated, token-spending capability) AND Gemini is configured — a family.finance caller without
            // finance.ai always gets the deterministic recurring-charge floor (never spends tokens).
            if (!caller.Permissions.Contains(Permissions.FinanceAi) || !gemini.IsConfigured)
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
    // BUDGETS — deterministic per-category spend-vs-budget by PACE (transfers excluded)
    // =====================================================================================

    private static void MapBudgets(RouteGroupBuilder g)
    {
        // GET /budgets?month=YYYY-MM — each budget with deterministic spent-this-month (EXPENSE-only) + remaining
        // + pct + a pace projection, plus an unbudgeted rollup. Pure read (writes nothing).
        g.MapGet("/budgets", async (
            string? month, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var result = await ComputeBudgetsAsync(db, household.Id, month, ct);
            return Results.Ok(result);
        });

        // POST /budgets — create a budget for a category (null/blank = the overall whole-month budget).
        g.MapPost("/budgets", async (
            BudgetUpsertRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            if (!TryNormalizeLimit(req.LimitAmount, out var limit, out var limitError))
                return Results.BadRequest(new { message = limitError });
            var category = NormalizeBudgetCategory(req.Category);

            var now = DateTime.UtcNow;
            var budget = new FinanceBudget
            {
                HouseholdId = household.Id,
                Category = category,
                LimitAmount = limit,
                Period = "monthly",
                CreatedByUserId = caller.Id,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            db.FinanceBudgets.Add(budget);

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                return Results.Conflict(new { message = "A budget for that category already exists." });
            }

            return Results.Ok(new BudgetDto(
                budget.Id, budget.Category, budget.LimitAmount, 0m, budget.LimitAmount, 0.0, 0m, "under"));
        });

        // PUT /budgets/{id} — update a budget's limit (and/or move its category). Cross-household id → 404.
        g.MapPut("/budgets/{id:int}", async (
            int id, BudgetUpsertRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var budget = await db.FinanceBudgets.FirstOrDefaultAsync(b => b.Id == id, ct);
            if (budget is null || budget.HouseholdId != household.Id) return BudgetNotFound();

            if (req.LimitAmount is not null)
            {
                if (!TryNormalizeLimit(req.LimitAmount, out var limit, out var limitError))
                    return Results.BadRequest(new { message = limitError });
                budget.LimitAmount = limit;
            }
            if (req.Category is not null)
                budget.Category = NormalizeBudgetCategory(req.Category);
            budget.UpdatedUtc = DateTime.UtcNow;

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                return Results.Conflict(new { message = "A budget for that category already exists." });
            }

            return Results.Ok(new BudgetDto(
                budget.Id, budget.Category, budget.LimitAmount, 0m, budget.LimitAmount, 0.0, 0m, "under"));
        });

        // DELETE /budgets/{id} — remove a budget. Cross-household id → 404.
        g.MapDelete("/budgets/{id:int}", async (
            int id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var budget = await db.FinanceBudgets.FirstOrDefaultAsync(b => b.Id == id, ct);
            if (budget is null || budget.HouseholdId != household.Id) return BudgetNotFound();

            db.FinanceBudgets.Remove(budget);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
    }

    /// <summary>The deterministic budgets read for a month, shared by GET /budgets and the AI budget check. Loads
    /// the household's budget rows + the month's EXPENSE-only spend (via the SHARED <see cref="FinanceSpendMath"/>),
    /// projects each budget's pace, and rolls up unbudgeted spend. The month is resolved like GET /summary (the
    /// requested YYYY-MM, else the most recent month with data, else now).</summary>
    private static async Task<BudgetsResponseDto> ComputeBudgetsAsync(
        UsageDbContext db, int householdId, string? month, CancellationToken ct)
    {
        var (from, toExclusive) = await ResolveMonthAsync(db, householdId, month, ct);
        var monthLabel = from.ToString("yyyy-MM", CultureInfo.InvariantCulture);

        // Pace the month "as of" today when it's the current month, else the full month.
        var today = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
        var dayOfMonth = FinanceSpendMath.ElapsedDayOfMonth(from, today);
        var daysInMonth = DateTime.DaysInMonth(from.Year, from.Month);

        var rows = await FinanceSpendMath.LoadExpenseRowsAsync(db, householdId, from, toExclusive, ct);
        var totalSpent = FinanceSpendMath.TotalSpent(rows);
        var spentByCategory = FinanceSpendMath.SpentByCategory(rows);

        var budgets = await db.FinanceBudgets.AsNoTracking()
            .Where(b => b.HouseholdId == householdId)
            .ToListAsync(ct);

        var budgetDtos = new List<BudgetDto>(budgets.Count);
        var budgetedKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var b in budgets
            .OrderBy(b => b.Category is null ? 0 : 1) // the overall budget first
            .ThenBy(b => b.Category, StringComparer.OrdinalIgnoreCase))
        {
            decimal spent;
            if (b.Category is null)
            {
                spent = totalSpent; // the OVERALL budget is checked against the whole-month spend
            }
            else
            {
                var key = FinanceSpendMath.CategoryKey(b.Category);
                budgetedKeys.Add(key);
                spent = spentByCategory.TryGetValue(key, out var s) ? s : 0m;
            }

            var projected = FinanceSpendMath.ProjectPace(spent, dayOfMonth, daysInMonth);
            var pct = b.LimitAmount > 0 ? Math.Round((double)(spent / b.LimitAmount) * 100.0, 1) : 0.0;
            budgetDtos.Add(new BudgetDto(
                b.Id, b.Category, b.LimitAmount, decimal.Round(spent, 2),
                decimal.Round(b.LimitAmount - spent, 2), pct, projected,
                BudgetStatus(projected, b.LimitAmount)));
        }

        // Unbudgeted = spend in categories with NO per-category budget (the overall budget doesn't absorb gaps).
        var unbudgeted = spentByCategory
            .Where(kv => !budgetedKeys.Contains(kv.Key))
            .ToList();
        var unbudgetedSpent = unbudgeted.Sum(kv => kv.Value);

        return new BudgetsResponseDto(
            monthLabel, budgetDtos,
            new UnbudgetedDto(decimal.Round(unbudgetedSpent, 2), unbudgeted.Count),
            decimal.Round(totalSpent, 2));
    }

    /// <summary>"under" | "near" | "over" by PACE: over once the projection exceeds the limit, near once it
    /// reaches <see cref="NearBudgetThreshold"/> of the limit.</summary>
    private static string BudgetStatus(decimal projected, decimal limit)
    {
        if (limit <= 0) return "under";
        if (projected > limit) return "over";
        if ((double)(projected / limit) >= NearBudgetThreshold) return "near";
        return "under";
    }

    /// <summary>Normalize a budget category: trim; null/blank → null (the overall budget); clamped to 120.</summary>
    private static string? NormalizeBudgetCategory(string? category)
    {
        var c = (category ?? "").Trim();
        return c.Length == 0 ? null : Clamp(c, 120);
    }

    /// <summary>Validate + normalize a budget/limit amount: required, non-negative, finite.</summary>
    private static bool TryNormalizeLimit(decimal? amount, out decimal limit, out string error)
    {
        limit = 0m;
        error = "";
        if (amount is not decimal a) { error = "A limit amount is required."; return false; }
        if (a < 0) { error = "A limit can't be negative."; return false; }
        limit = decimal.Round(a, 2);
        return true;
    }

    private static IResult BudgetNotFound() =>
        Results.NotFound(new { message = "That budget doesn't exist." });

    // =====================================================================================
    // NET WORTH — signed manual balance snapshots; net worth = latest snapshot per account
    // =====================================================================================

    private static void MapNetWorth(RouteGroupBuilder g)
    {
        // GET /net-worth — newest snapshot per account → assets / liabilities / net worth + per-account rows +
        // a net-worth-by-month trend from the snapshot history. MANUAL entry (no bank feed). Writes nothing.
        g.MapGet("/net-worth", async (
            CurrentUserAccessor me, CurrentHouseholdAccessor households, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var result = await ComputeNetWorthAsync(db, household.Id, ct);
            return Results.Ok(result);
        });

        // POST /accounts/{id}/balance — upsert today's (or a chosen day's) SIGNED balance for one household
        // account. Cross-household account → 404 (existence never leaked).
        g.MapPost("/accounts/{id:int}/balance", async (
            int id, BalanceEntryRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var account = await db.FinanceAccounts.FirstOrDefaultAsync(a => a.Id == id, ct);
            if (account is null || account.HouseholdId != household.Id) return NotFound();

            if (req.Balance is not decimal balance)
                return Results.BadRequest(new { message = "A balance is required." });

            var asOf = await TrackerVisibility.DisplayTzTodayAsync(db, ct);
            if (!string.IsNullOrWhiteSpace(req.AsOfDate))
            {
                if (!DateOnly.TryParseExact(req.AsOfDate!.Trim(), "yyyy-MM-dd",
                        CultureInfo.InvariantCulture, DateTimeStyles.None, out asOf))
                    return Results.BadRequest(new { message = "AsOfDate must be YYYY-MM-DD." });
            }

            var note = string.IsNullOrWhiteSpace(req.Note) ? null : Clamp(req.Note, 500);

            // Upsert (latest-wins) on (household, account, day).
            var existing = await db.FinanceBalanceSnapshots
                .FirstOrDefaultAsync(s => s.HouseholdId == household.Id
                    && s.AccountId == id && s.AsOfDate == asOf, ct);
            if (existing is not null)
            {
                existing.Balance = decimal.Round(balance, 2);
                existing.Note = note;
                existing.EnteredByUserId = caller.Id;
            }
            else
            {
                db.FinanceBalanceSnapshots.Add(new FinanceBalanceSnapshot
                {
                    HouseholdId = household.Id,
                    AccountId = id,
                    AsOfDate = asOf,
                    Balance = decimal.Round(balance, 2),
                    Note = note,
                    EnteredByUserId = caller.Id,
                    CreatedUtc = DateTime.UtcNow,
                });
            }

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsUniqueViolation(ex))
            {
                // A concurrent same-day entry won the race — the latest value is in; return the net worth.
            }

            var result = await ComputeNetWorthAsync(db, household.Id, ct);
            return Results.Ok(result);
        });
    }

    /// <summary>The deterministic net-worth read: each account's MOST-RECENT snapshot summed with the SIGN
    /// convention (positive = asset, negative = liability), plus the per-account rows and a 12-month trend (net
    /// worth = sum of each account's latest snapshot AT OR BEFORE each month-end). Writes nothing.</summary>
    private static async Task<NetWorthDto> ComputeNetWorthAsync(
        UsageDbContext db, int householdId, CancellationToken ct)
    {
        var accounts = await db.FinanceAccounts.AsNoTracking()
            .Where(a => a.HouseholdId == householdId)
            .Select(a => new { a.Id, a.Name, a.Owner, a.Kind })
            .ToListAsync(ct);

        var snapshots = await db.FinanceBalanceSnapshots.AsNoTracking()
            .Where(s => s.HouseholdId == householdId)
            .Select(s => new { s.AccountId, s.AsOfDate, s.Balance })
            .ToListAsync(ct);

        // Latest snapshot per account (newest AsOfDate wins).
        var latestByAccount = snapshots
            .GroupBy(s => s.AccountId)
            .ToDictionary(grp => grp.Key, grp => grp
                .OrderByDescending(s => s.AsOfDate)
                .First());

        var accountRows = accounts
            .OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ThenBy(a => a.Id)
            .Select(a =>
            {
                if (latestByAccount.TryGetValue(a.Id, out var snap))
                    return new AccountBalanceDto(a.Id, a.Name, a.Owner, a.Kind, snap.Balance,
                        snap.AsOfDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), true);
                return new AccountBalanceDto(a.Id, a.Name, a.Owner, a.Kind, 0m, null, false);
            })
            .ToList();

        var assets = latestByAccount.Values.Where(s => s.Balance > 0).Sum(s => s.Balance);
        var liabilities = latestByAccount.Values.Where(s => s.Balance < 0).Sum(s => s.Balance); // negative
        var netWorth = assets + liabilities;

        // A 12-month net-worth trend: for each month-end, sum each account's latest snapshot AT OR BEFORE it.
        var trend = new List<NetWorthTrendPointDto>(12);
        if (snapshots.Count > 0)
        {
            var anchor = snapshots.Max(s => s.AsOfDate);
            var anchorMonth = new DateOnly(anchor.Year, anchor.Month, 1);
            var byAccount = snapshots.GroupBy(s => s.AccountId)
                .ToDictionary(grp => grp.Key, grp => grp.OrderBy(s => s.AsOfDate).ToList());

            for (var i = 11; i >= 0; i--)
            {
                var monthStart = anchorMonth.AddMonths(-i);
                var monthEndExclusive = monthStart.AddMonths(1);
                decimal nw = 0m;
                foreach (var rows in byAccount.Values)
                {
                    // The newest snapshot strictly before next month (i.e. as of this month-end).
                    decimal? latest = null;
                    foreach (var s in rows)
                    {
                        if (s.AsOfDate < monthEndExclusive) latest = s.Balance;
                        else break;
                    }
                    if (latest is decimal v) nw += v;
                }
                trend.Add(new NetWorthTrendPointDto(
                    monthStart.ToString("yyyy-MM", CultureInfo.InvariantCulture), decimal.Round(nw, 2)));
            }
        }

        return new NetWorthDto(
            decimal.Round(assets, 2), decimal.Round(liabilities, 2), decimal.Round(netWorth, 2),
            accountRows, trend);
    }

    // =====================================================================================
    // SAVINGS GOALS — manual saved/target with a contribution-pace projected finish
    // =====================================================================================

    private static void MapSavings(RouteGroupBuilder g)
    {
        // GET /savings?includeArchived= — goals with saved/target/pct + a projected finish from pace.
        g.MapGet("/savings", async (
            bool? includeArchived, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var q = db.FinanceSavingsGoals.AsNoTracking()
                .Where(s => s.HouseholdId == household.Id);
            if (includeArchived != true)
                q = q.Where(s => !s.Archived);

            var loaded = await q.ToListAsync(ct);
            var goals = loaded
                .OrderBy(s => s.Archived)
                .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase).ThenBy(s => s.Id)
                .ToList();

            var dtos = goals.Select(ToSavingsDto).ToList();
            var totalSaved = goals.Where(s => !s.Archived).Sum(s => s.SavedAmount);
            var totalTarget = goals.Where(s => !s.Archived).Sum(s => s.TargetAmount);

            return Results.Ok(new SavingsResponseDto(
                dtos, decimal.Round(totalSaved, 2), decimal.Round(totalTarget, 2)));
        });

        // POST /savings — create a goal.
        g.MapPost("/savings", async (
            SavingsUpsertRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var name = (req.Name ?? "").Trim();
            if (name.Length == 0)
                return Results.BadRequest(new { message = "A goal name is required." });
            if (!TryNormalizeLimit(req.TargetAmount, out var target, out _))
                return Results.BadRequest(new { message = "A non-negative target amount is required." });
            if (!TryParseOptionalDate(req.TargetDate, out var targetDate, out var dateError))
                return Results.BadRequest(new { message = dateError });

            var now = DateTime.UtcNow;
            var goal = new FinanceSavingsGoal
            {
                HouseholdId = household.Id,
                Name = Clamp(name, 200),
                TargetAmount = target,
                SavedAmount = 0m,
                TargetDate = targetDate,
                Owner = NormalizeOwner(req.Owner),
                Color = string.IsNullOrWhiteSpace(req.Color) ? null : Clamp(req.Color, 32),
                Icon = string.IsNullOrWhiteSpace(req.Icon) ? null : Clamp(req.Icon, 64),
                Archived = false,
                CreatedByUserId = caller.Id,
                CreatedUtc = now,
                UpdatedUtc = now,
            };
            db.FinanceSavingsGoals.Add(goal);
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToSavingsDto(goal));
        });

        // PUT /savings/{id} — update goal fields (NOT SavedAmount — use /contribute). Cross-household id → 404.
        g.MapPut("/savings/{id:int}", async (
            int id, SavingsUpsertRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var goal = await db.FinanceSavingsGoals.FirstOrDefaultAsync(s => s.Id == id, ct);
            if (goal is null || goal.HouseholdId != household.Id) return SavingsNotFound();

            if (req.Name is not null)
            {
                var name = req.Name.Trim();
                if (name.Length == 0)
                    return Results.BadRequest(new { message = "A goal name is required." });
                goal.Name = Clamp(name, 200);
            }
            if (req.TargetAmount is not null)
            {
                if (!TryNormalizeLimit(req.TargetAmount, out var target, out _))
                    return Results.BadRequest(new { message = "A non-negative target amount is required." });
                goal.TargetAmount = target;
            }
            if (req.TargetDate is not null)
            {
                if (req.TargetDate.Trim().Length == 0) goal.TargetDate = null;
                else if (TryParseOptionalDate(req.TargetDate, out var d, out var dateError)) goal.TargetDate = d;
                else return Results.BadRequest(new { message = dateError });
            }
            if (req.Owner is not null) goal.Owner = NormalizeOwner(req.Owner);
            if (req.Color is not null) goal.Color = req.Color.Trim().Length == 0 ? null : Clamp(req.Color, 32);
            if (req.Icon is not null) goal.Icon = req.Icon.Trim().Length == 0 ? null : Clamp(req.Icon, 64);
            if (req.Archived is bool archived) goal.Archived = archived;
            goal.UpdatedUtc = DateTime.UtcNow;

            await db.SaveChangesAsync(ct);
            return Results.Ok(ToSavingsDto(goal));
        });

        // POST /savings/{id}/contribute — adjust SavedAmount by a signed amount (floors at 0). Cross-household → 404.
        g.MapPost("/savings/{id:int}/contribute", async (
            int id, ContributeRequest req, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var goal = await db.FinanceSavingsGoals.FirstOrDefaultAsync(s => s.Id == id, ct);
            if (goal is null || goal.HouseholdId != household.Id) return SavingsNotFound();

            if (req.Amount is not decimal amount || amount == 0m)
                return Results.BadRequest(new { message = "A non-zero contribution amount is required." });

            goal.SavedAmount = Math.Max(0m, decimal.Round(goal.SavedAmount + amount, 2));
            goal.UpdatedUtc = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToSavingsDto(goal));
        });

        // DELETE /savings/{id} — hard-delete a goal (archive is the soft path via PUT). Cross-household → 404.
        g.MapDelete("/savings/{id:int}", async (
            int id, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var goal = await db.FinanceSavingsGoals.FirstOrDefaultAsync(s => s.Id == id, ct);
            if (goal is null || goal.HouseholdId != household.Id) return SavingsNotFound();

            db.FinanceSavingsGoals.Remove(goal);
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
    }

    private static SavingsGoalDto ToSavingsDto(FinanceSavingsGoal g)
    {
        var pct = g.TargetAmount > 0
            ? Math.Round((double)(g.SavedAmount / g.TargetAmount) * 100.0, 1)
            : (g.SavedAmount > 0 ? 100.0 : 0.0);
        pct = Math.Min(pct, 100.0);

        // Projected finish from contribution pace: saved since creation / days elapsed → days to reach target.
        string? projectedFinish = null;
        var remaining = g.TargetAmount - g.SavedAmount;
        if (remaining > 0 && g.SavedAmount > 0)
        {
            var daysElapsed = Math.Max(1, (DateTime.UtcNow - g.CreatedUtc).TotalDays);
            var perDay = (double)g.SavedAmount / daysElapsed;
            if (perDay > 0)
            {
                var daysToFinish = (double)remaining / perDay;
                if (daysToFinish < 365 * 30) // cap at a sane horizon
                    projectedFinish = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(daysToFinish))
                        .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            }
        }

        return new SavingsGoalDto(
            g.Id, g.Name, g.TargetAmount, g.SavedAmount, pct,
            g.TargetDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            g.Owner, g.Color, g.Icon, g.Archived, projectedFinish);
    }

    private static string NormalizeOwner(string? owner)
    {
        var o = (owner ?? "").Trim().ToLowerInvariant();
        return Owners.Contains(o) ? o : "unassigned";
    }

    private static bool TryParseOptionalDate(string? value, out DateOnly? date, out string error)
    {
        date = null;
        error = "";
        if (string.IsNullOrWhiteSpace(value)) return true;
        if (!DateOnly.TryParseExact(value.Trim(), "yyyy-MM-dd",
                CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
        {
            error = "A date must be YYYY-MM-DD.";
            return false;
        }
        date = d;
        return true;
    }

    private static IResult SavingsNotFound() =>
        Results.NotFound(new { message = "That savings goal doesn't exist." });

    // =====================================================================================
    // AI — "Budget check-in" (DETERMINISTIC over/near/under floor + read-only narration)
    // =====================================================================================

    private static void MapBudgetCheck(RouteGroupBuilder g)
    {
        // GET /ai/budget-check?month=YYYY-MM — DETERMINISTIC floor (which budgets are over/near/under by pace +
        // the net-worth direction), ALWAYS 200; the finance.ai-gated Gemini narration is the only token spend;
        // cached per (household, month); writes nothing. Same floor contract as /ai/summary + /ai/money-coach.
        g.MapGet("/ai/budget-check", async (
            string? month, CurrentUserAccessor me, CurrentHouseholdAccessor households,
            GeminiService gemini, IMemoryCache cache, UsageDbContext db, CancellationToken ct) =>
        {
            var caller = (await me.GetUserAsync(ct))!;
            var household = (await households.GetOrCreateForCallerAsync(caller, ct))!;

            var budgets = await ComputeBudgetsAsync(db, household.Id, month, ct);
            var netWorthDirection = await NetWorthDirectionAsync(db, household.Id, ct);

            var items = budgets.Budgets
                .Select(b => new BudgetCheckItemDto(b.Category, b.LimitAmount, b.Projected, b.Status))
                .ToList();
            var overCount = items.Count(i => i.Status == "over");
            var nearCount = items.Count(i => i.Status == "near");

            // FLOOR with no budgets: nothing to narrate — return the deterministic (empty) check.
            if (items.Count == 0)
                return Results.Ok(new BudgetCheckDto(
                    budgets.Month, items, 0, 0, netWorthDirection, null, Array.Empty<string>(), true));

            // The deterministic over/near/under list + net-worth direction are the floor. Prefer the warm AI
            // narration ONLY when the caller holds finance.ai AND Gemini is configured.
            if (!caller.Permissions.Contains(Permissions.FinanceAi) || !gemini.IsConfigured)
                return Results.Ok(new BudgetCheckDto(
                    budgets.Month, items, overCount, nearCount, netWorthDirection,
                    null, Array.Empty<string>(), true));

            var cacheKey = $"family:budget-check:{household.Id}:{budgets.Month}";
            if (cache.TryGetValue(cacheKey, out BudgetCheckDto? cached) && cached is not null)
                return Results.Ok(cached);

            string? narrative = null;
            IReadOnlyList<string> tips = Array.Empty<string>();
            try
            {
                var ai = await gemini.BudgetCheckNarrativeAsync(
                    BudgetCheckFacts(budgets, items, netWorthDirection), ct);
                if (ai is not null && !string.IsNullOrWhiteSpace(ai.Narrative))
                {
                    narrative = ai.Narrative;
                    tips = ai.Tips;
                }
            }
            catch
            {
                narrative = null;
            }

            if (narrative is null)
                return Results.Ok(new BudgetCheckDto(
                    budgets.Month, items, overCount, nearCount, netWorthDirection,
                    null, Array.Empty<string>(), true)); // floor

            var dto = new BudgetCheckDto(
                budgets.Month, items, overCount, nearCount, netWorthDirection, narrative, tips, false);
            cache.Set(cacheKey, dto, TimeSpan.FromHours(6));
            return Results.Ok(dto);
        }).RequireRateLimiting(AiEndpoints.RateLimitPolicy);
    }

    /// <summary>The net-worth direction ("up"|"down"|"flat"|"unknown") from the last two trend points — a
    /// deterministic signal for the budget-check floor. "unknown" when there aren't two months of snapshots.</summary>
    private static async Task<string> NetWorthDirectionAsync(UsageDbContext db, int householdId, CancellationToken ct)
    {
        var nw = await ComputeNetWorthAsync(db, householdId, ct);
        var points = nw.Trend.Where(p => p.NetWorth != 0m).ToList();
        if (points.Count < 2) return "unknown";
        // Compare the same two points the >=2 guard counted (the filtered list), not the raw trend tail —
        // otherwise a most-recent month that nets to exactly 0 could be compared against a non-zero and
        // report a spurious up/down direction.
        var last = points[^1].NetWorth;
        var prev = points[^2].NetWorth;
        if (last > prev) return "up";
        if (last < prev) return "down";
        return "flat";
    }

    /// <summary>Pre-format the deterministic budget-check facts as a tight DATA block the model NARRATES (it
    /// never recomputes). Amounts + statuses are the authoritative server figures.</summary>
    private static string BudgetCheckFacts(
        BudgetsResponseDto budgets, IReadOnlyList<BudgetCheckItemDto> items, string netWorthDirection)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append("month: ").Append(budgets.Month).Append('\n');
        sb.Append("total_spent: ").Append(Money(budgets.TotalSpent)).Append('\n');
        sb.Append("net_worth_direction: ").Append(netWorthDirection).Append('\n');
        sb.Append("budgets:\n");
        foreach (var i in items)
        {
            var label = i.Category ?? "Overall";
            sb.Append("- ").Append(label).Append(": limit ").Append(Money(i.LimitAmount))
              .Append(", on pace for ").Append(Money(i.Projected)).Append(" (").Append(i.Status).Append(")\n");
        }
        return sb.ToString();
    }

    /// <summary>Resolve the [from, toExclusive) month window the SAME way GET /summary does (the requested
    /// YYYY-MM, else the most recent month with data, else now).</summary>
    private static async Task<(DateOnly From, DateOnly ToExclusive)> ResolveMonthAsync(
        UsageDbContext db, int householdId, string? month, CancellationToken ct)
    {
        if (TryParseMonth(month, out var from, out var toExclusive))
            return (from, toExclusive);

        var maxDate = await db.FinanceTransactions.AsNoTracking()
            .Where(t => t.HouseholdId == householdId)
            .OrderByDescending(t => t.Date)
            .Select(t => (DateOnly?)t.Date)
            .FirstOrDefaultAsync(ct);
        var anchor = maxDate ?? DateOnly.FromDateTime(DateTime.UtcNow);
        from = new DateOnly(anchor.Year, anchor.Month, 1);
        return (from, from.AddMonths(1));
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
        // Centralized: each TARGET user's wire name applies their own DisplayNameMode/Nickname
        // (presence/chat/family/leaderboard all show the same chosen form). Never an email.
        return await DisplayName.ResolveNamesByIdAsync(db, userIds, ct);
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

    /// <summary>409 when a concurrent/overlapping import won an insert race on a unique index (the per-account
    /// (HouseholdId, Name, Institution) index OR the transaction DedupHash index). Clean + retryable rather
    /// than a raw 500 from the Postgres unique violation.</summary>
    private static IResult ImportConflict() => Results.Problem(
        title: "That import overlapped a concurrent import — please retry",
        detail: "That import overlapped a concurrent import — please retry",
        statusCode: StatusCodes.Status409Conflict);

    /// <summary>True when a save failed on a Postgres unique-index violation (23505) — the signal a concurrent
    /// caller won an insert race. Mirrors <see cref="ChatEndpoints.IsUniqueViolation"/>.</summary>
    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Npgsql.PostgresException pg && pg.SqlState == Npgsql.PostgresErrorCodes.UniqueViolation;
}
