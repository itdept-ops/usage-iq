using System.Net.Http.Json;
using Ccusage.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>Posts richly-formatted usage digests/snapshots/alerts to a Discord incoming webhook.</summary>
public sealed class DiscordNotifier(IHttpClientFactory httpFactory, UsageDbContext db, ILogger<DiscordNotifier> logger)
{
    // Only ever POST to a genuine Discord webhook — this also closes off SSRF to internal hosts.
    private static readonly HashSet<string> AllowedHosts =
        new(StringComparer.OrdinalIgnoreCase) { "discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com" };

    // Served from the public repo so Discord can always fetch it, even for a private/local instance.
    private const string Icon = "https://raw.githubusercontent.com/itdept-ops/usage-iq/main/docs/usage-iq-icon.png";

    private const string Spacer = "​"; // zero-width space — a non-empty but invisible embed field
    private const int Blue = 0x3D8BFF;
    private const int Amber = 0xF2B340;
    private const int Green = 0x3DD68C;
    private const int Red = 0xFF5C6C;

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
        PostAsync(url, "Connection test", "✅ Connected",
            "Your Discord webhook is wired up correctly — digests and alerts will land right here.",
            Green, NoFields, ct);

    public Task<bool> SendDigestAsync(string url, string kind, string period, Digest d, CancellationToken ct) =>
        PostAsync(url, $"{kind} usage digest", period,
            $"**${d.Cost:N2}** spent{TrendSuffix(d.Cost, d.PrevCost)}", Blue, new[]
            {
                ("🔤 Tokens", Human(d.Tokens), true),
                ("💬 Messages", $"{d.Messages:N0}", true),
                (Spacer, Spacer, true), // zero-width spacer → pushes the two breakdowns onto their own row
                ("📂 Top projects", BreakdownText(d.TopProjects), true),
                ("🧠 Top models", BreakdownText(d.TopModels), true),
            }, ct);

    public async Task<bool> SendSnapshotAsync(string url, DateOnly today, CancellationToken ct)
    {
        var todayS = await SummarizeAsync(today, today, ct);
        var weekS = await SummarizeAsync(today.AddDays(-6), today, ct);
        var monthS = await SummarizeAsync(new DateOnly(today.Year, today.Month, 1), today, ct);
        var allCost = await db.UsageRecords.AsNoTracking().SumAsync(r => (decimal?)r.CostUsd, ct) ?? 0m;
        var allMsgs = await db.UsageRecords.AsNoTracking().CountAsync(ct);

        return await PostAsync(url, "Usage snapshot", today.ToString("MMMM d, yyyy"),
            $"**${allCost:N2}** all-time across {allMsgs:N0} messages", Blue, new[]
            {
                ("📅 Today", $"**${todayS.Cost:N2}** · {todayS.Messages:N0} msgs", true),
                ("🗓️ Last 7 days", $"**${weekS.Cost:N2}** · {weekS.Messages:N0} msgs", true),
                ("📆 This month", $"**${monthS.Cost:N2}** · {monthS.Messages:N0} msgs", true),
                ("🏆 Top project today", todayS.TopProject ?? "—", false),
            }, ct);
    }

    public Task<bool> SendThresholdAsync(
        string url, DateOnly day, decimal spend, decimal threshold, string? mention, CancellationToken ct) =>
        PostAsync(url, "Spend alert", "⚠️ Daily threshold reached",
            $"Spend on **{day:MMM d}** has reached **${spend:N2}**, past your **${threshold:N2}** alert.", Amber, new[]
            {
                ("💵 Spend today", $"${spend:N2}", true),
                ("🎯 Threshold", $"${threshold:N2}", true),
            }, ct, content: mention, allowMentions: !string.IsNullOrWhiteSpace(mention));

    public Task<bool> SendSecurityAsync(
        string url, string action, string actor, string? target, string? detail, string? mention, CancellationToken ct)
    {
        var fields = new List<(string, string, bool)> { ("⚙️ Action", $"`{action}`", true), ("👤 By", actor, true) };
        if (!string.IsNullOrEmpty(target)) fields.Add(("🎯 Target", target!, true));
        if (!string.IsNullOrEmpty(detail)) fields.Add(("📝 Detail", Trunc(detail!, 1000), false));

        return PostAsync(url, "Security event", "🔐 Access activity", null, Red, fields.ToArray(), ct,
            content: mention, allowMentions: !string.IsNullOrWhiteSpace(mention));
    }

    /// <summary>
    /// Forward a single per-user in-app notification to that user's personal Discord webhook as a spruced
    /// embed (kind-colored, author = the actor, the notification text as the description, a deep-link, and
    /// the Usage IQ footer). Never pings (per-user forwards carry no @here/@role). Returns the post outcome
    /// AND the HTTP status / retry-after so the caller's rate-limiter can respect a Discord 429.
    /// </summary>
    public Task<DiscordPostResult> ForwardUserNotificationAsync(
        string url, string kind, string? actorName, string text, string? deepLink, CancellationToken ct)
    {
        var color = kind switch
        {
            "mention" => Amber,
            "directMessage" => Blue,
            "systemSyncFailed" or "systemFleetOffline" => Red,
            _ when kind.StartsWith("system", StringComparison.Ordinal) => Green,
            _ when kind.StartsWith("family", StringComparison.Ordinal) => Green,
            _ => Blue,
        };
        var author = string.IsNullOrWhiteSpace(actorName) ? "Usage IQ" : actorName!;
        var title = KindTitle(kind);
        var description = Trunc(text, 2000);
        var fields = string.IsNullOrWhiteSpace(deepLink)
            ? NoFields
            : new[] { ("🔗 Open", $"[View in Usage IQ]({PublicLink(deepLink!)})", false) };

        return PostWithResultAsync(url, author, title, description, color, fields, ct);
    }

    private static string KindTitle(string kind) => kind switch
    {
        "mention" => "💬 You were mentioned",
        "directMessage" => "✉️ New direct message",
        "channelMessage" => "💬 New message",
        "systemSyncFailed" => "⚠️ Sync failed",
        "systemUserJoined" => "👋 New member",
        "systemFleetOffline" => "🛰️ Fleet offline",
        "familyReminder" => "⏰ Reminder",
        "familyTimer" => "⏲️ Timer finished",
        "familyBriefing" => "🌅 Daily briefing",
        "familyHeadsUp" => "📣 Heads up",
        _ => "🔔 Notification",
    };

    // The deep-link the in-app notification carries is an app-relative path (e.g. "/chat?c=1&m=2").
    // The forwarder turns it into the public absolute URL for the Discord button.
    private const string PublicBase = "https://usageiq.online";
    private static string PublicLink(string relative) =>
        relative.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? relative
            : PublicBase + (relative.StartsWith('/') ? relative : "/" + relative);

    private static readonly (string, string, bool)[] NoFields = Array.Empty<(string, string, bool)>();

    /// <summary>The outcome of a single Discord post: success + the HTTP status and any 429 retry-after,
    /// so a caller's rate-limiter can back off. <see cref="RetryAfter"/> is null unless Discord 429'd.</summary>
    public readonly record struct DiscordPostResult(bool Ok, int? Status, TimeSpan? RetryAfter)
    {
        public bool IsRateLimited => Status == 429;
    }

    private async Task<bool> PostAsync(
        string url, string author, string? title, string? description, int color,
        (string Name, string Value, bool Inline)[] fields, CancellationToken ct,
        string? content = null, bool allowMentions = false)
        => (await PostWithResultAsync(url, author, title, description, color, fields, ct, content, allowMentions)).Ok;

    private async Task<DiscordPostResult> PostWithResultAsync(
        string url, string author, string? title, string? description, int color,
        (string Name, string Value, bool Inline)[] fields, CancellationToken ct,
        string? content = null, bool allowMentions = false)
    {
        if (!IsValidWebhook(url))
        {
            logger.LogWarning("Refusing to post to a non-Discord webhook URL.");
            return new DiscordPostResult(false, null, null);
        }

        var payload = new
        {
            username = "Usage IQ",
            avatar_url = Icon,
            content = string.IsNullOrWhiteSpace(content) ? null : content,
            // Only ping when an admin explicitly configured a mention; otherwise suppress ALL pings.
            allowed_mentions = allowMentions
                ? new { parse = new[] { "everyone", "roles" } }
                : new { parse = Array.Empty<string>() },
            embeds = new[]
            {
                new
                {
                    author = new { name = author, icon_url = Icon },
                    title,
                    description,
                    color,
                    fields = fields.Select(f => new { name = f.Name, value = f.Value, inline = f.Inline }).ToArray(),
                    footer = new { text = "Usage IQ", icon_url = Icon },
                    timestamp = DateTime.UtcNow.ToString("o"),
                },
            },
        };

        try
        {
            var client = httpFactory.CreateClient("discord"); // redirects disabled (see Program.cs)
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(10));
            var res = await client.PostAsJsonAsync(url, payload, cts.Token);

            var finalHost = res.RequestMessage?.RequestUri?.Host;
            if (finalHost is not null && !AllowedHosts.Contains(finalHost))
            {
                logger.LogWarning("Discord request ended on an unexpected host; ignoring response.");
                return new DiscordPostResult(false, null, null);
            }

            TimeSpan? retryAfter = null;
            if ((int)res.StatusCode == 429)
                retryAfter = res.Headers.RetryAfter?.Delta
                    ?? (double.TryParse(res.Headers.RetryAfter?.ToString(), out var secs) ? TimeSpan.FromSeconds(secs) : null);

            if (!res.IsSuccessStatusCode)
                logger.LogWarning("Discord webhook returned {Status}.", (int)res.StatusCode);
            return new DiscordPostResult(res.IsSuccessStatusCode, (int)res.StatusCode, retryAfter);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to post to Discord webhook.");
            return new DiscordPostResult(false, null, null);
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

    private static string TrendSuffix(decimal cur, decimal? prev)
    {
        if (prev is not { } p || p <= 0) return "";
        var pct = (double)((cur - p) / p) * 100;
        return $"  ·  {(pct >= 0 ? "📈" : "📉")} {(pct >= 0 ? "+" : "")}{pct:N0}% vs previous";
    }

    private static string BreakdownText(IReadOnlyList<Breakdown> items) =>
        items.Count == 0 ? "—" : string.Join("\n", items.Select((b, i) => $"`{i + 1}.` {Trunc(b.Name, 28)} · **${b.Cost:N2}**"));

    private static string Trunc(string s, int max) => s.Length <= max ? s : s[..max] + "…";

    private static string Human(long n) => n switch
    {
        >= 1_000_000_000 => $"{n / 1_000_000_000.0:N1}B",
        >= 1_000_000 => $"{n / 1_000_000.0:N1}M",
        >= 1_000 => $"{n / 1_000.0:N1}K",
        _ => n.ToString(),
    };
}
