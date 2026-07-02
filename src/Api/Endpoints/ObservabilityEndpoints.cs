using Ccusage.Api.Auth;
using Ccusage.Api.Data;
using Ccusage.Api.Dtos;
using Ccusage.Api.Ingestion;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Endpoints;

public static class ObservabilityEndpoints
{
    public static void MapObservabilityEndpoints(this WebApplication app)
    {
        // Recent request/response action log. Admin-only (it can contain request/response bodies).
        app.MapGet("/api/logs", async (
                UsageDbContext db, CurrentUserAccessor currentUser,
                string? method, string? status, string? q, int? take, CancellationToken ct) =>
            {
                // Raw request/response bodies can contain special-category PII (see RequestLoggingMiddleware's
                // BodyExcluded); restrict them to admins who can already see users (users.view). Callers with
                // only activity.view still get the request LINE (method/path/status/timing/user).
                var caller = await currentUser.GetUserAsync(ct);
                var includeBodies = caller?.Permissions.Contains(Permissions.UsersView) == true;

                var query = db.RequestLogs.AsNoTracking().AsQueryable();

                if (!string.IsNullOrWhiteSpace(method))
                    query = query.Where(r => r.Method == method.ToUpper());

                // status = "2xx" | "3xx" | "4xx" | "5xx"
                if (!string.IsNullOrWhiteSpace(status) && status.Length == 3 && char.IsDigit(status[0]))
                {
                    var lo = (status[0] - '0') * 100;
                    query = query.Where(r => r.StatusCode >= lo && r.StatusCode < lo + 100);
                }

                if (!string.IsNullOrWhiteSpace(q))
                    query = query.Where(r => EF.Functions.ILike(r.Path, $"%{q}%"));

                var raw = await query
                    .OrderByDescending(r => r.Id)
                    .Take(Math.Clamp(take ?? 200, 1, 1000))
                    .Select(r => new
                    {
                        r.Id, r.WhenUtc, r.Method, r.Path, r.QueryString, r.StatusCode, r.DurationMs,
                        r.UserEmail, r.ClientIp, r.RequestBytes, r.ResponseBytes, r.RequestBody, r.ResponseBody,
                    })
                    .ToListAsync(ct);

                // Resolve each RAW request-user email -> {AppUser.Id, Name}; anonymous rows (null/empty
                // email) and emails with no AppUser stay {null, null}. The raw email is NEVER exposed
                // (email-privacy). db.Users.Email is stored lower-cased.
                var lowerEmails = raw.Select(r => r.UserEmail)
                    .Where(e => !string.IsNullOrEmpty(e)).Select(e => e!.ToLowerInvariant()).Distinct().ToList();
                var usersByEmail = (await db.Users.AsNoTracking()
                        .Where(u => lowerEmails.Contains(u.Email))
                        .Select(u => new { u.Id, u.Email, u.Name }).ToListAsync(ct))
                    .GroupBy(u => u.Email, StringComparer.OrdinalIgnoreCase)
                    .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

                var rows = raw.Select(r =>
                {
                    int? userId = null;
                    string? userName = null;
                    if (!string.IsNullOrEmpty(r.UserEmail) && usersByEmail.TryGetValue(r.UserEmail, out var u))
                    {
                        userId = u.Id;
                        userName = string.IsNullOrEmpty(u.Name) ? null : u.Name;
                    }
                    return new RequestLogDto
                    {
                        Id = r.Id,
                        WhenUtc = r.WhenUtc,
                        Method = r.Method,
                        Path = r.Path,
                        QueryString = r.QueryString,
                        StatusCode = r.StatusCode,
                        DurationMs = r.DurationMs,
                        UserId = userId,
                        UserName = userName,
                        ClientIp = r.ClientIp,
                        RequestBytes = r.RequestBytes,
                        ResponseBytes = r.ResponseBytes,
                        RequestBody = includeBodies ? r.RequestBody : null,
                        ResponseBody = includeBodies ? r.ResponseBody : null,
                    };
                }).ToList();

                return Results.Ok(rows);
            })
            .RequireAuthorization().RequirePermission(Permissions.ActivityView);

        // AI (Gemini) usage log. Admin-gated (ai.usage.view). Carries NO prompt/response content — only who
        // called which feature, the model, the outcome, and token counts. Mirrors GET /api/logs: a page of
        // rows (newest-first) by keyset (before=/limit), plus a summary block computed over the filtered
        // WINDOW (not just the page). Filters: user (AppUser id), feature, outcome, from/to (WhenUtc).
        app.MapGet("/api/ai-usage", async (
                UsageDbContext db, long? before, int? limit, int? user, string? feature, string? outcome,
                DateTime? from, DateTime? to, CancellationToken ct) =>
            {
                var take = Math.Clamp(limit ?? 100, 1, 500);

                // Build the shared WINDOW query (all filters EXCEPT keyset paging) — the summary aggregates
                // over this whole window; the rows take a single keyset page from it.
                var window = db.AiUsageLogs.AsNoTracking().AsQueryable();

                if (!string.IsNullOrWhiteSpace(feature))
                    window = window.Where(r => r.Feature == feature);
                if (!string.IsNullOrWhiteSpace(outcome))
                    window = window.Where(r => r.Outcome == outcome);
                if (from is { } f)
                    window = window.Where(r => r.WhenUtc >= DateTime.SpecifyKind(f, DateTimeKind.Utc));
                if (to is { } t)
                {
                    // A date-only 'to' (midnight) is intended as an INCLUSIVE calendar-day bound ("through
                    // that day"), so use an exclusive next-day upper bound to keep same-day rows. A 'to' with
                    // a time component is honoured as-is (still exclusive upper bound).
                    var toUtc = DateTime.SpecifyKind(t, DateTimeKind.Utc);
                    var upper = toUtc.TimeOfDay == TimeSpan.Zero ? toUtc.Date.AddDays(1) : toUtc;
                    window = window.Where(r => r.WhenUtc < upper);
                }

                // The user filter is an AppUser id (the raw email is never exposed or accepted). Resolve it to
                // the stored lower-cased email; an unknown id yields an empty window.
                if (user is { } uid)
                {
                    var email = await db.Users.AsNoTracking()
                        .Where(u => u.Id == uid).Select(u => u.Email).FirstOrDefaultAsync(ct);
                    window = email is null ? window.Where(_ => false) : window.Where(r => r.UserEmail == email);
                }

                // ---- Page of rows (keyset on Id, newest-first) ----
                var pageQuery = window;
                if (before is { } b)
                    pageQuery = pageQuery.Where(r => r.Id < b);

                var raw = await pageQuery
                    .OrderByDescending(r => r.Id)
                    .Take(take)
                    .Select(r => new
                    {
                        r.Id, r.WhenUtc, r.UserEmail, r.Feature, r.Model, r.Outcome, r.HttpStatus,
                        r.DurationMs, r.PromptTokens, r.OutputTokens, r.TotalTokens, r.ErrorHint,
                    })
                    .ToListAsync(ct);

                // ---- Summary over the whole window ----
                var totalCalls = await window.CountAsync(ct);
                var byOutcome = (await window
                        .GroupBy(r => r.Outcome)
                        .Select(g => new { Outcome = g.Key, Count = g.Count() })
                        .ToListAsync(ct))
                    .ToDictionary(x => x.Outcome, x => x.Count);

                var tokenTotals = await window
                    .GroupBy(_ => 1)
                    .Select(g => new
                    {
                        Prompt = g.Sum(r => (long?)r.PromptTokens) ?? 0,
                        Output = g.Sum(r => (long?)r.OutputTokens) ?? 0,
                        Total = g.Sum(r => (long?)r.TotalTokens) ?? 0,
                    })
                    .FirstOrDefaultAsync(ct);

                // ---- Estimated cost (computed ON READ; no stored cost column — pricing can change) ----
                // Reuse the core product's PricingMatcher + ModelPricing rates: exact > longest-prefix > '*'
                // fallback. A row is priced only when its model resolves to real (non-zero) rates AND it
                // reported tokens; otherwise its cost is null/"—" (never a misleading $0). Gemini logs no cache
                // split, so cache token args are 0 — cost = prompt×inputRate + output×outputRate (per million).
                var matcher = new PricingMatcher(
                    await db.ModelPricings.AsNoTracking().ToListAsync(ct));

                decimal? CostOf(string? model, int? prompt, int? output, int? total)
                {
                    if (string.IsNullOrEmpty(model) || total == null || matcher.IsUnpriced(model))
                        return null;
                    return matcher.Cost(model, prompt ?? 0, output ?? 0, 0, 0, 0);
                }

                // Window-wide total: sum the per-(model) token totals priced at that model's rates. Grouping by
                // model keeps this a single aggregate query rather than per-row. Unpriced models contribute null
                // (excluded from the sum) and flip HasUnpricedModels so the UI can footnote placeholder pricing.
                var costByModel = await window
                    .GroupBy(r => r.Model)
                    .Select(g => new
                    {
                        Model = g.Key,
                        Prompt = g.Sum(r => (long?)r.PromptTokens) ?? 0,
                        Output = g.Sum(r => (long?)r.OutputTokens) ?? 0,
                        HasTokens = g.Sum(r => (long?)r.TotalTokens) ?? 0,
                    })
                    .ToListAsync(ct);

                decimal? totalCostUsd = null;
                var hasUnpricedModels = false;
                foreach (var g in costByModel)
                {
                    if (string.IsNullOrEmpty(g.Model)) continue;
                    if (g.HasTokens == 0) continue; // models whose calls reported no tokens — nothing to price
                    if (matcher.IsUnpriced(g.Model)) { hasUnpricedModels = true; continue; }
                    totalCostUsd = (totalCostUsd ?? 0m)
                        + matcher.Cost(g.Model, g.Prompt, g.Output, 0, 0, 0);
                }

                var topFeatures = (await window
                        .GroupBy(r => r.Feature)
                        .Select(g => new { Key = g.Key, Count = g.Count(), Tokens = g.Sum(r => (long?)r.TotalTokens) ?? 0 })
                        .OrderByDescending(x => x.Count).Take(10).ToListAsync(ct))
                    .Select(x => new AiUsageCountDto { Key = x.Key, Count = x.Count, TotalTokens = x.Tokens })
                    .ToList();

                var topUserRaw = await window
                    .GroupBy(r => r.UserEmail)
                    .Select(g => new { Email = g.Key, Count = g.Count(), Tokens = g.Sum(r => (long?)r.TotalTokens) ?? 0 })
                    .OrderByDescending(x => x.Count).Take(10).ToListAsync(ct);

                // Resolve every email seen on the page OR among top users -> {AppUser.Id, Name}. The raw email
                // is NEVER exposed (email-privacy). Users.Email is stored lower-cased.
                var lowerEmails = raw.Select(r => r.UserEmail).Concat(topUserRaw.Select(u => u.Email))
                    .Where(e => !string.IsNullOrEmpty(e)).Select(e => e!.ToLowerInvariant()).Distinct().ToList();
                var usersByEmail = (await db.Users.AsNoTracking()
                        .Where(u => lowerEmails.Contains(u.Email))
                        .Select(u => new { u.Id, u.Email, u.Name }).ToListAsync(ct))
                    .GroupBy(u => u.Email, StringComparer.OrdinalIgnoreCase)
                    .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

                var rows = raw.Select(r =>
                {
                    int? userId = null;
                    string? userName = null;
                    if (!string.IsNullOrEmpty(r.UserEmail) && usersByEmail.TryGetValue(r.UserEmail, out var u))
                    {
                        userId = u.Id;
                        userName = string.IsNullOrEmpty(u.Name) ? null : u.Name;
                    }
                    return new AiUsageLogDto
                    {
                        Id = r.Id,
                        WhenUtc = r.WhenUtc,
                        UserId = userId,
                        UserName = userName,
                        Feature = r.Feature,
                        Model = r.Model,
                        Outcome = r.Outcome,
                        HttpStatus = r.HttpStatus,
                        DurationMs = r.DurationMs,
                        PromptTokens = r.PromptTokens,
                        OutputTokens = r.OutputTokens,
                        TotalTokens = r.TotalTokens,
                        EstimatedCostUsd = CostOf(r.Model, r.PromptTokens, r.OutputTokens, r.TotalTokens),
                        ErrorHint = r.ErrorHint,
                    };
                }).ToList();

                var topUsers = topUserRaw.Select(u =>
                {
                    int? userId = null;
                    var name = "(background)"; // null/empty email = a background tick
                    if (!string.IsNullOrEmpty(u.Email))
                    {
                        // Resolve the email to a display name; the raw email is NEVER assigned to `name`
                        // (and so never reaches the response) — matched → Name/"User {id}", else "(unknown)".
                        if (usersByEmail.TryGetValue(u.Email, out var au))
                        {
                            userId = au.Id;
                            name = string.IsNullOrEmpty(au.Name) ? $"User {au.Id}" : au.Name;
                        }
                        else
                        {
                            name = "(unknown)"; // an email with no AppUser — never leak the raw email
                        }
                    }
                    return new AiUsageCountDto { Key = name, UserId = userId, Count = u.Count, TotalTokens = u.Tokens };
                }).ToList();

                return Results.Ok(new AiUsageResponseDto
                {
                    Rows = rows,
                    Summary = new AiUsageSummaryDto
                    {
                        TotalCalls = totalCalls,
                        ByOutcome = byOutcome,
                        TotalPromptTokens = tokenTotals?.Prompt ?? 0,
                        TotalOutputTokens = tokenTotals?.Output ?? 0,
                        TotalTokens = tokenTotals?.Total ?? 0,
                        TotalEstimatedCostUsd = totalCostUsd,
                        HasUnpricedModels = hasUnpricedModels,
                        TopUsers = topUsers,
                        TopFeatures = topFeatures,
                    },
                });
            })
            .RequireAuthorization().RequirePermission(Permissions.AiUsageView);
    }
}
