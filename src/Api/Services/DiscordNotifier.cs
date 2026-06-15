using System.Net.Http.Json;
using Ccusage.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>Posts usage digests/snapshots/alerts to a Discord incoming webhook, and builds the summaries.</summary>
public sealed class DiscordNotifier(IHttpClientFactory httpFactory, UsageDbContext db, ILogger<DiscordNotifier> logger)
{
    // Only ever POST to a genuine Discord webhook — this also closes off SSRF to internal hosts.
    private static readonly HashSet<string> AllowedHosts =
        new(StringComparer.OrdinalIgnoreCase) { "discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com" };

    private const int Blue = 0x3D8BFF;
    private const int Amber = 0xF2B340;

    public record Summary(decimal Cost, long Tokens, int Messages, string? TopProject);
    public record Breakdown(string Name, decimal Cost);
    public record Digest(decimal Cost, long Tokens, int Messages, decimal? PrevCost,
        IReadOnlyList<Breakdown> TopProjects, IReadOnlyList<Breakdown> TopModels);

    /// <summary>True only for an https Discord webhook URL (<c>https://discord.com/api/webhooks/…</c>).</summary>
    public static bool IsValidWebhook(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u)
        && u.Scheme == Uri.UriSchemeHttps
        && AllowedHosts.Contains(u.Host)
        && u.AbsolutePath.StartsWith("/api/webhooks/", StringComparison.OrdinalIgnoreCase);

    public Task<bool> SendTestAsync(string url, CancellationToken ct) =>
        PostAsync(url, "✅ Usage IQ connected", "Test message — your Discord webhook is wired up correctly.",
            Blue, Array.Empty<(string, string, bool)>(), ct);

    public Task<bool> SendDigestAsync(string url, string title, Digest d, CancellationToken ct)
    {
        var fields = new List<(string, string, bool)>
        {
            ("Cost", $"${d.Cost:N2}{Trend(d.Cost, d.PrevCost)}", true),
            ("Tokens", Human(d.Tokens), true),
            ("Messages", $"{d.Messages:N0}", true),
        };
        if (d.TopProjects.Count > 0) fields.Add(("Top projects", BreakdownText(d.TopProjects), true));
        if (d.TopModels.Count > 0) fields.Add(("Top models", BreakdownText(d.TopModels), true));
        return PostAsync(url, title, null, Blue, fields.ToArray(), ct);
    }

    public async Task<bool> SendSnapshotAsync(string url, DateOnly today, CancellationToken ct)
    {
        var todayS = await SummarizeAsync(today, today, ct);
        var weekS = await SummarizeAsync(today.AddDays(-6), today, ct);
        var monthS = await SummarizeAsync(new DateOnly(today.Year, today.Month, 1), today, ct);
        var allCost = await db.UsageRecords.AsNoTracking().SumAsync(r => (decimal?)r.CostUsd, ct) ?? 0m;
        var allMsgs = await db.UsageRecords.AsNoTracking().CountAsync(ct);

        return await PostAsync(url, $"📊 Usage snapshot — {today:MMM d, yyyy}", null, Blue, new[]
        {
            ("Today", $"${todayS.Cost:N2} · {todayS.Messages:N0} msgs", true),
            ("Last 7 days", $"${weekS.Cost:N2} · {weekS.Messages:N0} msgs", true),
            ("This month", $"${monthS.Cost:N2} · {monthS.Messages:N0} msgs", true),
            ("All time", $"${allCost:N2} · {allMsgs:N0} msgs", false),
            ("Top project today", todayS.TopProject ?? "—", false),
        }, ct);
    }

    public Task<bool> SendThresholdAsync(
        string url, DateOnly day, decimal spend, decimal threshold, string? mention, CancellationToken ct) =>
        PostAsync(url, "⚠️ Daily spend threshold reached", null, Amber, new[]
        {
            ("Date", day.ToString("MMM d"), true),
            ("Spend today", $"${spend:N2}", true),
            ("Threshold", $"${threshold:N2}", true),
        }, ct, content: mention, allowMentions: !string.IsNullOrWhiteSpace(mention));

    public Task<bool> SendSecurityAsync(
        string url, string action, string actor, string? target, string? detail, string? mention, CancellationToken ct)
    {
        var fields = new List<(string, string, bool)> { ("Action", action, true), ("By", actor, true) };
        if (!string.IsNullOrEmpty(target)) fields.Add(("Target", target!, true));
        if (!string.IsNullOrEmpty(detail)) fields.Add(("Detail", Trunc(detail!, 1000), false));
        return PostAsync(url, "🔐 Security event", null, Amber, fields.ToArray(), ct,
            content: mention, allowMentions: !string.IsNullOrWhiteSpace(mention));
    }

    private async Task<bool> PostAsync(
        string url, string title, string? description, int color,
        (string Name, string Value, bool Inline)[] fields, CancellationToken ct,
        string? content = null, bool allowMentions = false)
    {
        if (!IsValidWebhook(url))
        {
            logger.LogWarning("Refusing to post to a non-Discord webhook URL.");
            return false;
        }

        var payload = new
        {
            username = "Usage IQ",
            content = string.IsNullOrWhiteSpace(content) ? null : content,
            // Only ping when an admin explicitly configured a mention; otherwise suppress ALL pings so a
            // project/model name that happens to contain "@everyone" can never trigger a notification.
            allowed_mentions = allowMentions
                ? new { parse = new[] { "everyone", "roles" } }
                : new { parse = Array.Empty<string>() },
            embeds = new[]
            {
                new
                {
                    title,
                    description,
                    color,
                    fields = fields.Select(f => new { name = f.Name, value = f.Value, inline = f.Inline }).ToArray(),
                    footer = new { text = "Usage IQ" },
                },
            },
        };

        try
        {
            var client = httpFactory.CreateClient("discord"); // redirects disabled (see Program.cs)
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));
            var res = await client.PostAsJsonAsync(url, payload, cts.Token);

            // Defense in depth: if a redirect ever slipped through, the request must still have ended on Discord.
            var finalHost = res.RequestMessage?.RequestUri?.Host;
            if (finalHost is not null && !AllowedHosts.Contains(finalHost))
            {
                logger.LogWarning("Discord request ended on an unexpected host; ignoring response.");
                return false;
            }

            if (!res.IsSuccessStatusCode)
                logger.LogWarning("Discord webhook returned {Status}.", (int)res.StatusCode);
            return res.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to post to Discord webhook.");
            return false;
        }
    }

    /// <summary>Aggregate spend/volume/top-project over a local-date range [from, to] inclusive.</summary>
    public async Task<Summary> SummarizeAsync(DateOnly from, DateOnly to, CancellationToken ct)
    {
        var q = db.UsageRecords.AsNoTracking().Where(r => r.LocalDate >= from && r.LocalDate <= to);
        var agg = await q.GroupBy(_ => 1).Select(g => new
        {
            Cost = g.Sum(x => x.CostUsd),
            Input = g.Sum(x => (long)x.InputTokens),
            Output = g.Sum(x => (long)x.OutputTokens),
            Read = g.Sum(x => x.CacheReadTokens),
            W5 = g.Sum(x => (long)x.CacheCreation5mTokens),
            W1 = g.Sum(x => (long)x.CacheCreation1hTokens),
            Messages = g.Count(),
        }).FirstOrDefaultAsync(ct);

        if (agg is null) return new Summary(0, 0, 0, null);

        var top = await q.GroupBy(r => r.Project!.Name)
            .Select(g => new { g.Key, Cost = g.Sum(x => x.CostUsd) })
            .OrderByDescending(x => x.Cost).FirstOrDefaultAsync(ct);

        return new Summary(agg.Cost, agg.Input + agg.Output + agg.Read + agg.W5 + agg.W1, agg.Messages,
            top is null ? null : $"{top.Key} (${top.Cost:N2})");
    }

    /// <summary>Build a rich digest for [from, to] with a cost trend vs [prevFrom, prevTo] and top-3 breakdowns.</summary>
    public async Task<Digest> BuildDigestAsync(DateOnly from, DateOnly to, DateOnly? prevFrom, DateOnly? prevTo, CancellationToken ct)
    {
        var s = await SummarizeAsync(from, to, ct);

        decimal? prevCost = null;
        if (prevFrom is { } pf && prevTo is { } pt)
            prevCost = await db.UsageRecords.AsNoTracking()
                .Where(r => r.LocalDate >= pf && r.LocalDate <= pt).SumAsync(r => (decimal?)r.CostUsd, ct) ?? 0m;

        var q = db.UsageRecords.AsNoTracking().Where(r => r.LocalDate >= from && r.LocalDate <= to);
        var tp = await q.GroupBy(r => r.Project!.Name).Select(g => new { g.Key, Cost = g.Sum(x => x.CostUsd) })
            .OrderByDescending(x => x.Cost).Take(3).ToListAsync(ct);
        var tm = await q.GroupBy(r => r.Model).Select(g => new { g.Key, Cost = g.Sum(x => x.CostUsd) })
            .OrderByDescending(x => x.Cost).Take(3).ToListAsync(ct);

        return new Digest(s.Cost, s.Tokens, s.Messages, prevCost,
            tp.Select(x => new Breakdown(x.Key, x.Cost)).ToList(),
            tm.Select(x => new Breakdown(x.Key, x.Cost)).ToList());
    }

    private static string Trend(decimal cur, decimal? prev)
    {
        if (prev is not { } p || p <= 0) return "";
        var pct = (double)((cur - p) / p) * 100;
        return $"\n{(pct >= 0 ? "▲" : "▼")} {Math.Abs(pct):N0}% vs prev";
    }

    private static string BreakdownText(IReadOnlyList<Breakdown> items) =>
        string.Join("\n", items.Select(b => $"{Trunc(b.Name, 40)} · ${b.Cost:N2}"));

    private static string Trunc(string s, int max) => s.Length <= max ? s : s[..max] + "…";

    private static string Human(long n) => n switch
    {
        >= 1_000_000_000 => $"{n / 1_000_000_000.0:N1}B",
        >= 1_000_000 => $"{n / 1_000_000.0:N1}M",
        >= 1_000 => $"{n / 1_000.0:N1}K",
        _ => n.ToString(),
    };
}
