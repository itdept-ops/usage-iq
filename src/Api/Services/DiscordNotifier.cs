using System.Net.Http.Json;
using Ccusage.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Ccusage.Api.Services;

/// <summary>Posts usage digests/alerts to a Discord incoming webhook, and builds the summaries.</summary>
public sealed class DiscordNotifier(IHttpClientFactory httpFactory, UsageDbContext db, ILogger<DiscordNotifier> logger)
{
    // Only ever POST to a genuine Discord webhook — this also closes off SSRF to internal hosts.
    private static readonly HashSet<string> AllowedHosts =
        new(StringComparer.OrdinalIgnoreCase) { "discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com" };

    private const int Blue = 0x3D8BFF;
    private const int Amber = 0xF2B340;

    public record Summary(decimal Cost, long Tokens, int Messages, string? TopProject);

    /// <summary>True only for an https Discord webhook URL (<c>https://discord.com/api/webhooks/…</c>).</summary>
    public static bool IsValidWebhook(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u)
        && u.Scheme == Uri.UriSchemeHttps
        && AllowedHosts.Contains(u.Host)
        && u.AbsolutePath.StartsWith("/api/webhooks/", StringComparison.OrdinalIgnoreCase);

    public Task<bool> SendTestAsync(string url, CancellationToken ct) =>
        PostAsync(url, "✅ Usage IQ connected", "Test message — your Discord webhook is wired up correctly.",
            Blue, Array.Empty<(string, string, bool)>(), ct);

    public Task<bool> SendDigestAsync(string url, string title, Summary s, CancellationToken ct) =>
        PostAsync(url, title, null, Blue, new[]
        {
            ("Cost", $"${s.Cost:N2}", true),
            ("Tokens", Human(s.Tokens), true),
            ("Messages", $"{s.Messages:N0}", true),
            ("Top project", s.TopProject ?? "—", false),
        }, ct);

    public Task<bool> SendThresholdAsync(string url, DateOnly day, decimal spend, decimal threshold, CancellationToken ct) =>
        PostAsync(url, "⚠️ Daily spend threshold reached", null, Amber, new[]
        {
            ("Date", day.ToString("MMM d"), true),
            ("Spend today", $"${spend:N2}", true),
            ("Threshold", $"${threshold:N2}", true),
        }, ct);

    private async Task<bool> PostAsync(
        string url, string title, string? description, int color,
        (string Name, string Value, bool Inline)[] fields, CancellationToken ct)
    {
        if (!IsValidWebhook(url))
        {
            logger.LogWarning("Refusing to post to a non-Discord webhook URL.");
            return false;
        }

        var payload = new
        {
            username = "Usage IQ",
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

        return new Summary(
            agg.Cost, agg.Input + agg.Output + agg.Read + agg.W5 + agg.W1, agg.Messages,
            top is null ? null : $"{top.Key} (${top.Cost:N2})");
    }

    private static string Human(long n) => n switch
    {
        >= 1_000_000_000 => $"{n / 1_000_000_000.0:N1}B",
        >= 1_000_000 => $"{n / 1_000_000.0:N1}M",
        >= 1_000 => $"{n / 1_000.0:N1}K",
        _ => n.ToString(),
    };
}
