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
        if (f.includeSidechain == false) q = q.Where(r => !r.IsSidechain);
        return q;
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
