using Ccusage.Api.Data;
using Ccusage.Api.Data.Entities;
using Ccusage.Api.Dtos;
using Ccusage.Api.Ingestion;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>Read-side queries: filtered aggregates, paged records, and filter options.</summary>
public sealed class UsageQueries(UsageDbContext db)
{
    private IQueryable<UsageRecord> Filtered(UsageFilterQuery f)
    {
        var q = db.UsageRecords.AsNoTracking();
        if (f.from is { } from) q = q.Where(r => r.LocalDate >= from);
        if (f.to is { } to) q = q.Where(r => r.LocalDate <= to);
        if (f.projectId is { Length: > 0 } pids) q = q.Where(r => pids.Contains(r.ProjectId));
        if (f.model is { Length: > 0 } models) q = q.Where(r => models.Contains(r.Model));
        if (f.source is { Length: > 0 } sources) q = q.Where(r => sources.Contains(r.Source));
        if (f.includeSidechain == false) q = q.Where(r => !r.IsSidechain);
        return q;
    }

    /// <summary>
    /// Per-day spend/volume plus an estimate of active engagement time. "Active minutes" sums the
    /// gaps between consecutive messages on a day, ignoring any gap longer than <paramref name="idleGapMinutes"/>
    /// (treated as idle); a gap over the threshold also starts a new session.
    /// </summary>
    public async Task<List<CalendarDayDto>> CalendarAsync(UsageFilterQuery f, int idleGapMinutes, CancellationToken ct)
    {
        var q = Filtered(f);

        var agg = await q.GroupBy(r => r.LocalDate).Select(g => new
        {
            Date = g.Key,
            Cost = g.Sum(x => x.CostUsd),
            Tokens = g.Sum(x => (long)x.InputTokens + x.OutputTokens + x.CacheReadTokens
                                 + x.CacheCreation5mTokens + x.CacheCreation1hTokens),
            Messages = g.Count(),
        }).ToListAsync(ct);

        // Pull just the timestamps (two columns) to compute active time + sessions per day.
        var stamps = await q.Select(r => new { r.LocalDate, r.TimestampUtc }).ToListAsync(ct);
        var gap = TimeSpan.FromMinutes(idleGapMinutes);

        var byDay = stamps.GroupBy(s => s.LocalDate).ToDictionary(g => g.Key, g =>
        {
            var times = g.Select(x => x.TimestampUtc).OrderBy(t => t).ToList();
            double minutes = 0;
            var sessions = times.Count > 0 ? 1 : 0;
            for (var i = 1; i < times.Count; i++)
            {
                var d = times[i] - times[i - 1];
                if (d <= gap) minutes += d.TotalMinutes;
                else sessions++;
            }
            return (Minutes: minutes, Sessions: sessions, First: times[0], Last: times[^1]);
        });

        return agg.Select(a =>
        {
            byDay.TryGetValue(a.Date, out var v);
            return new CalendarDayDto
            {
                Date = a.Date.ToString("yyyy-MM-dd"),
                CostUsd = a.Cost,
                Tokens = a.Tokens,
                Messages = a.Messages,
                Sessions = v.Sessions,
                ActiveMinutes = (int)Math.Round(v.Minutes),
                FirstUtc = v.First == default ? null : v.First,
                LastUtc = v.Last == default ? null : v.Last,
            };
        }).OrderBy(d => d.Date).ToList();
    }

    private sealed record Agg(string Key, long Input, long Output, long Read, long W5, long W1, decimal Cost, int Count);

    private static SummaryBucket ToBucket(Agg a) => new()
    {
        Key = a.Key,
        InputTokens = a.Input, OutputTokens = a.Output, CacheReadTokens = a.Read,
        CacheCreation5mTokens = a.W5, CacheCreation1hTokens = a.W1,
        CostUsd = a.Cost, Records = a.Count,
    };

    public async Task<SummaryResponse> SummaryAsync(UsageFilterQuery f, string groupBy, CancellationToken ct)
    {
        var q = Filtered(f);
        groupBy = (groupBy ?? "day").ToLowerInvariant();

        List<SummaryBucket> buckets;
        switch (groupBy)
        {
            case "day":
            case "month":
            {
                var byDay = await q.GroupBy(r => r.LocalDate).Select(g => new Agg(
                    g.Key.ToString(),
                    g.Sum(x => (long)x.InputTokens), g.Sum(x => (long)x.OutputTokens),
                    g.Sum(x => x.CacheReadTokens),
                    g.Sum(x => (long)x.CacheCreation5mTokens), g.Sum(x => (long)x.CacheCreation1hTokens),
                    g.Sum(x => x.CostUsd), g.Count())).ToListAsync(ct);

                if (groupBy == "day")
                {
                    buckets = byDay.Select(a => ToBucket(a with { Key = DateOnly.Parse(a.Key).ToString("yyyy-MM-dd") }))
                        .OrderBy(b => b.Key).ToList();
                }
                else
                {
                    buckets = byDay
                        .GroupBy(a => DateOnly.Parse(a.Key).ToString("yyyy-MM"))
                        .Select(g => new SummaryBucket
                        {
                            Key = g.Key,
                            InputTokens = g.Sum(x => x.Input), OutputTokens = g.Sum(x => x.Output),
                            CacheReadTokens = g.Sum(x => x.Read),
                            CacheCreation5mTokens = g.Sum(x => x.W5), CacheCreation1hTokens = g.Sum(x => x.W1),
                            CostUsd = g.Sum(x => x.Cost), Records = g.Sum(x => x.Count),
                        })
                        .OrderBy(b => b.Key).ToList();
                }
                break;
            }
            case "project":
            {
                var rows = await q.GroupBy(r => r.Project!.Name).Select(g => new Agg(
                    g.Key,
                    g.Sum(x => (long)x.InputTokens), g.Sum(x => (long)x.OutputTokens),
                    g.Sum(x => x.CacheReadTokens),
                    g.Sum(x => (long)x.CacheCreation5mTokens), g.Sum(x => (long)x.CacheCreation1hTokens),
                    g.Sum(x => x.CostUsd), g.Count())).ToListAsync(ct);
                buckets = rows.Select(ToBucket).OrderByDescending(b => b.CostUsd).ToList();
                break;
            }
            case "source":
            {
                var rows = await q.GroupBy(r => r.Source).Select(g => new Agg(
                    g.Key,
                    g.Sum(x => (long)x.InputTokens), g.Sum(x => (long)x.OutputTokens),
                    g.Sum(x => x.CacheReadTokens),
                    g.Sum(x => (long)x.CacheCreation5mTokens), g.Sum(x => (long)x.CacheCreation1hTokens),
                    g.Sum(x => x.CostUsd), g.Count())).ToListAsync(ct);
                buckets = rows.Select(ToBucket).OrderByDescending(b => b.CostUsd).ToList();
                break;
            }
            case "session":
            {
                var rows = await q.GroupBy(r => r.SessionId).Select(g => new Agg(
                    g.Key,
                    g.Sum(x => (long)x.InputTokens), g.Sum(x => (long)x.OutputTokens),
                    g.Sum(x => x.CacheReadTokens),
                    g.Sum(x => (long)x.CacheCreation5mTokens), g.Sum(x => (long)x.CacheCreation1hTokens),
                    g.Sum(x => x.CostUsd), g.Count())).ToListAsync(ct);
                buckets = rows.Select(ToBucket).OrderByDescending(b => b.CostUsd).ToList();
                break;
            }
            default: // "model"
            {
                var rows = await q.GroupBy(r => r.Model).Select(g => new Agg(
                    g.Key,
                    g.Sum(x => (long)x.InputTokens), g.Sum(x => (long)x.OutputTokens),
                    g.Sum(x => x.CacheReadTokens),
                    g.Sum(x => (long)x.CacheCreation5mTokens), g.Sum(x => (long)x.CacheCreation1hTokens),
                    g.Sum(x => x.CostUsd), g.Count())).ToListAsync(ct);
                buckets = rows.Select(ToBucket).OrderByDescending(b => b.CostUsd).ToList();
                groupBy = "model";
                break;
            }
        }

        var total = new TokenTotals
        {
            InputTokens = buckets.Sum(b => b.InputTokens),
            OutputTokens = buckets.Sum(b => b.OutputTokens),
            CacheReadTokens = buckets.Sum(b => b.CacheReadTokens),
            CacheCreation5mTokens = buckets.Sum(b => b.CacheCreation5mTokens),
            CacheCreation1hTokens = buckets.Sum(b => b.CacheCreation1hTokens),
            CostUsd = buckets.Sum(b => b.CostUsd),
            Records = buckets.Sum(b => b.Records),
        };

        return new SummaryResponse { GroupBy = groupBy, Buckets = buckets, Total = total };
    }

    public async Task<PagedResult<UsageRecordDto>> RecordsAsync(
        UsageFilterQuery f, int page, int pageSize, string sort, bool desc, CancellationToken ct)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 500);
        var q = Filtered(f);

        q = (sort?.ToLowerInvariant(), desc) switch
        {
            ("cost", true) => q.OrderByDescending(r => r.CostUsd),
            ("cost", false) => q.OrderBy(r => r.CostUsd),
            ("input", true) => q.OrderByDescending(r => r.InputTokens),
            ("input", false) => q.OrderBy(r => r.InputTokens),
            ("output", true) => q.OrderByDescending(r => r.OutputTokens),
            ("output", false) => q.OrderBy(r => r.OutputTokens),
            ("model", true) => q.OrderByDescending(r => r.Model),
            ("model", false) => q.OrderBy(r => r.Model),
            (_, false) => q.OrderBy(r => r.TimestampUtc),
            _ => q.OrderByDescending(r => r.TimestampUtc),
        };

        var total = await q.LongCountAsync(ct);
        var items = await q.Skip((page - 1) * pageSize).Take(pageSize)
            .Select(r => new UsageRecordDto
            {
                Id = r.Id,
                Source = r.Source,
                TimestampUtc = r.TimestampUtc,
                LocalDate = r.LocalDate,
                Model = r.Model,
                InputTokens = r.InputTokens,
                OutputTokens = r.OutputTokens,
                CacheReadTokens = r.CacheReadTokens,
                CacheCreation5mTokens = r.CacheCreation5mTokens,
                CacheCreation1hTokens = r.CacheCreation1hTokens,
                TotalTokens = r.InputTokens + r.OutputTokens + r.CacheReadTokens + r.CacheCreation5mTokens + r.CacheCreation1hTokens,
                CostUsd = r.CostUsd,
                ProjectName = r.Project!.Name,
                SessionId = r.SessionId,
                GitBranch = r.GitBranch,
                IsSidechain = r.IsSidechain,
            }).ToListAsync(ct);

        return new PagedResult<UsageRecordDto> { Items = items, Total = total, Page = page, PageSize = pageSize };
    }

    /// <summary>Streams the filtered records as CSV (ordered oldest-first) without buffering them all.</summary>
    public async Task WriteRecordsCsvAsync(UsageFilterQuery f, Stream output, CancellationToken ct)
    {
        await using var w = new StreamWriter(output, leaveOpen: true);
        await w.WriteLineAsync("date,source,model,project,type,input,output,cache_read,cache_5m,cache_1h,total,cost_usd");

        var rows = Filtered(f).OrderBy(r => r.TimestampUtc).Select(r => new
        {
            r.LocalDate, r.Source, r.Model, Project = r.Project!.Name, r.IsSidechain,
            r.InputTokens, r.OutputTokens, r.CacheReadTokens, r.CacheCreation5mTokens, r.CacheCreation1hTokens, r.CostUsd,
        }).AsAsyncEnumerable();

        await foreach (var r in rows.WithCancellation(ct))
        {
            var total = (long)r.InputTokens + r.OutputTokens + r.CacheReadTokens + r.CacheCreation5mTokens + r.CacheCreation1hTokens;
            await w.WriteLineAsync(string.Join(',',
                r.LocalDate.ToString("yyyy-MM-dd"), Csv(r.Source), Csv(r.Model), Csv(r.Project),
                r.IsSidechain ? "subagent" : "main",
                r.InputTokens, r.OutputTokens, r.CacheReadTokens, r.CacheCreation5mTokens, r.CacheCreation1hTokens,
                total, r.CostUsd.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }
        await w.FlushAsync(ct);
    }

    private static string Csv(string s) =>
        s.Contains(',') || s.Contains('"') || s.Contains('\n') ? "\"" + s.Replace("\"", "\"\"") + "\"" : s;

    public async Task<List<ProjectDto>> ProjectsAsync(CancellationToken ct) =>
        await db.UsageRecords.AsNoTracking()
            .GroupBy(r => new { r.ProjectId, r.Project!.Name, r.Project.RepoRoot })
            .Select(g => new ProjectDto
            {
                Id = g.Key.ProjectId,
                Name = g.Key.Name,
                RepoRoot = g.Key.RepoRoot,
                Records = g.Count(),
                CostUsd = g.Sum(x => x.CostUsd),
            })
            .OrderByDescending(p => p.CostUsd).ToListAsync(ct);

    public async Task<List<ModelStatDto>> ModelsAsync(CancellationToken ct)
    {
        var pricing = new PricingMatcher(await db.ModelPricings.AsNoTracking().ToListAsync(ct));
        var rows = await db.UsageRecords.AsNoTracking()
            .GroupBy(r => r.Model)
            .Select(g => new
            {
                Model = g.Key,
                Records = g.Count(),
                Input = g.Sum(x => (long)x.InputTokens),
                Output = g.Sum(x => (long)x.OutputTokens),
                Read = g.Sum(x => x.CacheReadTokens),
                W5 = g.Sum(x => (long)x.CacheCreation5mTokens),
                W1 = g.Sum(x => (long)x.CacheCreation1hTokens),
                Cost = g.Sum(x => x.CostUsd),
            }).ToListAsync(ct);

        return rows.Select(r => new ModelStatDto
        {
            Model = r.Model,
            Records = r.Records,
            TotalTokens = r.Input + r.Output + r.Read + r.W5 + r.W1,
            CostUsd = r.Cost,
            IsPlaceholderPricing = pricing.Resolve(r.Model).IsPlaceholder,
        }).OrderByDescending(m => m.CostUsd).ToList();
    }
}
