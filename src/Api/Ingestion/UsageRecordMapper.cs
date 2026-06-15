using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Ingestion;

/// <summary>
/// Maps a source-neutral <see cref="ParsedUsage"/> into a persisted <see cref="UsageRecord"/>,
/// applying the display timezone (for <see cref="UsageRecord.LocalDate"/>) and pricing. Shared by
/// the local file sync (<see cref="JsonlIngestionService"/>) and the HTTP ingest endpoint so the two
/// paths can never drift in how a row is shaped or priced.
/// </summary>
public static class UsageRecordMapper
{
    public static UsageRecord Map(
        ParsedUsage pu, string source, string cwd, int projectId, int fileId,
        TimeZoneInfo tz, PricingMatcher pricing)
    {
        var tsUtc = DateTime.SpecifyKind(pu.TimestampUtc, DateTimeKind.Utc);
        return new UsageRecord
        {
            Source = source,
            MessageId = pu.DedupKey.Length > 128 ? pu.DedupKey[..128] : pu.DedupKey,
            RequestId = null,
            DedupKey = pu.DedupKey,
            TimestampUtc = tsUtc,
            LocalDate = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(tsUtc, tz)),
            Model = pu.Model,
            InputTokens = ToInt(pu.Input),
            OutputTokens = ToInt(pu.Output),
            CacheReadTokens = pu.CacheRead,
            CacheCreation5mTokens = ToInt(pu.Cache5m),
            CacheCreation1hTokens = ToInt(pu.Cache1h),
            SessionId = pu.SessionId,
            ProjectId = projectId,
            Cwd = cwd,
            GitBranch = pu.GitBranch,
            IsSidechain = pu.IsSidechain,
            AgentId = pu.AgentId,
            Version = pu.Version,
            CostUsd = ClampCost(pricing.Cost(pu.Model, pu.Input, pu.Output, pu.CacheRead, pu.Cache5m, pu.Cache1h)),
            IngestedFileId = fileId,
        };
    }

    private static int ToInt(long v) => (int)Math.Clamp(v, 0, int.MaxValue);

    // The CostUsd column is numeric(18,8). Keep the computed cost inside its representable range so a
    // pathological token count or extreme rate can never throw a numeric-overflow on save (the HTTP
    // ingest also clamps token inputs upstream; this is belt-and-suspenders shared by both paths).
    private const decimal MaxCost = 9_999_999_999.99999999m;
    private static decimal ClampCost(decimal c) => c < 0m ? 0m : (c > MaxCost ? MaxCost : c);
}
